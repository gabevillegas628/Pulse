import { useQuery } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { api } from '@/api/client'
import type { ActivitySession, GradebookSession } from 'shared'

interface Props {
  classId: string
  studentId: string
  netId: string
  session: GradebookSession
  onClose: () => void
}

function scoreChip(type: string, correctAnswer: string | null, responseText: string, aiScore: number | null) {
  if (type === 'MULTIPLE_CHOICE' || type === 'YES_NO') {
    if (!correctAnswer) return null
    const correct = responseText === correctAnswer
    return (
      <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${correct ? 'bg-green-100 text-green-700 border-green-200' : 'bg-yellow-100 text-yellow-700 border-yellow-200'}`}>
        {correct ? '1.0' : '0.5'} pt
      </span>
    )
  }
  if (type === 'FREE_TEXT' && aiScore !== null) {
    const color = aiScore === 1.0
      ? 'bg-green-100 text-green-700 border-green-200'
      : aiScore === 0.5
      ? 'bg-yellow-100 text-yellow-700 border-yellow-200'
      : 'bg-red-100 text-red-600 border-red-200'
    return (
      <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${color}`}>
        {aiScore.toFixed(1)} pt
      </span>
    )
  }
  return null
}

export default function StudentSessionModal({ classId, studentId, netId, session, onClose }: Props) {
  const { data, isLoading } = useQuery<ActivitySession[]>({
    queryKey: ['student-activity', classId, studentId],
    queryFn: () => api.get(`/classes/${classId}/students/${studentId}/activity`).then((r) => r.data.data.sessions),
  })

  const sessionData = data?.find((s) => s.id === session.id)

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 shrink-0">
          <div>
            <p className="font-semibold text-gray-900 font-mono">{netId}</p>
            <p className="text-sm text-gray-500">{session.title}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto px-6 py-4 space-y-4">
          {isLoading && <p className="text-sm text-gray-400 text-center py-8">Loading…</p>}
          {!isLoading && !sessionData && (
            <p className="text-sm text-gray-400 text-center py-8">No data for this session.</p>
          )}
          {sessionData && sessionData.questions.map((q) => (
            <div key={q.id} className="space-y-1.5">
              <div className="flex items-start gap-2">
                <span className="shrink-0 text-xs font-semibold text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded mt-0.5">
                  Q{q.number}
                </span>
                <p className="text-sm text-gray-700">{q.text}</p>
              </div>
              {q.response ? (
                <div className="ml-7 flex items-start justify-between gap-3">
                  <p className="text-sm text-gray-900 leading-relaxed flex-1">{q.response.responseText}</p>
                  {scoreChip(q.type, q.correctAnswer, q.response.responseText, q.response.aiScore)}
                </div>
              ) : (
                <p className="ml-7 text-sm text-gray-300 italic">No response</p>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
