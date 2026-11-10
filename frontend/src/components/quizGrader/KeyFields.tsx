import { useState } from 'react'
import { Plus, Trash2, X } from 'lucide-react'
import Button from '@/components/ui/Button'
import Card from '@/components/ui/Card'
import ChipList from './ChipList'
import { byStepNo, idFromName, type EditDraft, type QuizDraft, type RawIntermediate, type RawStep } from '@/lib/quizGrader'

/**
 * The answer key: the pathway's intermediates and steps, with every accepted answer.
 * Removing a step or intermediate also removes its boxes and its place in the versions,
 * so nothing is left pointing at it.
 */

const inputClass = 'w-full border border-hairline rounded-sm px-2.5 py-1.5 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-signal'

export default function KeyFields({ draft, edit }: { draft: QuizDraft; edit: EditDraft }) {
  const key = draft.key
  const name = (id: string) => key.intermediates[id]?.name || id
  const steps = Object.entries(key.steps).sort(byStepNo)
  const ids = Object.keys(key.intermediates)
  const [newName, setNewName] = useState('')

  function addIntermediate() {
    const n = newName.trim()
    if (!n) return
    edit((d) => { d.key.intermediates[idFromName(n, Object.keys(d.key.intermediates))] = { name: n, accept: [n], features: [] } })
    setNewName('')
  }

  function removeIntermediate(id: string) {
    edit((d) => {
      delete d.key.intermediates[id]
      d.layout.slots = d.layout.slots.filter((s) => s.ref !== `intermediate.${id}` && s.ref !== `intermediate.${id}.name`)
      for (const v of Object.values(d.quiz.versions)) if (v.structures) v.structures = v.structures.filter((x) => x !== id)
      const names = d.quiz.grade?.names
      if (Array.isArray(names)) d.quiz.grade!.names = names.filter((x) => x !== id)
    })
  }

  function addStep() {
    const next = String(Math.max(0, ...Object.keys(key.steps).map(Number)) + 1)
    const last = steps[steps.length - 1]?.[1]
    edit((d) => { d.key.steps[next] = { from: last ? [...last.to] : [], to: [], enzyme: { accept: [] } } })
  }

  function removeStep(no: string) {
    edit((d) => {
      delete d.key.steps[no]
      d.layout.slots = d.layout.slots.filter((s) => s.ref !== `step.${no}.enzyme` && s.ref !== `step.${no}.cofactors`)
      const g = d.quiz.grade
      for (const f of ['enzymes', 'cofactors'] as const) {
        const sel = g?.[f]
        if (Array.isArray(sel)) g![f] = sel.filter((n) => n !== Number(no))
      }
    })
  }

  const usedBy = (id: string) => steps.filter(([, s]) => s.from.includes(id) || s.to.includes(id)).map(([no]) => no)

  return (
    <>
      <Card className="p-4 mb-8">
        <label className="text-xs font-semibold text-muted">Pathway title</label>
        <input className={inputClass} value={key.title} onChange={(e) => edit((d) => { d.key.title = e.target.value })} />
      </Card>

      <h2 className="text-lg font-semibold text-ink mb-1">Intermediates</h2>
      <p className="text-xs text-muted mb-3">
        The molecules of the pathway. Add these first; steps go from one to the next. Accepted names are what a student may write; the checks are yes/no questions the model answers about a drawn structure, so phrase them to hold for any drawing style.
      </p>
      <div className="space-y-3 mb-3">
        {ids.map((id) => (
          <IntermediateCard key={id} it={key.intermediates[id]!} usedIn={usedBy(id)}
            onChange={(fn) => edit((d) => fn(d.key.intermediates[id]!))} onRemove={() => removeIntermediate(id)} />
        ))}
      </div>
      <Card flat className="p-3 mb-10 flex flex-wrap gap-2 items-center">
        <input className={`${inputClass} flex-1 min-w-48`} placeholder="New intermediate, e.g. Glucose 6-phosphate" value={newName}
          onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addIntermediate() }} />
        <Button size="sm" onClick={addIntermediate} disabled={!newName.trim()}><Plus size={13} />Add intermediate</Button>
      </Card>

      <h2 className="text-lg font-semibold text-ink mb-1">Steps</h2>
      <p className="text-xs text-muted mb-3">
        Names match regardless of case, spaces, hyphens and Greek letters; small misspellings go to review. The first enzyme name is the one the model is told to expect.
      </p>
      <div className="space-y-3 mb-3">
        {steps.map(([no, step]) => (
          <StepCard key={no} no={no} step={step} ids={ids} name={name}
            onChange={(fn) => edit((d) => fn(d.key.steps[no]!))} onRemove={() => removeStep(no)} />
        ))}
      </div>
      <Button size="sm" onClick={addStep} disabled={!ids.length} title={ids.length ? undefined : 'Add intermediates first'}>
        <Plus size={13} />Add step {Object.keys(key.steps).length + 1}
      </Button>
    </>
  )
}

