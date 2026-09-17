import { useQuery } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { api } from '@/api/client'
import type { ActivitySession } from 'shared'
import ScoreChip, { sessionTotal } from '@/components/ScoreChip'

interface Props {
  classId: string
  studentId: string
  netId: string
  onClose: () => void
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
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />

      <div className="fixed right-0 top-0 h-full w-[480px] max-w-full bg-surface shadow-pop z-50 flex flex-col border-l border-hairline">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-hairline shrink-0">
          <div>
            <p className="font-semibold text-ink font-mono text-lg">{netId}</p>
            <p className="text-xs text-muted mt-0.5">Student report</p>
          </div>
          <button onClick={onClose} className="text-muted hover:text-ink-2 transition-colors">
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 px-6 py-5">
          {isLoading && <p className="text-sm text-muted text-center py-12">Loading…</p>}

          {!isLoading && data?.length === 0 && (
            <p className="text-sm text-muted text-center py-12">No sessions yet.</p>
          )}

          {!isLoading && data && (
            <div className="space-y-8">
              {participation.length > 0 && (
                <section>
                  <p className="text-xs font-semibold text-muted uppercase tracking-wide mb-3">Participation</p>
                  <SessionList sessions={participation} />
                </section>
              )}
              {homework.length > 0 && (
                <section>
                  <p className="text-xs font-semibold text-muted uppercase tracking-wide mb-3">Homework</p>
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
      {sessions.map((session) => {
        const total = sessionTotal(session.questions)
        return (
          <div key={session.id}>
            <div className="flex items-baseline justify-between gap-2 mb-2">
              <p className="text-sm font-semibold text-ink">{session.title}</p>
              <span className="shrink-0 text-xs font-mono text-muted">
                {total.max > 0 ? `${total.earned}/${total.max}` : 'not graded'}
              </span>
            </div>
            <div className="space-y-3 pl-1">
              {session.questions.map((q) => (
                <div key={q.id} className={`space-y-1 ${!q.counted ? 'opacity-60' : ''}`}>
                  <div className="flex items-start gap-2">
                    <span className="shrink-0 text-xs font-semibold text-muted bg-surface-2 px-1.5 py-0.5 rounded mt-0.5">
                      Q{q.number}
                    </span>
                    <p className="text-xs text-muted leading-snug">{q.text}</p>
                  </div>
                  {q.response ? (
                    <div className="ml-7 flex items-start justify-between gap-2">
                      <p className="text-sm text-ink leading-relaxed flex-1">{q.response.responseText}</p>
                      <ScoreChip score={q.score} counted={q.counted} />
                    </div>
                  ) : (
                    <p className="ml-7 text-xs text-hairline-strong italic">No response</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
