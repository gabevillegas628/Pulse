import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, FileUp, RefreshCw, Sparkles, Trash2, X } from 'lucide-react'
import { api } from '@/api/client'
import AuthImage from '@/components/quizGrader/AuthImage'
import Button from '@/components/ui/Button'
import Card from '@/components/ui/Card'
import { apiError } from '@/lib/errors'
import { cn } from '@/lib/utils'
import type { QuizDraft } from '@/lib/quizGrader'

/**
 * Checks for drawn structures, suggested from the professor's own filled-in key and tested on
 * it. Upload the key; Pulse cuts out each drawing. A model suggests checks; the reader that
 * grades papers then answers them on every key drawing, and the tally is shown: a correct
 * drawing must pass every check, and every other molecule must fail one. Accepting puts the
 * checks in the draft, saved like any other edit.
 */

interface CheckTest {
  tested: boolean
  keyFails: { check: string; saw: string }[]
  confusedWith: { id: string; name: string }[]
  tellsApart: { id: string; name: string; by: string[] }[]
}
interface Suggestion {
  id: string
  name: string
  current: string[]
  currentTest: CheckTest | null
  suggested: string[]
  suggestedTest: CheckTest
  dropped: { check: string; saw: string }[]
  revised: boolean
}
interface Job {
  status: 'running' | 'done' | 'failed'
  step: string
  error?: string
  keyUpdatedAt?: string
  result?: { items: Suggestion[]; dollars: number; models: string[]; drawings: number }
}
interface Drawings {
  fileName: string
  pages: number
  notes: string[]
  items: { id: string; name: string; slotId: string; page: number; graded: boolean }[]
  outOfDate: string[]
  noBox: string[]
}
interface State { drawings: Drawings | null; vision: boolean; suggestion: Job | null }

type EditDraft = (fn: (d: QuizDraft) => void) => void

