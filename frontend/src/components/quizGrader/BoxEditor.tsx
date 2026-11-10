import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Copy, FileUp, Square, Trash2 } from 'lucide-react'
import { api } from '@/api/client'
import Button from '@/components/ui/Button'
import Card from '@/components/ui/Card'
import { apiError } from '@/lib/errors'
import { cn } from '@/lib/utils'
import {
  KIND_COLOUR, gradableItems, isGraded, pointsFor, setGraded,
  type Box, type EditDraft, type GradableItem, type InEnd, type QuizDraft, type RawSlot,
} from '@/lib/quizGrader'
import PdfPage, { openPdf, type Pdf } from './PdfPage'

/**
 * Draw where each answer goes on the blank form, picking from the answer key's list.
 *
 * Boxes are fractions of the page (0–1, top-left origin) so they hold at any scan
 * resolution. Drag a box to move it, a corner to resize it. Arrow keys nudge the
 * selected box (Shift: further). Every version shares the boxes; the page picker only
 * changes the picture underneath.
 */

const IN_END_LABEL: Record<InEnd, string> = { top: 'Top', bottom: 'Bottom', left: 'Left', right: 'Right' }

type Drag =
  | { mode: 'move' | 'nw' | 'ne' | 'sw' | 'se'; index: number; startX: number; startY: number; orig: Box }
  | { mode: 'draw'; index: number; startX: number; startY: number }

const round = (v: number) => Math.round(v * 1000) / 1000
const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v))
const MIN = 0.01

function tidy(x0: number, y0: number, x1: number, y1: number): Box {
  const l = clamp(Math.min(x0, x1)), r = clamp(Math.max(x0, x1))
  const t = clamp(Math.min(y0, y1)), b = clamp(Math.max(y0, y1))
  return [round(l), round(t), round(Math.max(MIN, r - l)), round(Math.max(MIN, b - t))]
}

const overlaps = (a: Box, b: Box) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3]

/** The blank form's PDF, shared by the Boxes and Versions tabs. */
export function useBlankForm(layoutId: string | undefined, hasPdf: boolean) {
  const [pdf, setPdf] = useState<Pdf | null>(null)
  const [state, setState] = useState<'loading' | 'none' | 'ready' | 'error'>('loading')
  const load = useCallback(async () => {
    if (!layoutId || !hasPdf) { setState('none'); return }
    setState('loading')
    try {
      const r = await api.get(`/quiz-grader/content/${layoutId}/pdf`, { responseType: 'arraybuffer' })
      setPdf(await openPdf(r.data as ArrayBuffer))
      setState('ready')
    } catch (e) {
      setState((e as { response?: { status?: number } }).response?.status === 404 ? 'none' : 'error')
    }
  }, [layoutId, hasPdf])
  useEffect(() => { void load() }, [load])
  const upload = useCallback(async (file: File) => {
    await api.put(`/quiz-grader/content/${layoutId}/pdf`, file, { headers: { 'Content-Type': 'application/pdf' } })
    setState('loading')
    const r = await api.get(`/quiz-grader/content/${layoutId}/pdf`, { responseType: 'arraybuffer' })
    setPdf(await openPdf(r.data as ArrayBuffer))
    setState('ready')
  }, [layoutId])
  return { pdf, state, upload, pages: pdf?.numPages ?? 0 }
}
export type BlankForm = ReturnType<typeof useBlankForm>

