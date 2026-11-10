import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ArrowLeft, CircleAlert, Download, Plus, Printer, Trash2 } from 'lucide-react'
import { api } from '@/api/client'
import ProfessorLayout from '@/components/layout/ProfessorLayout'
import Button from '@/components/ui/Button'
import Card from '@/components/ui/Card'
import ChipList from '@/components/quizGrader/ChipList'
import LayoutEditor from '@/components/quizGrader/LayoutEditor'
import { apiError } from '@/lib/errors'
import { KIND_LABEL, downloadPrintable, saveText, type QuizContentDetail, type RawIntermediate, type RawKey, type RawLayout, type RawStep } from '@/lib/quizGrader'

/**
 * One answer key, layout or assessment. Answer keys and layouts are edited here;
 * assessments are shown as their YAML until they have an editor.
 *
 * The editor holds the YAML's raw parse and sends the whole thing back on save; the
 * server rewrites only the text that changed, so the file's comments and formatting
 * stay as the author left them and its export diffs cleanly.
 */

const inputClass = 'w-full border border-hairline rounded-sm px-2.5 py-1.5 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-signal'

export default function QuizContentEditorPage() {
  const { id } = useParams<{ id: string }>()
  const qc = useQueryClient()
  const { data: item, isLoading, error } = useQuery<QuizContentDetail>({
    queryKey: ['quiz-grader', 'content', id],
    queryFn: () => api.get(`/quiz-grader/content/${id}`).then((r) => r.data.data),
  })

  return (
    <ProfessorLayout>
      <Link to="/professor/quiz-grader" className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink mb-4">
        <ArrowLeft size={14} /> Paper quizzes
      </Link>
      {isLoading ? null : error || !item ? (
        <p className="text-sm text-warn">{apiError(error, 'Could not open this item')}</p>
      ) : (item.kind === 'KEY' || item.kind === 'LAYOUT') && item.data && !item.issues.length ? (
        <DraftEditor item={item} onSaved={(next) => {
          qc.setQueryData(['quiz-grader', 'content', id], next)
          void qc.invalidateQueries({ queryKey: ['quiz-grader', 'content'], exact: true })
        }} />
      ) : (
        <SourceView item={item} />
      )}
    </ProfessorLayout>
  )
}

function Header({ item, children }: { item: QuizContentDetail; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
      <div>
        <p className="text-xs font-bold uppercase tracking-widest text-muted">{KIND_LABEL[item.kind]}</p>
        <h1 className="text-2xl font-bold text-ink">{item.title}</h1>
        <p className="text-xs font-mono text-muted">{item.slug}.yaml</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => saveText(`${item.slug}.yaml`, item.source)}><Download size={13} />Download YAML</Button>
        {children}
      </div>
    </div>
  )
}

function Problems({ item }: { item: QuizContentDetail }) {
  if (!item.issues.length && !item.warnings.length) return null
  return (
    <Card flat className="p-4 mb-5 space-y-1">
      {item.issues.map((i) => <p key={i} className="text-sm text-warn flex gap-1.5"><CircleAlert size={15} className="shrink-0 mt-0.5" />{i}</p>)}
      {item.warnings.map((w) => <p key={w} className="text-sm text-muted flex gap-1.5"><AlertTriangle size={15} className="shrink-0 mt-0.5" />{w}</p>)}
      {item.issues.length > 0 && <p className="text-xs text-muted pt-1">Fix these in the YAML and import it again with “replace”.</p>}
    </Card>
  )
}

function SourceView({ item }: { item: QuizContentDetail }) {
  const [printError, setPrintError] = useState('')
  const versions = item.kind === 'ASSESSMENT' && !item.issues.length
    ? Object.keys((item.data?.versions as Record<string, unknown> | undefined) ?? {})
    : []
  return (
    <>
      <Header item={item}>
        {versions.length > 0 && (
          <>
            {versions.length > 1 && (
              <Button size="sm" onClick={() => downloadPrintable(api, item.id, item.slug).catch((e) => setPrintError(apiError(e, 'Could not print')))}>
                <Printer size={13} />Print all versions
              </Button>
            )}
            {versions.map((v) => (
              <Button key={v} size="sm" onClick={() => downloadPrintable(api, item.id, item.slug, v).catch((e) => setPrintError(apiError(e, 'Could not print')))}>
                <Printer size={13} />Version {v}
              </Button>
            ))}
          </>
        )}
      </Header>
      {printError && <p className="text-sm text-warn mb-4">{printError}</p>}
      <Problems item={item} />
      <Card className="p-4 overflow-x-auto">
        <pre className="text-xs font-mono text-ink-2 whitespace-pre">{item.source}</pre>
      </Card>
    </>
  )
}

// ── Editing: save, discard and the unsaved-changes guard, shared by both editors ──

type Draft = Record<string, unknown>

