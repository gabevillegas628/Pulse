import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, BookCheck, Undo2 } from 'lucide-react'
import { api } from '@/api/client'
import Button from '@/components/ui/Button'
import Card from '@/components/ui/Card'
import { apiError } from '@/lib/errors'

/**
 * Sending a quiz's scores to the class gradebook. Nothing reaches the gradebook or the
 * students until it is released; after that it stays live. What is not settled yet is
 * listed first, so releasing early is a choice, not an accident.
 */

interface Summary {
  releasedAt: string | null
  classId: string | null
  max: number
  roster: number
  scored: number
  noPaper: number
  excused: number
  pending: number
  openBoxes: number
  notGraded: number
  unmatched: number
  offRoster: string[]
  duplicates: string[]
}

export default function ReleasePanel({ quizId }: { quizId: string }) {
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const { data: s } = useQuery<Summary>({
    queryKey: ['quiz-grader', 'release', quizId],
    queryFn: () => api.get(`/quiz-grader/content/${quizId}/release`).then((r) => r.data.data),
    staleTime: 0,
  })
  if (!s) return null

  async function set(released: boolean) {
    setBusy(true)
    setError('')
    try {
      const r = await api.put(`/quiz-grader/content/${quizId}/release`, { released })
      qc.setQueryData(['quiz-grader', 'release', quizId], r.data.data)
    } catch (e) {
      setError(apiError(e, released ? 'Could not release' : 'Could not take back'))
    } finally {
      setBusy(false)
    }
  }

  const issues = [
    s.openBoxes ? `${s.openBoxes} box${s.openBoxes === 1 ? '' : 'es'} still to review: their automatic scores count until you decide.` : '',
    s.notGraded ? `${s.notGraded} paper${s.notGraded === 1 ? ' is' : 's are'} not graded yet.` : '',
    s.unmatched ? `${s.unmatched} graded paper${s.unmatched === 1 ? ' is' : 's are'} not matched to a student, so ${s.unmatched === 1 ? 'it counts' : 'they count'} for no one.` : '',
    s.duplicates.length ? `Two papers share ${s.duplicates.join(', ')}: no score for ${s.duplicates.length === 1 ? 'that student' : 'those students'} until one is fixed.` : '',
    s.offRoster.length ? `Not on the class roster: ${s.offRoster.join(', ')}. Those papers count for no one.` : '',
  ].filter(Boolean)

  return (
    <Card className="p-4 mb-5">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-ink flex items-center gap-1.5"><BookCheck size={16} />Gradebook</p>
          {!s.classId ? (
            <p className="text-sm text-muted">Put this quiz in a class (Overview) to send its scores to that class&rsquo;s gradebook.</p>
          ) : s.releasedAt ? (
            <p className="text-sm text-good">Released {new Date(s.releasedAt).toLocaleDateString()}: in the gradebook and visible to students as a score. It updates as you review.</p>
          ) : (
            <p className="text-sm text-muted">Not released: nothing shows in the gradebook or to students yet.</p>
          )}
          {s.classId && (
            <p className="text-sm text-ink-2 mt-1">
              {s.scored} of {s.roster} students have a score (out of {s.max})
              {s.noPaper ? ` · ${s.noPaper} with no paper count as 0` : ''}
              {s.excused ? ` · ${s.excused} excused` : ''}
              {' · '}<Link to={`/professor/quiz-grader/${quizId}/match`} className="text-signal hover:underline">excuse a student</Link>
            </p>
          )}
        </div>
        {s.classId && (s.releasedAt
          ? <Button size="sm" disabled={busy} onClick={() => void set(false)} title="Take the scores out of the gradebook and away from students"><Undo2 size={13} />Take back</Button>
          : <Button size="sm" variant="primary" disabled={busy} onClick={() => void set(true)}>{issues.length ? 'Release anyway' : 'Release to gradebook'}</Button>)}
      </div>
      {s.classId && issues.length > 0 && (
        <div className="mt-3 space-y-1">
          {issues.map((t) => <p key={t} className="text-sm text-warn flex gap-1.5"><AlertTriangle size={14} className="shrink-0 mt-0.5" />{t}</p>)}
        </div>
      )}
      {error && <p className="text-sm text-warn mt-2">{error}</p>}
    </Card>
  )
}