export default function BoxEditor({ draft, edit, form }: { draft: QuizDraft; edit: EditDraft; form: BlankForm }) {
  const [pageNo, setPageNo] = useState(1)
  const [aspect, setAspect] = useState(792 / 612)
  const [selected, setSelected] = useState<string | null>(null) // an item ref, or `slot:<id>` for an unlisted box
  const [drawing, setDrawing] = useState(false)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [uploadError, setUploadError] = useState('')
  const surface = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const items = useMemo(() => gradableItems(draft.key), [draft.key])
  const slots = draft.layout.slots
  const itemOf = useMemo(() => new Map(items.map((it) => [it.ref, it])), [items])
  const slotIndex = (ref: string) => (ref.startsWith('slot:') ? slots.findIndex((s) => s.id === ref.slice(5)) : slots.findIndex((s) => s.ref === ref))
  const selIndex = selected ? slotIndex(selected) : -1
  const selItem = selected ? itemOf.get(selected) : undefined
  const selSlot = selIndex >= 0 ? slots[selIndex] : undefined
  const orphans = slots.filter((s, i) => !itemOf.has(s.ref) || slots.findIndex((x) => x.ref === s.ref) !== i)

  /** Where a new box for `item` goes, so the file keeps the answer key's order. */
  function insertAt(item: GradableItem): number {
    const order = items.indexOf(item)
    const after = slots.findIndex((s) => { const it = itemOf.get(s.ref); return it ? items.indexOf(it) > order : false })
    return after < 0 ? slots.length : after
  }

  function newSlot(d: QuizDraft, item: GradableItem, box: Box | null): number {
    const at = insertAt(item)
    const ids = new Set(d.layout.slots.map((s) => s.id))
    let id = item.slotId
    for (let n = 2; ids.has(id); n++) id = `${item.slotId}_${n}`
    const slot: RawSlot = { id, type: item.slotType, ref: item.ref, ...(item.kind === 'cofactors' ? { in_end: null } : {}), box }
    d.layout.slots.splice(at, 0, slot)
    // Drawing a box is how an item becomes graded.
    if (item.kind === 'enzyme' || item.kind === 'cofactors' || item.kind === 'name') setGraded(d.quiz, d.key, item, true)
    return at
  }

  function at(e: React.PointerEvent | PointerEvent) {
    const r = surface.current!.getBoundingClientRect()
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }
  }

  function startOnPage(e: React.PointerEvent) {
    if (!drawing || !selected) return
    const p = at(e)
    surface.current!.setPointerCapture(e.pointerId)
    let index = selIndex
    if (index < 0) {
      if (!selItem) return
      index = insertAt(selItem)
      edit((d) => { newSlot(d, selItem, [round(p.x), round(p.y), MIN, MIN]) })
    }
    setDrag({ mode: 'draw', index, startX: p.x, startY: p.y })
  }

  function startOnBox(e: React.PointerEvent, index: number, mode: 'move' | 'nw' | 'ne' | 'sw' | 'se') {
    // While drawing, a press on an existing box starts the new one: boxes may overlap.
    if (drawing) return
    e.stopPropagation()
    const s = slots[index]
    if (!s?.box) return
    setSelected(itemOf.has(s.ref) && slots.findIndex((x) => x.ref === s.ref) === index ? s.ref : `slot:${s.id}`)
    setDrawing(false)
    const p = at(e)
    surface.current!.setPointerCapture(e.pointerId)
    setDrag({ mode, index, startX: p.x, startY: p.y, orig: s.box })
  }

  function onMove(e: React.PointerEvent) {
    if (!drag) return
    const p = at(e)
    edit((d) => {
      const s = d.layout.slots[drag.index]
      if (!s) return
      if (drag.mode === 'draw') { s.box = tidy(drag.startX, drag.startY, p.x, p.y); return }
      const [x, y, w, h] = drag.orig
      const dx = p.x - drag.startX, dy = p.y - drag.startY
      if (drag.mode === 'move') s.box = [round(clamp(x + dx, 0, 1 - w)), round(clamp(y + dy, 0, 1 - h)), w, h]
      else {
        const left = drag.mode === 'nw' || drag.mode === 'sw' ? x + dx : x
        const right = drag.mode === 'ne' || drag.mode === 'se' ? x + w + dx : x + w
        const top = drag.mode === 'nw' || drag.mode === 'ne' ? y + dy : y
        const bottom = drag.mode === 'sw' || drag.mode === 'se' ? y + h + dy : y + h
        s.box = tidy(left, top, right, bottom)
      }
    })
  }

  function onUp() {
    if (drag?.mode === 'draw') setDrawing(false)
    setDrag(null)
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (selIndex < 0 || !slots[selIndex]?.box) return
      if ((e.target as HTMLElement).closest('input, select, textarea')) return
      const step = e.shiftKey ? 0.01 : 0.002
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key]
      if (!d) return
      e.preventDefault()
      edit((q) => {
        const s = q.layout.slots[selIndex]!
        const [x, y, w, h] = s.box!
        s.box = [round(clamp(x + d[0]!, 0, 1 - w)), round(clamp(y + d[1]!, 0, 1 - h)), w, h]
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selIndex, slots, edit])

  function pick(ref: string) {
    setSelected(ref)
    const i = slotIndex(ref)
    setDrawing(i < 0 || !slots[i]?.box)
  }

  function removeBox(index: number) {
    edit((d) => { d.layout.slots.splice(index, 1) })
    setDrawing(false)
  }

  /**
   * A cofactor box from its enzyme's, a name box from its structure's: on most forms they
   * are written in the same place, and the model reads each out of the same crop.
   */
  const partnerRef = (item: GradableItem) =>
    item.kind === 'cofactors' ? `step.${item.stepNo}.enzyme` : item.kind === 'name' ? `intermediate.${item.intermediate}` : null
  function copyPartnerBox(item: GradableItem) {
    const enzyme = slots.find((s) => s.ref === partnerRef(item))
    if (!enzyme?.box) return
    edit((d) => {
      const i = d.layout.slots.findIndex((s) => s.ref === item.ref)
      if (i >= 0) d.layout.slots[i]!.box = [...enzyme.box!] as Box
      else newSlot(d, item, [...enzyme.box!] as Box)
    })
    setDrawing(false)
  }

  // Answer boxes that touch a name or NetID box: the server refuses to grade them,
  // since their crops would carry the student's identity to the model.
  const identityBoxes = slots.filter((s) => s.type === 'identity' && s.box).map((s) => s.box!)
  const clashes = new Set(slots.filter((s) => s.type !== 'identity' && s.box && identityBoxes.some((b) => overlaps(b, s.box!))).map((s) => s.id))

  // Boxes drawn in the same place (an enzyme and its cofactors) get one label between them.
  const sharedLabel = new Map<number, string>()
  {
    const firstAt = new Map<string, number>()
    slots.forEach((s, i) => {
      if (!s.box) return
      const it = itemOf.get(s.ref)
      const label = it ? shortLabel(it) : s.id
      const k = s.box.join(',')
      const j = firstAt.get(k)
      if (j === undefined) { firstAt.set(k, i); sharedLabel.set(i, label) }
      else {
        // "1 enzyme + cofactors", "Glucose 6-phosphate + written name"
        const prev = itemOf.get(slots[j]!.ref)
        const same = it && prev && ((it.stepNo && it.stepNo === prev.stepNo) || (it.intermediate && it.intermediate === prev.intermediate))
        sharedLabel.set(j, `${sharedLabel.get(j)} + ${same ? it.label.toLowerCase() : label}`)
      }
    })
  }

  const versions = Object.entries(draft.quiz.versions)
  const pageLabel = (n: number) => versions.filter(([k, v]) => (v.page ?? versions.findIndex(([x]) => x === k) + 1) === n).map(([k]) => k).join(', ')

  const groups = useMemo(() => {
    const out: { group: string; items: GradableItem[] }[] = []
    for (const it of items) {
      const last = out[out.length - 1]
      if (last && last.group === it.group) last.items.push(it); else out.push({ group: it.group, items: [it] })
    }
    return out
  }, [items])
  const boxed = items.filter((it) => slots.some((s) => s.ref === it.ref && s.box)).length

  async function upload(file: File) {
    setUploadError('')
    try {
      await form.upload(file)
      setPageNo(1)
    } catch (e) {
      setUploadError(apiError(e, 'Could not upload that PDF'))
    }
  }

  return (
    <div className="grid lg:grid-cols-[minmax(0,1fr)_340px] gap-5 items-start">
      <div>
        <div className="flex flex-wrap items-center gap-2 mb-2 min-h-8">
          {form.pages > 1 && (
            <div className="flex flex-wrap items-center gap-1 text-xs text-muted">
              Page
              {Array.from({ length: form.pages }, (_, i) => (
                <button key={i} onClick={() => setPageNo(i + 1)}
                  className={cn('px-2 py-0.5 rounded-sm border', pageNo === i + 1 ? 'border-signal text-ink font-semibold' : 'border-hairline')}>
                  {i + 1}{pageLabel(i + 1) ? ` · ${pageLabel(i + 1)}` : ''}
                </button>
              ))}
              <span className="ml-1">(every version shares these boxes)</span>
            </div>
          )}
          <div className="flex-1" />
          <Button size="sm" onClick={() => fileInput.current?.click()}>
            <FileUp size={13} />{form.state === 'none' ? 'Upload blank form (PDF)' : 'Replace blank form'}
          </Button>
          <input ref={fileInput} type="file" accept="application/pdf,.pdf" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void upload(f) }} />
        </div>
        {uploadError && <p className="text-sm text-warn mb-2">{uploadError}</p>}

        <Card flat className="overflow-hidden">
          {form.state === 'none' ? (
            <p className="text-sm text-muted p-8 text-center">Upload the blank quiz as a PDF, one page per version, to draw on it.</p>
          ) : form.state === 'error' ? (
            <p className="text-sm text-warn p-8 text-center">Could not load the blank form.</p>
          ) : (
            <div
              ref={surface}
              className={cn('relative select-none touch-none', drawing && 'cursor-crosshair')}
              style={{ aspectRatio: `1 / ${aspect}` }}
              onPointerDown={startOnPage}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onUp}
            >
              {form.pdf && <div className="absolute inset-0"><PdfPage pdf={form.pdf} page={Math.min(pageNo, form.pages || 1)} onAspect={setAspect} /></div>}
              {slots.map((s, i) => {
                if (!s.box) return null
                const it = itemOf.get(s.ref)
                const colour = clashes.has(s.id) ? '#dc2626' : it ? KIND_COLOUR[it.kind] : '#888'
                const isSel = i === selIndex
                return (
                  <div key={i} onPointerDown={(e) => startOnBox(e, i, 'move')} className="absolute cursor-move"
                    style={{
                      left: `${s.box[0] * 100}%`, top: `${s.box[1] * 100}%`, width: `${s.box[2] * 100}%`, height: `${s.box[3] * 100}%`,
                      border: `2px ${it ? 'solid' : 'dashed'} ${colour}`,
                      background: isSel ? `${colour}22` : 'transparent',
                      zIndex: isSel ? 2 : 1,
                    }}
                    title={it ? `${it.group}: ${it.label}` : s.id}
                  >
                    {sharedLabel.has(i) && (
                      <span className="absolute left-0 top-0 text-[10px] leading-none px-1 py-0.5 text-white pointer-events-none whitespace-nowrap max-w-full overflow-hidden"
                        style={{ background: colour }}>
                        {sharedLabel.get(i)}
                      </span>
                    )}
                    {isSel && (['nw', 'ne', 'sw', 'se'] as const).map((c) => (
                      <span key={c} onPointerDown={(e) => startOnBox(e, i, c)} className="absolute w-3 h-3 bg-white border-2 rounded-sm"
                        style={{
                          borderColor: colour,
                          left: c.endsWith('w') ? -7 : undefined, right: c.endsWith('e') ? -7 : undefined,
                          top: c.startsWith('n') ? -7 : undefined, bottom: c.startsWith('s') ? -7 : undefined,
                          cursor: c === 'nw' || c === 'se' ? 'nwse-resize' : 'nesw-resize',
                        }} />
                    ))}
                  </div>
                )
              })}
            </div>
          )}
        </Card>
        <p className="text-xs text-muted mt-2">
          Pick an item in the list, then drag on the page. Drag a box to move it, a corner to resize; arrow keys nudge.
          Make boxes generous: including a neighbour&rsquo;s writing costs nothing, cutting an answer off costs a wrong grade.
        </p>
        {clashes.size > 0 && (
          <p className="text-sm text-warn mt-2">
            Boxes in red touch the student name or NetID box. Those papers will not grade until they are moved apart: a name must never be sent to the model.
          </p>
        )}
      </div>

      <div className="space-y-4 lg:sticky lg:top-4">
        {selected && (selItem || selSlot) ? (
          <Card className="p-4 space-y-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-xs text-muted">{selItem?.group ?? 'Not in the answer key'}</p>
                <h3 className="font-semibold text-ink">{selItem?.label ?? selSlot?.id}</h3>
              </div>
              {selSlot && (
                <button className="text-muted hover:text-warn" aria-label="Remove this box" title="Remove this box"
                  onClick={() => { removeBox(selIndex); if (!selItem) setSelected(null) }}>
                  <Trash2 size={14} />
                </button>
              )}
            </div>
            {!selItem && selSlot && (
              <p className="text-xs text-muted">This box points at <span className="font-mono">{selSlot.ref || '(nothing)'}</span>, which is not in the answer key, so it is never graded. Remove it, or fix the key.</p>
            )}
            {selItem && <ItemHelp item={selItem} draft={draft} />}
            {selItem && slots.some((s) => s.ref === partnerRef(selItem) && s.box) && (
              <Button size="sm" onClick={() => copyPartnerBox(selItem)}>
                <Copy size={13} />Use the {selItem.kind === 'cofactors' ? 'enzyme' : 'structure'}&rsquo;s box
              </Button>
            )}
            {selItem?.kind === 'cofactors' && (
              <>
                {selSlot && (
                  <label className="block">
                    <span className="text-xs font-semibold text-muted">The curved arrow&rsquo;s tail is at the</span>
                    <span className="block text-[11px] text-muted">Cofactors written at the tail go in; at the arrowhead, come out.</span>
                    <select className="w-full border border-hairline rounded-sm px-2 py-1 text-sm bg-surface" value={selSlot.in_end ?? ''}
                      onChange={(e) => edit((d) => { d.layout.slots[selIndex]!.in_end = (e.target.value || null) as InEnd | null })}>
                      <option value="">Not set</option>
                      {(Object.keys(IN_END_LABEL) as InEnd[]).map((k) => <option key={k} value={k}>{IN_END_LABEL[k]}</option>)}
                    </select>
                  </label>
                )}
              </>
            )}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant={drawing ? 'primary' : 'ghost'} onClick={() => setDrawing((d) => !d)} disabled={form.state !== 'ready'}>
                <Square size={13} />{drawing ? 'Drag on the page…' : selSlot?.box ? 'Redraw box' : 'Draw box'}
              </Button>
            </div>
          </Card>
        ) : (
          <Card flat className="p-4 text-sm text-muted">Pick an item to draw or adjust its box.</Card>
        )}

        <Card className="p-2 max-h-[70vh] overflow-y-auto">
          <p className="text-xs font-semibold text-muted px-2 py-1">{boxed} of {items.length} have boxes</p>
          {groups.map(({ group, items: its }) => (
            <div key={group} className="mb-1">
              <p className="text-[11px] text-muted px-2 pt-2 truncate" title={group}>{group}</p>
              {its.map((it) => {
                const i = slots.findIndex((s) => s.ref === it.ref)
                const has = i >= 0 && !!slots[i]!.box
                const graded = isGraded(draft.quiz, it)
                return (
                  <div key={it.ref} className={cn('flex items-center gap-2 px-2 py-1 rounded-sm text-sm', selected === it.ref ? 'bg-surface-2' : 'hover:bg-surface-2')}>
                    <button className="flex-1 min-w-0 flex items-center gap-2 text-left" onClick={() => pick(it.ref)}>
                      <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: has ? KIND_COLOUR[it.kind] : 'transparent', border: `1.5px solid ${KIND_COLOUR[it.kind]}` }} />
                      <span className="truncate text-ink">{it.label}</span>
                      {!has && <span className="text-[10px] text-muted shrink-0">no box</span>}
                      {has && it.kind === 'cofactors' && !slots[i]!.in_end && <span className="text-[10px] text-warn shrink-0">arrow?</span>}
                      {has && clashes.has(slots[i]!.id) && <span className="text-[10px] text-warn shrink-0">touches name</span>}
                    </button>
                    {it.kind === 'identity' ? null : it.kind === 'structure' ? (
                      has && <span className="text-[10px] text-muted shrink-0" title="Which versions grade this structure: set in the Versions tab">
                        {(graded as string[]).length ? `version ${(graded as string[]).join(', ')}` : 'not graded'}
                      </span>
                    ) : has && (
                      <label className="flex items-center gap-1 text-[11px] text-muted shrink-0 cursor-pointer" title="Graded on every paper">
                        <input type="checkbox" checked={graded === true}
                          onChange={(e) => edit((d) => setGraded(d.quiz, d.key, it, e.target.checked))} />
                        {graded ? `${pointsFor(draft.quiz, it.kind)} pt` : 'graded'}
                      </label>
                    )}
                  </div>
                )
              })}
            </div>
          ))}
          {orphans.length > 0 && (
            <div className="mb-1">
              <p className="text-[11px] text-warn px-2 pt-2">Not in the answer key</p>
              {orphans.map((s) => (
                <button key={s.id} onClick={() => setSelected(`slot:${s.id}`)}
                  className={cn('w-full text-left px-2 py-1 rounded-sm text-sm font-mono text-xs', selected === `slot:${s.id}` ? 'bg-surface-2' : 'hover:bg-surface-2')}>
                  {s.id} <span className="text-muted">{s.ref || '(nothing)'}</span>
                </button>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}

function shortLabel(it: GradableItem): string {
  if (it.kind === 'identity') return it.label
  if (it.stepNo) return `${it.stepNo} ${it.label.toLowerCase()}`
  return `${it.group}${it.kind === 'name' ? ' name' : ''}`
}

/** What happens to this item's box, in a sentence. */
function ItemHelp({ item, draft }: { item: GradableItem; draft: QuizDraft }) {
  const graded = isGraded(draft.quiz, item)
  let text: string
  if (item.kind === 'identity') text = 'Cut out for you to match papers to students. Never sent to the model, and never scored.'
  else if (item.kind === 'structure') {
    const v = graded as string[]
    text = v.length
      ? `Graded on version${v.length > 1 ? 's' : ''} ${v.join(', ')}, ${pointsFor(draft.quiz, 'structure')} pt. Change which versions in the Versions tab.`
      : 'Not graded on any version yet. Tick it in the Versions tab to grade it.'
  } else {
    text = graded
      ? `Graded on every paper, ${pointsFor(draft.quiz, item.kind)} pt. Untick it in the list to stop grading it but keep the box.`
      : 'Has a box but is not graded. Tick it in the list to grade it.'
    if (item.kind === 'cofactors') text += ' Can share the enzyme’s box: the model reads the name and the arrow ends separately.'
  }
  return <p className="text-xs text-muted">{text}</p>
}
