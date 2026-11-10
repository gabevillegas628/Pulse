import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FileUp, Plus, Square, Trash2 } from 'lucide-react'
import { api } from '@/api/client'
import Button from '@/components/ui/Button'
import Card from '@/components/ui/Card'
import { apiError } from '@/lib/errors'
import { cn } from '@/lib/utils'
import type { Box, InEnd, QuizContentDetail, RawLayout, SlotType } from '@/lib/quizGrader'
import PdfPage, { openPdf, type Pdf } from './PdfPage'

/**
 * Draw where each blank sits on a printed form.
 *
 * Boxes are fractions of the page (0–1, top-left origin) so they hold at any scan
 * resolution. Drag a box to move it, a corner to resize it; pick a slot without a box
 * and drag on the page to draw one. Arrow keys nudge the selected box (Shift: further).
 * Every version of a quiz shares one layout, so the page picker only changes the
 * picture underneath.
 */

const TYPE_LABEL: Record<SlotType, string> = {
  text: 'Enzyme name',
  cofactor_set: 'Cofactors',
  structure: 'Structure',
  identity: 'Name / NetID',
}
const TYPE_COLOUR: Record<SlotType, string> = {
  text: '#2563eb',
  cofactor_set: '#0d9488',
  structure: '#c026d3',
  identity: '#6b7280',
}
const IN_END_LABEL: Record<InEnd, string> = { top: 'Top', bottom: 'Bottom', left: 'Left', right: 'Right' }

type Drag =
  | { mode: 'move' | 'nw' | 'ne' | 'sw' | 'se'; index: number; startX: number; startY: number; orig: Box }
  | { mode: 'draw'; index: number; startX: number; startY: number }

const round = (v: number) => Math.round(v * 1000) / 1000
const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v))
const MIN = 0.01

/** Normalise a box drawn or resized in any direction, kept on the page. */
function tidy(x0: number, y0: number, x1: number, y1: number): Box {
  const l = clamp(Math.min(x0, x1)), r = clamp(Math.max(x0, x1))
  const t = clamp(Math.min(y0, y1)), b = clamp(Math.max(y0, y1))
  return [round(l), round(t), round(Math.max(MIN, r - l)), round(Math.max(MIN, b - t))]
}

const inputClass = 'w-full border border-hairline rounded-sm px-2 py-1 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-signal'