/** Pick one or more intermediates, in order. */
function IdPicker({ value, ids, name, onChange }: { value: string[]; ids: string[]; name: (id: string) => string; onChange: (v: string[]) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {value.map((id, i) => (
        <span key={i} className="inline-flex items-center gap-1 text-sm bg-surface-2 border border-hairline rounded-sm px-2 py-0.5">
          {name(id)}
          <button aria-label={`Remove ${name(id)}`} className="text-muted hover:text-warn" onClick={() => onChange(value.filter((_, j) => j !== i))}><X size={12} /></button>
        </span>
      ))}
      <select className="border border-hairline rounded-sm px-1.5 py-0.5 text-sm bg-surface" value=""
        onChange={(e) => { if (e.target.value) onChange([...value, e.target.value]) }}>
        <option value="">{value.length ? '+ another' : 'Choose…'}</option>
        {ids.filter((id) => !value.includes(id)).map((id) => <option key={id} value={id}>{name(id)}</option>)}
      </select>
    </div>
  )
}
function StepCard({ no, step, ids, name, onChange, onRemove }: {
  no: string
  step: RawStep
  ids: string[]
  name: (id: string) => string
  onChange: (fn: (s: RawStep) => void) => void
  onRemove: () => void
}) {
  const c = step.cofactors
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
        <h3 className="font-semibold text-ink">
          Step {no}
          <span className="font-normal text-muted text-sm ml-2">{step.from.map(name).join(' + ') || '?'} → {step.to.map(name).join(' + ') || '?'}</span>
        </h3>
        <button className="text-muted hover:text-warn" aria-label={`Remove step ${no}`} title="Remove this step and its boxes" onClick={onRemove}>
          <Trash2 size={14} />
        </button>
      </div>

      <div className="grid sm:grid-cols-2 gap-x-4">
        <Field label="From">
          <IdPicker value={step.from} ids={ids} name={name} onChange={(v) => onChange((s) => { s.from = v })} />
        </Field>
        <Field label="To">
          <IdPicker value={step.to} ids={ids} name={name} onChange={(v) => onChange((s) => { s.to = v })} />
        </Field>
      </div>

      <Field label="Enzyme, accepted names">
        <ChipList values={step.enzyme.accept} firstIsPrimary placeholder="Add a name and press Enter"
          onChange={(v) => onChange((s) => { s.enzyme.accept = v })} />
      </Field>

      {c ? (
        <>
          <GroupsField label="Going in" hint="Each row is one required cofactor; any name in the row counts."
            groups={c.in ?? []} onChange={(g) => onChange((s) => { s.cofactors!.in = g })} />
          <GroupsField label="Coming out" groups={c.out ?? []} onChange={(g) => onChange((s) => { s.cofactors!.out = g })} />
          <Field label="Optional (never required, never penalised)">
            <ChipList values={c.optional ?? []} placeholder="e.g. Mg2+"
              onChange={(v) => onChange((s) => { s.cofactors!.optional = v })} />
          </Field>
          <button className="text-xs text-muted hover:text-warn mt-1" onClick={() => onChange((s) => { delete s.cofactors })}>
            Remove cofactors from this step
          </button>
        </>
      ) : (
        <button className="text-xs text-signal hover:underline inline-flex items-center gap-1" onClick={() => onChange((s) => { s.cofactors = { in: [], out: [], optional: [] } })}>
          <Plus size={12} /> Add cofactors
        </button>
      )}
    </Card>
  )
}

