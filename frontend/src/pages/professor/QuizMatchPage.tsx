import { useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ArrowLeft, Download } from 'lucide-react'
import { api } from '@/api/client'
import ProfessorLayout from '@/components/layout/ProfessorLayout'
import Button from '@/components/ui/Button'
import Card from '@/components/ui/Card'
import AuthImage from '@/components/quizGrader/AuthImage'
import StudentPicker, { type Student } from '@/components/quizGrader/StudentPicker'
import { apiError } from '@/lib/errors'
import { saveBlob } from '@/lib/quizGrader'

/**
 * Whose paper is whose: each paper's name and NetID boxes beside a search over the class
 * roster. Type a few letters, Enter takes the top match and moves to the next paper.
 * Done by a person, on purpose: names and NetIDs are never sent to a model.
 */

interface MatchPage { id: string; batchId: string; index: number; status: string; fileName: string; netId: string | null; nameBox: string | null; netidBox: string | null }
interface MatchData {
  classId: string | null
  classes: { id: string; name: string }[]
  roster: Student[]
  pages: MatchPage[]
  /** Roster students with no paper: 0 in the gradebook unless excused. */
  noPaper: string[]
  excused: string[]
}

export default function QuizMatchPage() {
  const { id } = useParams<{ id: string }>()
  const qc = useQueryClient()
  const [error, setError] = useState('')
  const [onlyOpen, setOnlyOpen] = useState(false)
  const inputs = useRef(new Map<string, HTMLInputElement>())
  const { data } = useQuery<MatchData>({
    queryKey: ['quiz-grader', 'match', id],
    queryFn: () => api.get(`/quiz-grader/content/${id}/match`).then((r) => r.data.data),
    staleTime: 0,
  })

  const setData = (fn: (d: MatchData) => MatchData) => qc.setQueryData<MatchData>(['quiz-grader', 'match', id], (d) => (d ? fn(d) : d))

  async function setClass(classId: string | null) {
    setError('')
    try {
      const r = await api.put(`/quiz-grader/content/${id}/class`, { classId })
      setData((d) => ({ ...d, classId, roster: r.data.data.roster }))
    } catch (e) { setError(apiError(e, 'Could not change the class')) }
  }

  async function match(pg: MatchPage, netId: string | null) {
    setError('')
    try {
      const r = await api.put(`/quiz-grader/pages/${pg.id}/student`, { netId })
      setData((d) => ({ ...d, pages: d.pages.map((x) => (x.id === pg.id ? { ...x, netId: r.data.data.netId } : x)) }))
      void qc.invalidateQueries({ queryKey: ['quiz-grader', 'results', id] })
      if (netId) {
        // On to the next paper with no student yet.
        const pages = data?.pages ?? []
        const next = pages.slice(pages.findIndex((x) => x.id === pg.id) + 1).find((x) => !x.netId)
        if (next) setTimeout(() => inputs.current.get(next.id)?.focus(), 0)
      }
    } catch (e) { setError(apiError(e, 'Could not save')) }
  }

  async function excuse(netId: string, excused: boolean) {
    setError('')
    // Ticks at once; put back if the save fails.
    const set = (on: boolean) => setData((d) => ({ ...d, excused: on ? [...d.excused.filter((n) => n !== netId), netId] : d.excused.filter((n) => n !== netId) }))
    set(excused)
    try {
      await api.put(`/quiz-grader/content/${id}/excused`, { netId, excused })
      void qc.invalidateQueries({ queryKey: ['quiz-grader', 'release', id] })
    } catch (e) {
      set(!excused)
      setError(apiError(e, 'Could not save'))
    }
  }

  async function download() {
    setError('')
    try {
      const r = await api.get(`/quiz-grader/content/${id}/export.csv`, { responseType: 'blob' })
      saveBlob('grades.csv', r.data as Blob)
    } catch (e) { setError(apiError(e, 'Could not export')) }
  }

  const counts = useMemo(() => {
    const c = new Map<string, number>()
    for (const pg of data?.pages ?? []) if (pg.netId) c.set(pg.netId, (c.get(pg.netId) ?? 0) + 1)
    return c
  }, [data?.pages])
  const onRoster = useMemo(() => new Set((data?.roster ?? []).map((s) => s.netId.toLowerCase())), [data?.roster])

  if (!data) return <ProfessorLayout>{null}</ProfessorLayout>
  const matched = data.pages.filter((pg) => pg.netId).length
  const missing = data.roster.filter((s) => !counts.has(s.netId.toLowerCase()))
  const shown = onlyOpen ? data.pages.filter((pg) => !pg.netId) : data.pages

  return (
    <ProfessorLayout>
      <Link to={`/professor/quiz-grader/${id}/results`} className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink mb-4">
        <ArrowLeft size={14} /> Results
      </Link>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-5">
        <div>
          <p className="text-xs font-bold uppercase tracking-widest text-muted">Students</p>
          <h1 className="text-2xl font-bold text-ink">{matched} of {data.pages.length} papers matched</h1>
          <p className="text-sm text-muted">Read each paper&rsquo;s NetID and pick the student. Enter takes the top match and moves on.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-sm text-ink-2 flex items-center gap-2">
            <input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} /> Only unmatched
          </label>
          <Button size="sm" onClick={() => void download()}><Download size={13} />Download grades (CSV)</Button>
        </div>
      </div>

      <Card className="p-4 mb-5 flex flex-wrap items-center gap-3">
        <label className="text-sm font-semibold text-ink" htmlFor="quiz-class">Class</label>
        {data.classId ? (
          // A quiz belongs to its class; moving it is done from the quiz's Overview.
          <span className="text-sm text-ink">{data.classes.find((c) => c.id === data.classId)?.name ?? 'This quiz’s class'}</span>
        ) : (
          <select id="quiz-class" className="border border-hairline rounded-sm px-2 py-1.5 text-sm bg-surface min-w-56"
            value="" onChange={(e) => void setClass(e.target.value || null)}>
            <option value="">Put this quiz in the class that took it…</option>
            {data.classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
        {data.classId && (
          <span className="text-sm text-muted">
            {data.roster.length} students{missing.length && matched ? ` · ${missing.length} without a paper yet` : ''}
          </span>
        )}
        {!data.classId && <span className="text-sm text-muted">Its roster is what you pick from. You can still type NetIDs without one.</span>}
      </Card>
      {error && <p className="text-sm text-warn mb-3">{error}</p>}

      <Card className="divide-y divide-hairline">
        {shown.map((pg) => (
          <PaperRow key={pg.id} pg={pg} roster={data.roster} quizHasClass={!!data.classId}
            duplicate={!!pg.netId && (counts.get(pg.netId) ?? 0) > 1}
            offRoster={!!pg.netId && !!data.classId && !onRoster.has(pg.netId)}
            inputRef={(el) => { if (el) inputs.current.set(pg.id, el); else inputs.current.delete(pg.id) }}
            onMatch={(n) => void match(pg, n)} />
        ))}
        {shown.length === 0 && <p className="p-4 text-sm text-good">Every paper is matched.</p>}
      </Card>

      {data.classId && data.noPaper.length > 0 && (
        <section className="mt-8">
          <h2 className="text-base font-semibold text-ink">No paper ({data.noPaper.length})</h2>
          <p className="text-xs text-muted mb-2">Students on the roster with no matched paper. In the gradebook each counts as 0, unless excused (a makeup, an excused absence): then it does not count at all.</p>
          <Card className="divide-y divide-hairline">
            {data.noPaper.map((n) => {
              const ex = data.excused.includes(n)
              return (
                <label key={n} className="px-4 py-2 flex items-center gap-3 text-sm cursor-pointer hover:bg-surface-2">
                  <span className="font-mono text-ink flex-1">{n}</span>
                  <span className={ex ? 'text-muted' : 'text-ink-2'}>{ex ? 'excused' : 'counts as 0'}</span>
                  <input type="checkbox" checked={ex} onChange={(e) => void excuse(n, e.target.checked)} aria-label={`Excuse ${n}`} />
                </label>
              )
            })}
          </Card>
        </section>
      )}
    </ProfessorLayout>
  )
}

function PaperRow({ pg, roster, quizHasClass, duplicate, offRoster, inputRef, onMatch }: {
  pg: MatchPage
  roster: Student[]
  quizHasClass: boolean
  duplicate: boolean
  offRoster: boolean
  inputRef: (el: HTMLInputElement | null) => void
  onMatch: (netId: string | null) => void
}) {
  return (
    <div className="p-3 grid gap-3 md:grid-cols-[9rem_minmax(0,1fr)_minmax(0,0.8fr)_16rem] items-center">
      <div className="text-sm">
        <Link to={`/professor/quiz-grader/pages/${pg.id}`} className="font-semibold text-signal hover:underline">Page {pg.index + 1}</Link>
        <p className="text-xs text-muted truncate" title={pg.fileName}>{pg.fileName}</p>
      </div>
      <Crop pg={pg} box={pg.nameBox} what="name" />
      <Crop pg={pg} box={pg.netidBox} what="NetID" />
      <div className="relative">
        <StudentPicker netId={pg.netId} roster={roster} inputRef={inputRef} onMatch={onMatch}
          placeholder={quizHasClass ? 'Type a NetID…' : 'Type the NetID, then Enter'} />
        {(duplicate || offRoster) && (
          <p className="text-xs text-warn mt-1 flex gap-1">
            <AlertTriangle size={12} className="shrink-0 mt-0.5" />
            {duplicate ? 'Another paper has this NetID.' : 'Not on the class roster.'}
          </p>
        )}
      </div>
    </div>
  )
}

function Crop({ pg, box, what }: { pg: MatchPage; box: string | null; what: string }) {
  if (pg.status === 'NEEDS_VERSION') return <p className="text-xs text-warn">Set this page&rsquo;s version first (open the page)</p>
  if (pg.status !== 'DONE') return <p className="text-xs text-muted">{pg.status === 'FAILED' ? 'Could not be processed' : 'Not processed yet'}</p>
  if (!box) return <p className="text-xs text-muted">No {what} box drawn on this quiz&rsquo;s form</p>
  return <AuthImage src={`/quiz-grader/pages/${pg.id}/crops/${box}`} alt={`${what}, page ${pg.index + 1}`} className="rounded-sm border border-hairline overflow-hidden bg-white" />
}
