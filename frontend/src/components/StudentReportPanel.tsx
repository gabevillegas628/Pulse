import { useQuery } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { api } from '@/api/client'
import type { ActivitySession } from 'shared'

interface Props {
  classId: string
  studentId: string
  netId: string
  onClose: () => void
}

function scoreChip(type: string, correctAnswer: string | null, responseText: string, aiScore: number | null) {
  if (type === 'MULTIPLE_CHOICE' || type === 'YES_NO') {
    if (!correctAnswer) return null
    const correct = responseText === correctAnswer
    return (
      <span className={`shrink-0 text-xs font-medium px-2 py-0.5 rounded-full border ${correct ? 'bg-green-100 text-green-700 border-green-200' : 'bg-yellow-100 text-yellow-700 border-yellow-200'}`}>
        {correct ? '1.0' : '0.5'}
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
      <span className={`shrink-0 text-xs font-medium px-2 py-0.5 rounded-full border ${color}`}>
        {aiScore.toFixed(1)}
      </span>
    )
  }
  return null
}

export default function StudentReportPanel({ classId, studentId, netId, onClose }: Props) {
  const { data, isLoading } = useQuery<ActivitySession[]>({
    queryKey: ['student-activity', classId, studentId],
    queryFn: () => api.get(`/classes/${classId}/students/${studentId}/activity`).then((r) => r.data.data.sessions),
  })

  const participation = data?.filter((s) => s.type !== 'HOMEWORK') ?? []
  const homework = data?.filter((s) => s.type === 'HOMEWORK') ?? []

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />

      {/* Panel */}
      <div className="fixed right-0 top-0 h-full w-[480px] max-w-full bg-white shadow-2xl z-50 flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 shrink-0">
          <div>
            <p className="font-semibold text-gray-900 font-mono text-lg">{netId}</p>
            <p className="text-xs text-gray-400 mt-0.5">Student report</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 px-6 py-5">
          {isLoading && <p className="text-sm text-gray-400 text-center py-12">Loading…</p>}

          {!isLoading && data?.length === 0 && (
            <p className="text-sm text-gray-400 text-center py-12">No sessions yet.</p>
          )}

          {!isLoading && data && (
            <div className="space-y-8">
              {participation.length > 0 && (
                <section>
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">Participation</p>
                  <SessionList sessions={participation} />
                </section>
              )}
              {homework.length > 0 && (
                <section>
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">Homework</p>
                  <SessionList sessions={homework} />
                </section>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  )
}

function SessionList({ sessions }: { sessions: ActivitySession[] }) {
  return (
    <div className="space-y-5">
      {sessions.map((session) => (
        <div key={session.id}>
          <p className="text-sm font-semibold text-gray-800 mb-2">{session.title}</p>
          <div className="space-y-3 pl-1">
            {session.questions.map((q) => (
              <div key={q.id} className="space-y-1">
                <div className="flex items-start gap-2">
                  <span className="shrink-0 text-xs font-semibold text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded mt-0.5">
                    Q{q.number}
                  </span>
                  <p className="text-xs text-gray-500 leading-snug">{q.text}</p>
                </div>
                {q.response ? (
                  <div className="ml-7 flex items-start justify-between gap-2">
                    <p className="text-sm text-gray-900 leading-relaxed flex-1">{q.response.responseText}</p>
                    {scoreChip(q.type, q.correctAnswer, q.response.responseText, q.response.aiScore)}
                  </div>
                ) : (
                  <p className="ml-7 text-xs text-gray-300 italic">No response</p>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