function GroupsField({ label, hint, groups, onChange }: { label: string; hint?: string; groups: string[][]; onChange: (g: string[][]) => void }) {
  return (
    <Field label={label} hint={hint}>
      <div className="space-y-1.5">
        {groups.map((g, i) => (
          <div key={i} className="flex items-center gap-2 border border-hairline rounded-sm px-2 py-1">
            <div className="flex-1">
              <ChipList values={g} placeholder="Add a form and press Enter"
                onChange={(v) => onChange(groups.map((x, j) => (j === i ? v : x)))} />
            </div>
            <button className="text-muted hover:text-warn" aria-label="Remove this cofactor" onClick={() => onChange(groups.filter((_, j) => j !== i))}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        <button className="text-xs text-signal hover:underline inline-flex items-center gap-1" onClick={() => onChange([...groups, []])}>
          <Plus size={12} /> Add a required cofactor
        </button>
      </div>
    </Field>
  )
}

function IntermediateCard({ it, usedIn, onChange, onRemove }: {
  it: RawIntermediate
  usedIn: string[]
  onChange: (fn: (i: RawIntermediate) => void) => void
  onRemove: () => void
}) {
  const features = it.features ?? []
  const weights = it.feature_weights
  return (
    <Card className="p-4">
      <div className="grid sm:grid-cols-[1fr_auto] gap-2 items-end mb-3">
        <Field label="Name">
          <input className={inputClass} value={it.name} onChange={(e) => onChange((x) => { x.name = e.target.value })} />
        </Field>
        <button className="text-muted hover:text-warn pb-2 disabled:opacity-40 disabled:hover:text-muted" aria-label={`Remove ${it.name}`}
          disabled={usedIn.length > 0}
          title={usedIn.length ? `Used in step ${usedIn.join(', ')}; remove it there first` : 'Remove this intermediate and its boxes'}
          onClick={onRemove}>
          <Trash2 size={14} />
        </button>
      </div>
      <Field label="Accepted names">
        <ChipList values={it.accept ?? []} placeholder="Add a name and press Enter" onChange={(v) => onChange((x) => { x.accept = v })} />
      </Field>
      <Field label={weights ? 'Structure checks and weights' : 'Structure checks'} hint="Only used if a version grades this structure.">
        <div className="space-y-1.5">
          {features.map((f, i) => (
            <div key={i} className="flex items-center gap-2">
              <input className={inputClass} value={f} onChange={(e) => onChange((x) => { x.features![i] = e.target.value })} />
              {weights && (
                <input type="number" min={0} step={0.5} className={`${inputClass} w-20`} value={weights[i] ?? 1} aria-label="Weight"
                  onChange={(e) => onChange((x) => { x.feature_weights![i] = Number(e.target.value) })} />
              )}
              <button className="text-muted hover:text-warn" aria-label="Remove check" onClick={() => onChange((x) => {
                x.features = features.filter((_, j) => j !== i)
                if (x.feature_weights) x.feature_weights = x.feature_weights.filter((_, j) => j !== i)
              })}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          <div className="flex flex-wrap gap-4">
            <button className="text-xs text-signal hover:underline inline-flex items-center gap-1" onClick={() => onChange((x) => {
              x.features = [...features, '']
              if (x.feature_weights) x.feature_weights = [...x.feature_weights, 1]
            })}>
              <Plus size={12} /> Add a check
            </button>
            {features.length > 0 && (
              weights
                ? <button className="text-xs text-muted hover:text-ink" onClick={() => onChange((x) => { delete x.feature_weights })}>Weigh checks equally</button>
                : <button className="text-xs text-muted hover:text-ink" onClick={() => onChange((x) => { x.feature_weights = features.map(() => 1) })}>Set weights</button>
            )}
          </div>
        </div>
      </Field>
    </Card>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <p className="text-xs font-semibold text-muted mb-1">{label}</p>
      {hint && <p className="text-[11px] text-muted mb-1">{hint}</p>}
      {children}
    </div>
  )
}
