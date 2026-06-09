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

function scoreChip(score: number) {
  const color = score >= 1.0
    ? 'bg-good-soft text-good border-good/20'
    : score >= 0.5
    ? 'bg-warn-soft text-warn border-warn/20'
    : 'bg-red-100 text-red-600 border-red-200'
  return (
    <span className={`text-xs font-mono font-medium px-2 py-0.5 rounded-full border ${color}`}>
      {score.toFixed(1)} pt
    </span>
  )
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
        className="bg-surface rounded-[14px] border border-hairline shadow-pop w-full max-w-lg max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-hairline shrink-0">
          <div>
            <p className="font-semibold text-ink font-mono">{netId}</p>
            <p className="text-sm text-muted">{session.title}</p>
          </div>
          <button onClick={onClose} className="text-muted hover:text-ink-2 transition-colors">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto px-6 py-4 space-y-4">
          {isLoading && <p className="text-sm text-muted text-center py-8">Loading…</p>}
          {!isLoading && !sessionData && (
            <p className="text-sm text-muted text-center py-8">No data for this session.</p>
          )}
          {sessionData && sessionData.questions.map((q) => (
            <div key={q.id} className={`space-y-1.5 ${!q.counted ? 'opacity-60' : ''}`}>
              <div className="flex items-start gap-2">
                <span className="shrink-0 text-xs font-semibold text-muted bg-surface-2 px-1.5 py-0.5 rounded mt-0.5">
                  Q{q.number}
                </span>
                <div className="flex-1 flex items-start justify-between gap-2">
                  <p className="text-sm text-ink-2">{q.text}</p>
                  {!q.counted && (
                    <span className="shrink-0 text-[10px] font-medium text-muted border border-hairline px-1.5 py-0.5 rounded-full whitespace-nowrap">
                      not graded
                    </span>
                  )}
                </div>
              </div>
              {q.response ? (
                <div className="ml-7 flex items-start justify-between gap-3">
                  <p className="text-sm text-ink leading-relaxed flex-1">{q.response.responseText}</p>
                  {q.counted && q.score !== null && scoreChip(q.score)}
                </div>
              ) : (
                <p className="ml-7 text-sm text-hairline-strong italic">No response</p>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