export default function LayoutEditor({ item, draft, edit }: {
  item: QuizContentDetail
  draft: RawLayout
  edit: (fn: (l: RawLayout) => void) => void
}) {
  const [pdf, setPdf] = useState<Pdf | null>(null)
  const [pdfState, setPdfState] = useState<'loading' | 'none' | 'ready' | 'error'>('loading')
  const [pageNo, setPageNo] = useState(1)
  const [aspect, setAspect] = useState(792 / 612)
  const [selected, setSelected] = useState<number | null>(null)
  const [drawing, setDrawing] = useState(false)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [uploadError, setUploadError] = useState('')
  const surface = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const loadPdf = useCallback(async () => {
    setPdfState('loading')
    try {
      const r = await api.get(`/quiz-grader/content/${item.id}/pdf`, { responseType: 'arraybuffer' })
      setPdf(await openPdf(r.data as ArrayBuffer))
      setPdfState('ready')
    } catch (e) {
      setPdfState((e as { response?: { status?: number } }).response?.status === 404 ? 'none' : 'error')
    }
  }, [item.id])
  useEffect(() => { void loadPdf() }, [loadPdf])

  async function upload(file: File) {
    setUploadError('')
    try {
      await api.put(`/quiz-grader/content/${item.id}/pdf`, file, { headers: { 'Content-Type': 'application/pdf' } })
      setPageNo(1)
      await loadPdf()
    } catch (e) {
      setUploadError(apiError(e, 'Could not upload that PDF'))
    }
  }

  const slots = draft.slots
  const sel = selected != null ? slots[selected] : undefined

  /** Pointer position as page fractions. */
  function at(e: React.PointerEvent | PointerEvent) {
    const r = surface.current!.getBoundingClientRect()
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }
  }

  function startOnPage(e: React.PointerEvent) {
    if (!drawing || selected == null) return
    const p = at(e)
    surface.current!.setPointerCapture(e.pointerId)
    setDrag({ mode: 'draw', index: selected, startX: p.x, startY: p.y })
  }

  function startOnBox(e: React.PointerEvent, index: number, mode: 'move' | 'nw' | 'ne' | 'sw' | 'se') {
    e.stopPropagation()
    const box = slots[index]?.box
    if (!box) return
    setSelected(index)
    setDrawing(false)
    const p = at(e)
    surface.current!.setPointerCapture(e.pointerId)
    setDrag({ mode, index, startX: p.x, startY: p.y, orig: box })
  }

  function onMove(e: React.PointerEvent) {
    if (!drag) return
    const p = at(e)
    edit((l) => {
      const s = l.slots[drag.index]!
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

  // Arrow keys nudge the selected box, unless the user is typing in a field.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (selected == null || !slots[selected]?.box) return
      if ((e.target as HTMLElement).closest('input, select, textarea')) return
      const step = e.shiftKey ? 0.01 : 0.002
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key]
      if (!d) return
      e.preventDefault()
      edit((l) => {
        const [x, y, w, h] = l.slots[selected]!.box!
        l.slots[selected]!.box = [round(clamp(x + d[0]!, 0, 1 - w)), round(clamp(y + d[1]!, 0, 1 - h)), w, h]
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, slots, edit])

  const missing = useMemo(() => slots.filter((s) => !s.box).length, [slots])
  const pages = pdf?.numPages ?? 0

  function addSlot() {
    const n = slots.length + 1
    edit((l) => { l.slots.push({ id: `slot_${n}`, type: 'text', ref: '', box: null }) })
    setSelected(slots.length)
    setDrawing(true)
  }

  return (
    <div className="grid lg:grid-cols-[minmax(0,1fr)_320px] gap-5 items-start">
      <div>
        <div className="flex flex-wrap items-center gap-2 mb-2 min-h-8">
          {pages > 1 && (
            <div className="flex items-center gap-1 text-xs text-muted">
              Page
              {Array.from({ length: pages }, (_, i) => (
                <button key={i} onClick={() => setPageNo(i + 1)}
                  className={cn('px-2 py-0.5 rounded-sm border', pageNo === i + 1 ? 'border-signal text-ink font-semibold' : 'border-hairline')}>
                  {i + 1}
                </button>
              ))}
              <span className="ml-1">(one per version; boxes are shared)</span>
            </div>
          )}
          <div className="flex-1" />
          <Button size="sm" onClick={() => fileInput.current?.click()}>
            <FileUp size={13} />{pdfState === 'none' ? 'Upload blank PDF' : 'Replace PDF'}
          </Button>
          <input ref={fileInput} type="file" accept="application/pdf,.pdf" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void upload(f) }} />
        </div>
        {uploadError && <p className="text-sm text-warn mb-2">{uploadError}</p>}

        <Card flat className="overflow-hidden">
          {pdfState === 'none' ? (
            <p className="text-sm text-muted p-8 text-center">Upload the blank quiz as a PDF (one page per version) to draw on it.</p>
          ) : pdfState === 'error' ? (
            <p className="text-sm text-warn p-8 text-center">Could not load this layout&rsquo;s PDF.</p>
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
              {pdf && <div className="absolute inset-0"><PdfPage pdf={pdf} page={pageNo} onAspect={setAspect} /></div>}
              {slots.map((s, i) => s.box && (
                <div
                  key={i}
                  onPointerDown={(e) => startOnBox(e, i, 'move')}
                  className="absolute cursor-move"
                  style={{
                    left: `${s.box[0] * 100}%`, top: `${s.box[1] * 100}%`, width: `${s.box[2] * 100}%`, height: `${s.box[3] * 100}%`,
                    border: `2px solid ${TYPE_COLOUR[s.type] ?? '#888'}`,
                    background: i === selected ? `${TYPE_COLOUR[s.type]}22` : 'transparent',
                    zIndex: i === selected ? 2 : 1,
                  }}
                  title={`${s.id} — ${s.ref}`}
                >
                  <span className="absolute left-0 top-0 text-[10px] leading-none px-1 py-0.5 text-white pointer-events-none whitespace-nowrap"
                    style={{ background: TYPE_COLOUR[s.type] ?? '#888' }}>
                    {s.id}
                  </span>
                  {i === selected && (['nw', 'ne', 'sw', 'se'] as const).map((c) => (
                    <span
                      key={c}
                      onPointerDown={(e) => startOnBox(e, i, c)}
                      className="absolute w-3 h-3 bg-white border-2 rounded-sm"
                      style={{
                        borderColor: TYPE_COLOUR[s.type],
                        left: c.endsWith('w') ? -7 : undefined, right: c.endsWith('e') ? -7 : undefined,
                        top: c.startsWith('n') ? -7 : undefined, bottom: c.startsWith('s') ? -7 : undefined,
                        cursor: c === 'nw' || c === 'se' ? 'nwse-resize' : 'nesw-resize',
                      }}
                    />
                  ))}
                </div>
              ))}
            </div>
          )}
        </Card>
        <p className="text-xs text-muted mt-2">
          Drag a box to move it, a corner to resize. Arrow keys nudge the selected box (Shift for bigger steps).
          Make boxes generous: a box that includes a neighbour&rsquo;s writing costs nothing, one that cuts an answer off costs a wrong grade.
        </p>
      </div>

      <div className="space-y-4 lg:sticky lg:top-4">
        {sel && selected != null ? (
          <Card className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-ink">{sel.id}</h3>
              <button className="text-muted hover:text-warn" aria-label="Delete this slot"
                onClick={() => { edit((l) => { l.slots.splice(selected, 1) }); setSelected(null) }}>
                <Trash2 size={14} />
              </button>
            </div>
            <Labelled label="Slot id">
              <input className={inputClass} value={sel.id} onChange={(e) => edit((l) => { l.slots[selected]!.id = e.target.value })} />
            </Labelled>
            <Labelled label="Kind">
              <select className={inputClass} value={sel.type} onChange={(e) => edit((l) => {
                const s = l.slots[selected]!
                s.type = e.target.value as SlotType
                if (s.type === 'cofactor_set' && s.in_end === undefined) s.in_end = null
                if (s.type !== 'cofactor_set') delete s.in_end
              })}>
                {(Object.keys(TYPE_LABEL) as SlotType[]).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
              </select>
            </Labelled>
            <Labelled label="Grades" hint="step.6.enzyme, step.6.cofactors, intermediate.pep, student.name">
              <input className={`${inputClass} font-mono text-xs`} value={sel.ref} onChange={(e) => edit((l) => { l.slots[selected]!.ref = e.target.value })} />
            </Labelled>
            {sel.type === 'cofactor_set' && (
              <Labelled label="Curved arrow starts at" hint="The tail end: items written there go in; the arrowhead end comes out.">
                <select className={inputClass} value={sel.in_end ?? ''} onChange={(e) => edit((l) => { l.slots[selected]!.in_end = (e.target.value || null) as InEnd | null })}>
                  <option value="">Not set</option>
                  {(Object.keys(IN_END_LABEL) as InEnd[]).map((k) => <option key={k} value={k}>{IN_END_LABEL[k]}</option>)}
                </select>
              </Labelled>
            )}
            {sel.box ? (
              <div className="grid grid-cols-4 gap-1.5">
                {(['x', 'y', 'w', 'h'] as const).map((k, j) => (
                  <Labelled key={k} label={k}>
                    <input type="number" step={0.005} min={0} max={1} className={`${inputClass} px-1.5 text-xs`} value={sel.box![j]}
                      onChange={(e) => edit((l) => { const b = [...l.slots[selected]!.box!] as Box; b[j] = round(clamp(Number(e.target.value))); l.slots[selected]!.box = b })} />
                  </Labelled>
                ))}
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant={drawing ? 'primary' : 'ghost'} onClick={() => setDrawing((d) => !d)} disabled={pdfState !== 'ready'}>
                <Square size={13} />{drawing ? 'Drag on the page…' : sel.box ? 'Redraw box' : 'Draw box'}
              </Button>
              {sel.box && <Button size="sm" onClick={() => edit((l) => { l.slots[selected]!.box = null })}>Clear box</Button>}
            </div>
          </Card>
        ) : (
          <Card flat className="p-4 text-sm text-muted">Select a slot, on the page or in the list, to edit it.</Card>
        )}

        <Card className="p-2 max-h-[60vh] overflow-y-auto">
          <div className="flex items-center justify-between px-2 py-1">
            <p className="text-xs font-semibold text-muted">
              {slots.length} slots{missing ? ` · ${missing} without a box` : ''}
            </p>
            <button className="text-xs text-signal hover:underline inline-flex items-center gap-1" onClick={addSlot}>
              <Plus size={12} /> Add slot
            </button>
          </div>
          {slots.map((s, i) => (
            <button key={i} onClick={() => { setSelected(i); setDrawing(!s.box) }}
              className={cn('w-full text-left px-2 py-1.5 rounded-sm flex items-center gap-2 text-sm', i === selected ? 'bg-surface-2' : 'hover:bg-surface-2')}>
              <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: TYPE_COLOUR[s.type] ?? '#888' }} />
              <span className="font-mono text-xs text-ink truncate">{s.id}</span>
              <span className="text-xs text-muted truncate flex-1">{TYPE_LABEL[s.type] ?? s.type}</span>
              {!s.box && <span className="text-[10px] text-warn shrink-0">no box</span>}
              {s.type === 'cofactor_set' && s.box && !s.in_end && <span className="text-[10px] text-warn shrink-0">no arrow end</span>}
            </button>
          ))}
        </Card>
      </div>
    </div>
  )
}

function Labelled({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs font-semibold text-muted">{label}</span>
      {hint && <span className="block text-[11px] text-muted">{hint}</span>}
      {children}
    </label>
  )
}
