import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ListChecks, RotateCw, Sparkles } from 'lucide-react'
import { api } from '@/api/client'
import ProfessorLayout from '@/components/layout/ProfessorLayout'
import Button from '@/components/ui/Button'
import Card from '@/components/ui/Card'
import { apiError } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { STATUS_LABEL, type QuizPage } from '@/lib/quizGrader'

interface ResultsData {
  pages: (Pick<QuizPage, 'id' | 'batchId' | 'index' | 'status' | 'version' | 'gradeStatus' | 'gradeError' | 'pointsAuto' | 'pointsFinal' | 'maxPoints' | 'toReview'> & { fileName: string })[]
  summary: { pages: number; graded: number; grading: number; failed: number; toReview: number; cost: { dollars: number; unpriced: string[] } }
}

/** Every scanned paper of an assessment with its automatic score. Not connected to the gradebook. */
export default function QuizResultsPage() {
  const { id } = useParams<{ id: string }>()
  const qc = useQueryClient()
  const [note, setNote] = useState('')
  const { data, error } = useQuery<ResultsData>({
    queryKey: ['quiz-grader', 'results', id],
    queryFn: () => api.get(`/quiz-grader/content/${id}/results`).then((r) => r.data.data),
    staleTime: 0,
    refetchInterval: (q) => (q.state.data?.summary.grading ? 2000 : false),
  })

  async function rescore() {
    setNote('')
    try {
      const r = await api.post(`/quiz-grader/content/${id}/rescore`)
      const n = r.data.data.pages as number
      setNote(`Re-scored ${n} page${n === 1 ? '' : 's'} against the current key.`)
      void qc.invalidateQueries({ queryKey: ['quiz-grader'] })
    } catch (e) {
      setNote(apiError(e, 'Could not re-score'))
    }
  }

  async function gradeUngraded() {
    setNote('')
    try {
      const r = await api.post(`/quiz-grader/content/${id}/grade-ungraded`)
      const n = r.data.data.queued as number
      setNote(`Grading ${n} page${n === 1 ? '' : 's'}…`)
      void qc.invalidateQueries({ queryKey: ['quiz-grader'] })
    } catch (e) {
      setNote(apiError(e, 'Could not start grading'))
    }
  }

  const ungraded = (data?.pages ?? []).filter((pg) => pg.status === 'DONE' && (pg.gradeStatus === 'NONE' || pg.gradeStatus === 'FAILED')).length
  const s = data?.summary
  const dollars = (n: number) => '$' + n.toFixed(2)
  return (
    <ProfessorLayout>
      <Link to={`/professor/quiz-grader/${id}`} className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink mb-4">
        <ArrowLeft size={14} /> Assessment
      </Link>
      {error ? <p className="text-sm text-warn">{apiError(error, 'Could not load results')}</p> : !data || !s ? null : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
            <div>
              <p className="text-xs font-bold uppercase tracking-widest text-muted">Results</p>
              <h1 className="text-2xl font-bold text-ink">{s.graded} of {s.pages} papers graded</h1>
              <p className="text-sm text-muted">
                {s.toReview} boxes to review
                {s.grading ? ` · ${s.grading} grading now` : ''}
                {s.failed ? ` · ${s.failed} failed` : ''}
                {' · model cost '}{dollars(s.cost.dollars)}
                {s.cost.unpriced.length ? ` (+ unpriced: ${s.cost.unpriced.join(', ')})` : ''}
              </p>
              <p className="text-xs text-muted mt-1">Scores after your review decisions. Not sent to the gradebook.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {ungraded > 0 && (
                <Button size="sm" variant="primary" onClick={() => void gradeUngraded()} title="Pages lined up before grading was set up, or whose grading failed">
                  <Sparkles size={13} />Grade {ungraded} ungraded page{ungraded === 1 ? '' : 's'}
                </Button>
              )}
              <Link to={`/professor/quiz-grader/${id}/review`}>
                <Button size="sm" variant={s.toReview ? 'primary' : 'ghost'}><ListChecks size={13} />Review{s.toReview ? ` (${s.toReview} left)` : ''}</Button>
              </Link>
              <Button size="sm" onClick={() => void rescore()} title="Score every graded paper again with the key as it is now. No new model calls.">
                <RotateCw size={13} />Re-score with current key
              </Button>
            </div>
          </div>
          {note && <p className="text-sm text-muted mb-3">{note}</p>}
          <Card className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted text-left">
                <tr>
                  <th className="px-4 py-2">Upload</th><th className="pr-4">Page</th><th className="pr-4">Version</th>
                  <th className="pr-4">Score</th><th className="pr-4">To review</th><th className="pr-4">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.pages.map((pg) => {
                  const graded = pg.gradeStatus === 'GRADED'
                  const status = pg.status !== 'DONE' ? STATUS_LABEL[pg.status]
                    : graded ? 'Graded'
                    : pg.gradeStatus === 'FAILED' ? 'Grading failed'
                    : pg.gradeStatus === 'NONE' ? 'Not graded' : 'Grading…'
                  return (
                    <tr key={pg.id} className="border-t border-hairline hover:bg-surface-2">
                      <td className="px-4 py-2 truncate max-w-[16rem]">{pg.fileName}</td>
                      <td className="pr-4"><Link to={`/professor/quiz-grader/pages/${pg.id}`} className="text-signal hover:underline">{pg.index + 1}</Link></td>
                      <td className="pr-4">{pg.version ?? '—'}</td>
                      <td className="pr-4 font-semibold text-ink">{graded ? `${pg.pointsFinal ?? pg.pointsAuto}/${pg.maxPoints}` : '—'}</td>
                      <td className={cn('pr-4', pg.toReview ? 'text-warn' : 'text-muted')}>{graded ? pg.toReview : '—'}</td>
                      <td className={cn('pr-4 text-xs', pg.gradeStatus === 'FAILED' ? 'text-warn' : 'text-muted')}>{status}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </ProfessorLayout>
  )
}