function DraftEditor({ item, onSaved }: { item: QuizContentDetail; onSaved: (next: QuizContentDetail) => void }) {
  const original = item.data as Draft
  const [draft, setDraft] = useState<Draft>(() => structuredClone(original))
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ tone: 'good' | 'warn'; text: string } | null>(null)
  useEffect(() => setDraft(structuredClone(item.data as Draft)), [item.data])

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(original), [draft, original])

  // Warn before leaving with unsaved edits.
  useEffect(() => {
    if (!dirty) return
    const h = (e: BeforeUnloadEvent) => { e.preventDefault() }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [dirty])

  /** Change the draft through a mutable copy. Stable, so effects can depend on it. */
  const edit = useCallback(<T,>(fn: (d: T) => void) => setDraft((d) => { const c = structuredClone(d); fn(c as T); return c }), [])

  async function save() {
    setSaving(true)
    setMessage(null)
    try {
      const r = await api.put(`/quiz-grader/content/${item.id}`, { data: draft, updatedAt: item.updatedAt })
      onSaved(r.data.data)
      setMessage({ tone: 'good', text: 'Saved.' })
    } catch (e) {
      setMessage({ tone: 'warn', text: apiError(e, 'Could not save') })
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Header item={item}>
        <Button size="sm" disabled={!dirty || saving} onClick={() => setDraft(structuredClone(original))}>Discard changes</Button>
        <Button size="sm" variant="primary" disabled={!dirty || saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</Button>
      </Header>
      <Problems item={item} />
      {message && <p className={`text-sm mb-4 ${message.tone === 'good' ? 'text-good' : 'text-warn'}`}>{message.text}</p>}

      {item.kind === 'KEY'
        ? <KeyFields draft={draft as unknown as RawKey} edit={edit as (fn: (k: RawKey) => void) => void} />
        : <LayoutEditor item={item} draft={draft as unknown as RawLayout} edit={edit as (fn: (l: RawLayout) => void) => void} />}

      {dirty && (
        <div className="sticky bottom-4 mt-6 flex justify-end z-10">
          <Card className="px-4 py-2.5 flex items-center gap-3">
            <span className="text-sm text-ink-2">Unsaved changes</span>
            <Button size="sm" variant="primary" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</Button>
          </Card>
        </div>
      )}
    </>
  )
}

// ── Answer key fields ──────────────────────────────────────────────────────────

function KeyFields({ draft, edit }: { draft: RawKey; edit: (fn: (k: RawKey) => void) => void }) {
  const name = (id: string) => draft.intermediates[id]?.name ?? id
  const steps = Object.entries(draft.steps).sort(([a], [b]) => Number(a) - Number(b))

  return (
    <>

      <Card className="p-4 mb-8">
        <label className="text-xs font-semibold text-muted">Title</label>
        <input className={inputClass} value={draft.title} onChange={(e) => edit((k) => { k.title = e.target.value })} />
      </Card>

      <h2 className="text-lg font-semibold text-ink mb-1">Steps</h2>
      <p className="text-xs text-muted mb-3">
        Accepted enzyme names match regardless of case, spaces, hyphens and Greek letters; small misspellings go to review. The highlighted name is the one the model is told to expect.
      </p>
      <div className="space-y-3 mb-10">
        {steps.map(([no, step]) => (
          <StepCard key={no} no={no} step={step} name={name} onChange={(fn) => edit((k) => fn(k.steps[no]!))} />
        ))}
      </div>

      <h2 className="text-lg font-semibold text-ink mb-1">Intermediates</h2>
      <p className="text-xs text-muted mb-3">
        Features are the yes/no checks the model answers about a drawn structure. Write them so they hold for Fischer, Haworth or line drawings alike.
      </p>
      <div className="space-y-3">
        {Object.entries(draft.intermediates).map(([id, it]) => (
          <IntermediateCard key={id} id={id} it={it} onChange={(fn) => edit((k) => fn(k.intermediates[id]!))} />
        ))}
      </div>
    </>
  )
}

function StepCard({ no, step, name, onChange }: {
  no: string
  step: RawStep
  name: (id: string) => string
  onChange: (fn: (s: RawStep) => void) => void
}) {
  const c = step.cofactors
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
        <h3 className="font-semibold text-ink">
          Step {no}
          <span className="font-normal text-muted text-sm ml-2">{step.from.map(name).join(' + ')} → {step.to.map(name).join(' + ')}</span>
        </h3>
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

function IntermediateCard({ id, it, onChange }: { id: string; it: RawIntermediate; onChange: (fn: (i: RawIntermediate) => void) => void }) {
  const features = it.features ?? []
  const weights = it.feature_weights
  return (
    <Card className="p-4">
      <div className="grid sm:grid-cols-[1fr_auto] gap-2 items-end mb-3">
        <Field label="Name">
          <input className={inputClass} value={it.name} onChange={(e) => onChange((x) => { x.name = e.target.value })} />
        </Field>
        <span className="text-xs font-mono text-muted pb-2">{id}</span>
      </div>
      <Field label="Accepted names">
        <ChipList values={it.accept ?? []} placeholder="Add a name and press Enter" onChange={(v) => onChange((x) => { x.accept = v })} />
      </Field>
      <Field label={weights ? 'Structure features and weights' : 'Structure features'}>
        <div className="space-y-1.5">
          {features.map((f, i) => (
            <div key={i} className="flex items-center gap-2">
              <input className={inputClass} value={f} onChange={(e) => onChange((x) => { x.features![i] = e.target.value })} />
              {weights && (
                <input type="number" min={0} step={0.5} className={`${inputClass} w-20`} value={weights[i] ?? 1} aria-label="Weight"
                  onChange={(e) => onChange((x) => { x.feature_weights![i] = Number(e.target.value) })} />
              )}
              <button className="text-muted hover:text-warn" aria-label="Remove feature" onClick={() => onChange((x) => {
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
              <Plus size={12} /> Add a feature
            </button>
            {features.length > 0 && (
              weights
                ? <button className="text-xs text-muted hover:text-ink" onClick={() => onChange((x) => { delete x.feature_weights })}>Weigh features equally</button>
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