export default function KeyChecksPanel({ quizId, draft, edit, keyUpdatedAt }: {
  quizId: string
  draft: QuizDraft
  edit: EditDraft
  keyUpdatedAt: string | undefined
}) {
  const qc = useQueryClient()
  const file = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [applied, setApplied] = useState('')
  const queryKey = ['quiz-grader', 'key-drawings', quizId]
  const { data } = useQuery<State>({
    queryKey,
    queryFn: () => api.get(`/quiz-grader/quizzes/${quizId}/key-drawings`).then((r) => r.data.data),
    refetchInterval: (q) => (q.state.data?.suggestion?.status === 'running' ? 2000 : false),
  })
  const set = (patch: Partial<State>) => qc.setQueryData<State>(queryKey, (s) => (s ? { ...s, ...patch } : s))

  async function act(what: string, fn: () => Promise<void>, failure: string) {
    setBusy(what)
    setError('')
    try { await fn() } catch (e) { setError(apiError(e, failure)) } finally { setBusy(null) }
  }
  const upload = (f: File) => act('upload', async () => {
    const r = await api.put(`/quiz-grader/quizzes/${quizId}/key-drawings?name=${encodeURIComponent(f.name)}`, f, { headers: { 'Content-Type': f.type || 'application/pdf' } })
    set({ drawings: r.data.data })
  }, 'Could not read the key')
  const recut = () => act('cut', async () => {
    set({ drawings: (await api.post(`/quiz-grader/quizzes/${quizId}/key-drawings/cut`)).data.data })
  }, 'Could not cut the key again')
  const remove = () => act('remove', async () => {
    await api.delete(`/quiz-grader/quizzes/${quizId}/key-drawings`)
    set({ drawings: null })
  }, 'Could not remove the key')
  const suggest = () => act('suggest', async () => {
    setApplied('')
    set({ suggestion: (await api.post(`/quiz-grader/quizzes/${quizId}/suggest-checks`)).data.data })
  }, 'Could not start')

  function use(items: Suggestion[]) {
    edit((d) => {
      for (const s of items) {
        const it = d.key.intermediates[s.id]
        if (!it || !s.suggested.length) continue
        it.features = [...s.suggested]
        // Weights were for the old checks.
        delete it.feature_weights
      }
    })
    setApplied(items.length === 1 ? items[0]!.name : `${items.length} intermediates`)
  }

  if (!data) return null
  const d = data.drawings
  const job = data.suggestion
  const items = job?.status === 'done' ? job.result?.items ?? [] : []
  const pending = items.filter((s) => s.suggested.length && JSON.stringify(draft.key.intermediates[s.id]?.features ?? []) !== JSON.stringify(s.suggested))
  const keyMoved = job?.keyUpdatedAt && keyUpdatedAt && job.keyUpdatedAt !== keyUpdatedAt

  return (
    <Card className="p-4 mb-5">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold text-ink flex items-center gap-1.5"><Sparkles size={16} className="text-signal" />Checks for drawn structures</h2>
          <p className="text-sm text-muted max-w-2xl">
            Upload your own filled-in answer key. Pulse cuts out each drawing, suggests checks, and tests them on your drawings with the same reader that grades papers. Your drawing of a molecule must pass all its checks, and every other molecule must fail at least one.
          </p>
        </div>
        <input ref={file} type="file" accept="application/pdf,.pdf,image/png,image/jpeg" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void upload(f) }} />
        {d ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={!!busy} onClick={() => file.current?.click()}><FileUp size={13} />Replace key</Button>
            <Button size="sm" disabled={!!busy} onClick={() => void remove()} title="Remove the uploaded key and its drawings"><Trash2 size={13} /></Button>
          </div>
        ) : (
          <Button size="sm" variant="primary" disabled={!!busy || !data.vision} onClick={() => file.current?.click()}>
            <FileUp size={13} />{busy === 'upload' ? 'Lining it up…' : 'Upload filled-in key'}
          </Button>
        )}
      </div>
      {!data.vision && <p className="text-sm text-warn mt-2">The vision service is not set up, so a key cannot be lined up.</p>}
      {error && <p className="text-sm text-warn mt-2">{error}</p>}

      {d && (
        <>
          <p className="text-xs text-muted mt-3">
            {d.fileName} · {d.pages} page{d.pages === 1 ? '' : 's'} · {d.items.length} drawing{d.items.length === 1 ? '' : 's'} found
            {busy === 'upload' && ' · lining up the new file…'}
          </p>
          {d.notes.map((n) => <p key={n} className="text-sm text-warn mt-1">{n}</p>)}
          {d.noBox.length > 0 && <p className="text-sm text-warn mt-1">No box drawn for {d.noBox.join(', ')} (Boxes tab), so {d.noBox.length === 1 ? 'its drawing' : 'their drawings'} cannot be cut out.</p>}
          {d.outOfDate.length > 0 && (
            <p className="text-sm text-warn mt-1 flex flex-wrap items-center gap-2">
              Boxes have moved since the key was cut.
              <Button size="sm" disabled={!!busy} onClick={() => void recut()}><RefreshCw size={13} />{busy === 'cut' ? 'Cutting…' : 'Cut again'}</Button>
            </p>
          )}
          <div className="flex gap-2 overflow-x-auto mt-2 pb-1">
            {d.items.map((it) => (
              <figure key={it.id} className="shrink-0 w-36">
                <AuthImage src={`/quiz-grader/quizzes/${quizId}/key-drawings/${it.id}.png`} alt={`Key drawing of ${it.name}`} className="rounded-sm border border-hairline h-24 overflow-hidden [&_img]:h-24 [&_img]:w-full [&_img]:object-contain" />
                <figcaption className={cn('text-xs mt-0.5 truncate', it.graded ? 'text-ink-2' : 'text-muted')} title={`${it.name}, page ${it.page}`}>{it.name}</figcaption>
              </figure>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2 mt-3">
            <Button size="sm" variant="primary" disabled={!!busy || job?.status === 'running' || !d.items.length} onClick={() => void suggest()}>
              <Sparkles size={13} />{job?.status === 'running' ? 'Working…' : items.length ? 'Suggest again' : 'Suggest checks'}
            </Button>
            {job?.status === 'running' && <span className="text-sm text-muted">{job.step}… This takes a minute or two.</span>}
            {job?.status === 'failed' && <span className="text-sm text-warn">{job.error}</span>}
            {job?.status === 'done' && job.result && (
              <span className="text-xs text-muted">
                Tested on {job.result.drawings} key drawing{job.result.drawings === 1 ? '' : 's'}{job.result.dollars > 0 ? ` · cost $${job.result.dollars.toFixed(2)}` : ''}
              </span>
            )}
            {pending.length > 1 && <Button size="sm" onClick={() => use(pending)}>Use all {pending.length} suggestions</Button>}
          </div>
        </>
      )}

      {applied && (
        <p className="text-sm text-good mt-3">
          Checks for {applied} are in your unsaved changes. Save to use them; papers already graded have those drawings read again.
        </p>
      )}
      {keyMoved && items.length > 0 && <p className="text-xs text-muted mt-2">The key has been saved since these were suggested, so “current” may be out of date.</p>}

      {items.length > 0 && (
        <div className="mt-4 space-y-3">
          {items.map((s) => {
            const inDraft = s.suggested.length > 0 && JSON.stringify(draft.key.intermediates[s.id]?.features ?? []) === JSON.stringify(s.suggested)
            return (
              <div key={s.id} className="border border-hairline rounded-sm p-3">
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  <p className="font-semibold text-ink flex-1 min-w-0">{s.name}</p>
                  {inDraft
                    ? <span className="text-xs text-good flex items-center gap-1"><Check size={13} />In use{JSON.stringify(s.current) === JSON.stringify(s.suggested) ? '' : ' (unsaved)'}</span>
                    : s.suggested.length > 0 && <Button size="sm" onClick={() => use([s])}>Use these</Button>}
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <ChecksColumn title="Current" checks={s.current} test={s.currentTest} />
                  <ChecksColumn title={s.revised ? 'Suggested (revised once after testing)' : 'Suggested'} checks={s.suggested} test={s.suggestedTest} />
                </div>
                {s.dropped.length > 0 && (
                  <p className="text-xs text-muted mt-2">
                    Left out, because your own drawing failed {s.dropped.length === 1 ? 'it' : 'them'}: {s.dropped.map((x) => `“${x.check}”`).join('; ')}.
                  </p>
                )}
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}

function ChecksColumn({ title, checks, test }: { title: string; checks: string[]; test: CheckTest | null }) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-semibold text-muted mb-1">{title}</p>
      {checks.length ? (
        <ul className="text-sm text-ink-2 list-disc pl-5 space-y-0.5">{checks.map((c) => <li key={c}>{c}</li>)}</ul>
      ) : <p className="text-sm text-muted">None</p>}
      {test && checks.length > 0 && <TestLine test={test} />}
    </div>
  )
}

function TestLine({ test }: { test: CheckTest }) {
  if (!test.tested) return <p className="text-xs text-muted mt-1.5">No key drawing of this molecule, so not tested.</p>
  const good = !test.keyFails.length && !test.confusedWith.length
  const others = test.tellsApart.length + test.confusedWith.length
  return (
    <div className="text-xs mt-1.5 space-y-0.5">
      {good && <p className="text-good flex gap-1"><Check size={13} className="shrink-0" />Your drawing passes every check, and all {others} other drawing{others === 1 ? '' : 's'} fail at least one.</p>}
      {test.keyFails.map((f) => (
        <p key={f.check} className="text-warn flex gap-1"><X size={13} className="shrink-0 mt-px" />
          <span>Your own drawing fails “{f.check}”.{f.saw ? ` The reader saw: ${f.saw}` : ''}</span>
        </p>
      ))}
      {test.confusedWith.length > 0 && (
        <p className="text-warn flex gap-1"><X size={13} className="shrink-0 mt-px" />
          <span>Can’t tell it from {test.confusedWith.map((c) => c.name).join(', ')}: {test.confusedWith.length === 1 ? 'that drawing passes' : 'those drawings pass'} every check.</span>
        </p>
      )}
    </div>
  )
}
