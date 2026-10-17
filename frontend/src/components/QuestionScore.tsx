import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/api/client'
import type { ActivityQuestion } from 'shared'
import ScoreChip from '@/components/ScoreChip'
import ScoreBadge from '@/components/session/ScoreBadge'

interface Props {
  classId: string
  studentId: string
  /** The session or assignment the question belongs to; the override route differs by type. */
  item: { id: string; type: 'IN_CLASS' | 'HOMEWORK' }
  question: ActivityQuestion
}

/**
 * One question's score in the gradebook's student views, editable where that is safe.
 *
 * Editable only on a counted question the student answered. An override is an aiScore on
 * the response, and any aiScore marks the whole question as graded: setting one on a
 * question that does not count yet would start it counting for the class, with every
 * other unscored answer taking full credit. Those are graded from the session page, where
 * the rest of the answers are in view.
 */
export default function QuestionScore({ classId, studentId, item, question }: Props) {
  const qc = useQueryClient()
  const response = question.response

  const mutation = useMutation({
    mutationFn: (aiScore: number) => {
      const base = item.type === 'HOMEWORK' ? `/assignments/${item.id}` : `/sessions/${item.id}`
      return api.patch(`${base}/questions/${question.id}/responses/${response!.id}`, { aiScore })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['student-activity', classId, studentId] })
      qc.invalidateQueries({ queryKey: ['gradebook', classId] })
    },
  })

  if (!question.counted || !response) {
    return <ScoreChip score={question.score} counted={question.counted} />
  }

  return (
    <div className="shrink-0">
      <ScoreBadge
        score={question.score}
        onChange={(score) => mutation.mutate(score)}
        pending={mutation.isPending}
        // Both student views sit the score at the right edge of a scrolling pane.
        panelSide="left"
      />
      {mutation.isError && <p className="text-[10px] text-red-500 mt-1 text-right">Not saved — try again</p>}
    </div>
  )
}
