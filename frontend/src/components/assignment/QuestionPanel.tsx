import { useState } from 'react'
import { useQueryClient, useMutation } from '@tanstack/react-query'
import { api } from '@/api/client'
import RichTextRenderer from '@/components/RichTextRenderer'
import { Layers, Trash2 } from 'lucide-react'
import type { SummaryCategory } from 'shared'
import { SessionStatus } from 'shared'
import GradingControls from './GradingControls'
import ResponseList from './ResponseList'
import { questionPreview } from './helpers'
import type { QWithGroup, GradeMutationType } from './types'

interface Props {
  q: QWithGroup
  globalIdx: number
  assignmentId: string
  sessionStatus: SessionStatus
  onConverted: (newGroupId: string) => void
  onDeleted: () => void
  gradeReasons: Record<string, string>
  gradeResult: Record<string, { failedCount: number }>
  rubricDraft: Record<string, string>
  setRubricDraft: React.Dispatch<React.SetStateAction<Record<string, string>>>
  gradeMutation: GradeMutationType
  setCorrectAnswerMutation: ReturnType<typeof useMutation<unknown, unknown, { questionId: string; correctAnswer: string | null }>>
  overrideScoreMutation: ReturnType<typeof useMutation<unknown, unknown, { questionId: string; responseId: string; aiScore: number }>>
  summarizeMutation: ReturnType<typeof useMutation<SummaryCategory[], unknown, string>>
  summary: SummaryCategory[] | null
  summaryQuestionId: string | null
  setSummary: (s: SummaryCategory[] | null) => void
  setSummaryQuestionId: (id: string | null) => void
}

export default function QuestionPanel({
  q, globalIdx, assignmentId, sessionStatus, onConverted, onDeleted,
  gradeReasons, gradeResult, rubricDraft, setRubricDraft,
  gradeMutation, setCorrectAnswerMutation, overrideScoreMutation,
  summarizeMutation, summary, summaryQuestionId, setSummary, setSummaryQuestionId,
}: Props) {
  const qc = useQueryClient()
  const isDraft = sessionStatus === SessionStatus.DRAFT
  const isGradable = sessionStatus === SessionStatus.CLOSED || sessionStatus === SessionStatus.ARCHIVED
  const isAnswerKeyEditable = isDraft || isGradable
  const [converting, setConverting] = useState(false)

  async function handleMakeMultiPart() {
    setConverting(true)
    try {
      const groupRes = await api.post(`/assignments/${assignmentId}/groups`, {
        title: questionPreview(q.text),
      })
      const newGroupId: string = groupRes.data.data.group.id
      await api.patch(`/assignments/${assignmentId}/questions/${q.id}`, { groupId: newGroupId })
      await api.post(`/assignments/${assignmentId}/questions`, { text: '', type: 'FREE_TEXT', groupId: newGroupId })
      await qc.invalidateQueries({ queryKey: ['assignment', assignmentId] })
      onConverted(newGroupId)
    } catch {
      // silent — user can retry
    } finally {
      setConverting(false)
    }
  }

  return (
    <div className="space-y-5">
      <div className="bg-white border border-gray-200 rounded-xl p-5">
        <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-2">
          Question {globalIdx + 1} · {q.type.replace('_', ' ').toLowerCase()}
        </p>
        <RichTextRenderer content={q.text} />
        {(q.type === 'MULTIPLE_CHOICE' || (q.type as string) === 'MULTI_SELECT') && Array.isArray(q.options) && (
          <div className="flex flex-wrap gap-2 mt-3">
            {(q.options as string[]).map((opt) => (
              <span key={opt} className="text-xs bg-gray-100 px-2.5 py-1 rounded-full text-gray-600">{opt}</span>
            ))}
          </div>
        )}
        {(q.type as string) === 'ORDERING' && Array.isArray(q.options) && (
          <ol className="text-xs text-gray-500 list-decimal list-inside space-y-0.5 mt-3">
            {(q.options as string[]).map((opt, i) => <li key={i}>{opt}</li>)}
          </ol>
        )}
      </div>

      {isAnswerKeyEditable && (
        <GradingControls
          q={q} rubricDraft={rubricDraft} setRubricDraft={setRubricDraft}
          gradeResult={gradeResult}
          gradeMutation={gradeMutation} setCorrectAnswerMutation={setCorrectAnswerMutation}
          summarizeMutation={summarizeMutation} summary={summary}
          summaryQuestionId={summaryQuestionId} setSummary={setSummary} setSummaryQuestionId={setSummaryQuestionId}
        />
      )}

      {summary && summaryQuestionId === q.id && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {summary.map((cat) => (
            <div key={cat.label} className="bg-blue-50 border border-blue-100 rounded-xl p-4">
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-semibold text-blue-900">{cat.label}</span>
                <span className="text-xs text-blue-500">{cat.count} student{cat.count !== 1 ? 's' : ''}</span>
              </div>
              <p className="text-xs text-blue-700">{cat.description}</p>
            </div>
          ))}
        </div>
      )}

      <ResponseList q={q} isGradable={isGradable} gradeReasons={gradeReasons} overrideScoreMutation={overrideScoreMutation} />

      {isDraft && (
        <div className="flex gap-2">
          <button
            onClick={handleMakeMultiPart}
            disabled={converting}
            className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 border border-gray-200 px-3 py-2 rounded-lg hover:bg-gray-50 disabled:opacity-50"
          >
            <Layers size={14} /> {converting ? 'Converting…' : 'Make multi-part'}
          </button>
          <button
            onClick={async () => {
              if (!confirm('Delete this question? This cannot be undone.')) return
              await api.delete(`/assignments/${assignmentId}/questions/${q.id}`)
              await qc.invalidateQueries({ queryKey: ['assignment', assignmentId] })
              onDeleted()
            }}
            className="flex items-center gap-1.5 text-sm text-red-500 hover:text-red-700 border border-red-200 px-3 py-2 rounded-lg hover:bg-red-50"
          >
            <Trash2 size={14} /> Delete
          </button>
        </div>
      )}
    </div>
  )
}
