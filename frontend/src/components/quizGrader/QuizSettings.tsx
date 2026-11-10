import { Plus, Trash2 } from 'lucide-react'
import Button from '@/components/ui/Button'
import Card from '@/components/ui/Card'
import { cn } from '@/lib/utils'
import { POINT_DEFAULTS, type EditDraft, type QuizDraft, type ReviewPolicy } from '@/lib/quizGrader'

/** Versions: which intermediates' structures each version grades, and which page it prints from. */
export function VersionsGrid({ draft, edit, pages }: { draft: QuizDraft; edit: EditDraft; pages: number }) {
  const versions = Object.entries(draft.quiz.versions)
  const intermediates = Object.entries(draft.key.intermediates)
  const boxed = new Set(draft.layout.slots.filter((s) => s.box).map((s) => s.ref))
  const pageOf = (k: string, i: number) => draft.quiz.versions[k]?.page ?? i + 1

  function addVersion() {
    const used = new Set(Object.keys(draft.quiz.versions))
    const name = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').find((l) => !used.has(l)) ?? `V${used.size + 1}`
    edit((d) => {
      const n = Object.keys(d.quiz.versions).length
      d.quiz.versions[name] = { structures: [], ...(pages && n + 1 > pages ? { page: pages } : {}) }
    })
  }

  function toggle(v: string, id: string, on: boolean) {
    edit((d) => {
      const ver = d.quiz.versions[v]!
      const now = new Set(ver.structures ?? [])
      if (on) now.add(id); else now.delete(id)
      // Kept in the answer key's order, so the file reads like the pathway.
      ver.structures = Object.keys(d.key.intermediates).filter((x) => now.has(x))
    })
  }

  function removeVersion(v: string) {
    edit((d) => {
      // A version's page defaults to its position, so the ones after it would shift a
      // page. Pin them where they were, unless the new position already says the same.
      const keys = Object.keys(d.quiz.versions)
      delete d.quiz.versions[v]
      Object.entries(d.quiz.versions).forEach(([k, ver], i) => {
        if (ver.page === undefined && keys.indexOf(k) !== i) ver.page = keys.indexOf(k) + 1
      })
    })
  }

  return (
    <>
      <p className="text-sm text-muted mb-4 max-w-2xl">
        Each version is one page of the blank form. Versions share the same boxes and answer key; they differ only in which structures students are asked to draw.
        Scans are sorted into versions automatically from what is printed on them.
      </p>
      <Card className="overflow-x-auto mb-4">
        <table className="text-sm">
          <thead>
            <tr className="text-xs text-muted text-left">
              <th className="px-4 py-2 font-semibold">Version</th>
              {versions.map(([k]) => (
                <th key={k} className="px-3 py-2 text-center">
                  <div className="flex items-center justify-center gap-1.5">
                    <span className="text-base font-bold text-ink">{k}</span>
                    {versions.length > 1 && (
                      <button className="text-muted hover:text-warn" aria-label={`Remove version ${k}`} title={`Remove version ${k}`} onClick={() => removeVersion(k)}>
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                </th>
              ))}
              <th className="px-3"><Button size="sm" onClick={addVersion}><Plus size={13} />Version</Button></th>
            </tr>
            <tr className="text-xs text-muted border-t border-hairline">
              <td className="px-4 py-2">Printed from page</td>
              {versions.map(([k], i) => (
                <td key={k} className="px-3 py-1 text-center">
                  <select className={cn('border rounded-sm px-1.5 py-0.5 text-sm bg-surface', pages && pageOf(k, i) > pages ? 'border-warn text-warn' : 'border-hairline')}
                    value={pageOf(k, i)}
                    onChange={(e) => edit((d) => {
                      const n = Number(e.target.value)
                      if (n === i + 1) delete d.quiz.versions[k]!.page; else d.quiz.versions[k]!.page = n
                    })}>
                    {Array.from({ length: Math.max(pages, pageOf(k, i), versions.length) }, (_, j) => <option key={j} value={j + 1}>{j + 1}</option>)}
                  </select>
                </td>
              ))}
              <td />
            </tr>
          </thead>
          <tbody>
            <tr><td colSpan={versions.length + 2} className="px-4 pt-3 pb-1 text-xs font-semibold text-muted">Structures graded</td></tr>
            {intermediates.map(([id, it]) => {
              const hasBox = boxed.has(`intermediate.${id}`)
              return (
                <tr key={id} className="border-t border-hairline">
                  <td className="px-4 py-1.5">
                    {it.name || id}
                    {!hasBox && <span className="block text-[11px] text-muted">no box drawn</span>}
                  </td>
                  {versions.map(([k, v]) => (
                    <td key={k} className="px-3 text-center">
                      <input type="checkbox" aria-label={`Grade ${it.name} on version ${k}`} disabled={!hasBox && !(v.structures ?? []).includes(id)}
                        checked={(v.structures ?? []).includes(id)} onChange={(e) => toggle(k, id, e.target.checked)} />
                    </td>
                  ))}
                  <td />
                </tr>
              )
            })}
            {!intermediates.length && <tr><td colSpan={versions.length + 2} className="px-4 py-3 text-muted">Add intermediates in the Answer key tab first.</td></tr>}
          </tbody>
        </table>
      </Card>
      {pages > 0 && versions.some(([k], i) => pageOf(k, i) > pages) && (
        <p className="text-sm text-warn">The blank form has {pages} page{pages > 1 ? 's' : ''}; a version printed from a page past that cannot be printed.</p>
      )}
    </>
  )
}

const REVIEW_TEXT: { value: ReviewPolicy; label: string }[] = [
  { value: 'low_confidence', label: 'Only when unsure (recommended)' },
  { value: 'always', label: 'Always' },
  { value: 'never', label: 'Never' },
]

/** Points, partial credit and review rules, in words. */
export function ScoringFields({ draft, edit }: { draft: QuizDraft; edit: EditDraft }) {
  const d = draft.quiz.defaults
  const pc = d.partial_credit ?? {}
  const setPoints = (k: keyof typeof POINT_DEFAULTS, v: number) => edit((q) => { q.quiz.defaults.points[k] = v })
  const setPartial = (k: 'cofactors' | 'structure', v: boolean) => edit((q) => { q.quiz.defaults.partial_credit = { ...(q.quiz.defaults.partial_credit ?? {}), [k]: v } })

  return (
    <div className="space-y-5 max-w-2xl">
      <Card className="p-4">
        <h3 className="font-semibold text-ink mb-1">Points per box</h3>
        <p className="text-xs text-muted mb-3">Every graded box of a kind is worth the same.</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {([['enzyme', 'Enzyme'], ['name', 'Intermediate name'], ['cofactors', 'Cofactors'], ['structure', 'Structure']] as const).map(([k, label]) => (
            <label key={k} className="block">
              <span className="text-xs font-semibold text-muted">{label}</span>
              <input type="number" min={0} step={0.5} className="w-full border border-hairline rounded-sm px-2 py-1.5 text-sm bg-surface"
                value={d.points[k] ?? POINT_DEFAULTS[k]} onChange={(e) => setPoints(k, Math.max(0, Number(e.target.value)))} />
            </label>
          ))}
        </div>
      </Card>

      <Card className="p-4 space-y-4">
        <h3 className="font-semibold text-ink">Partial credit</h3>
        <Choice label="Cofactors" value={pc.cofactors ?? true} onChange={(v) => setPartial('cofactors', v)}
          off="All or nothing: every required cofactor, on the right side of the arrow"
          on="A share of the points for each required cofactor on the right side" />
        <Choice label="Structures" value={pc.structure ?? true} onChange={(v) => setPartial('structure', v)}
          off="All or nothing: every check in the answer key must hold"
          on="A share of the points for each check that holds" />
      </Card>

      <Card className="p-4 space-y-4">
        <div>
          <h3 className="font-semibold text-ink">Send to review</h3>
          <p className="text-xs text-muted">Boxes in review keep their automatic score until you decide.</p>
        </div>
        <Policy label="Written answers (enzymes, names, cofactors)" value={d.text_review ?? 'low_confidence'}
          onChange={(v) => edit((q) => { q.quiz.defaults.text_review = v })} />
        <Policy label="Drawn structures" value={d.structure_review ?? 'always'}
          onChange={(v) => edit((q) => { q.quiz.defaults.structure_review = v })} />
      </Card>
    </div>
  )
}

function Choice({ label, value, on, off, onChange }: { label: string; value: boolean; on: string; off: string; onChange: (v: boolean) => void }) {
  return (
    <fieldset>
      <legend className="text-xs font-semibold text-muted mb-1">{label}</legend>
      {[false, true].map((v) => (
        <label key={String(v)} className="flex items-start gap-2 text-sm text-ink py-0.5 cursor-pointer">
          <input type="radio" className="mt-1" checked={value === v} onChange={() => onChange(v)} />
          {v ? on : off}
        </label>
      ))}
    </fieldset>
  )
}

function Policy({ label, value, onChange }: { label: string; value: ReviewPolicy; onChange: (v: ReviewPolicy) => void }) {
  return (
    <label className="block">
      <span className="text-xs font-semibold text-muted">{label}</span>
      <select className="w-full border border-hairline rounded-sm px-2 py-1.5 text-sm bg-surface" value={value} onChange={(e) => onChange(e.target.value as ReviewPolicy)}>
        {REVIEW_TEXT.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
      </select>
    </label>
  )
}
