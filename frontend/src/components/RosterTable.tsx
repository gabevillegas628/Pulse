import { Fragment, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '@/api/client'
import Pill from '@/components/ui/Pill'
import Empty from '@/components/ui/Empty'
import { ChevronDown, KeyRound, Trash2, Users } from 'lucide-react'
import type { StudentStats, ActivitySession } from 'shared'
import { statusPill } from '@/lib/status'

/**
 * The class roster: who is enrolled, which section they are in, and what they have answered.
 *
 * Lifted out of `ClassPage`, which carried it inline among four other tabs. The row detail
 * fetches per student and caches, so it owns that state rather than passing it upward; the
 * two destructive actions stay the page's business, since the dialogs that confirm them do.
 */

export interface RosterStudent {
  id: string
  netId: string
  name: string
  email: string
}

interface RosterSection {
  id: string
  name: string
}

interface RosterEntry {
  student: RosterStudent
  stats: StudentStats
  section: { id: string; name: string } | null
}

interface Props {
  classId: string
  /** Undefined while loading — the empty states live here rather than at the call site. */
  entries: RosterEntry[] | undefined
  sections: RosterSection[]
  onResetPassword: (student: RosterStudent) => void
  onRemove: (student: RosterStudent) => void
}

export default function RosterTable({ classId, entries, sections, onResetPassword, onRemove }: Props) {
  const qc = useQueryClient()
  const [expandedStudent, setExpandedStudent] = useState<string | null>(null)
  const [activityCache, setActivityCache] = useState<Record<string, ActivitySession[]>>({})

  async function assignSection(studentId: string, sectionId: string | null) {
    await api.patch(`/classes/${classId}/enrollments/${studentId}/section`, { sectionId })
    qc.invalidateQueries({ queryKey: ['roster', classId] })
  }

  if (!entries) return <Empty icon={Users} message="Loading roster…" />
  if (entries.length === 0) return <Empty icon={Users} message="No students enrolled yet." />

  const hasSections = sections.length > 0

  return (
    <div className="bg-surface border border-hairline rounded-[14px] overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-hairline text-left">
            <th className="px-5 py-3 text-xs font-medium text-muted uppercase tracking-wide">NetID</th>
            <th className="px-5 py-3 text-xs font-medium text-muted uppercase tracking-wide">Email</th>
            {hasSections && <th className="px-5 py-3 text-xs font-medium text-muted uppercase tracking-wide">Section</th>}
            <th className="px-5 py-3 text-xs font-medium text-muted uppercase tracking-wide">Participation</th>
            <th className="px-5 py-3"></th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => {
            const isExpanded = expandedStudent === e.student.id
            const activity = activityCache[e.student.id]

            async function toggleExpand() {
              if (isExpanded) { setExpandedStudent(null); return }
              setExpandedStudent(e.student.id)
              if (!activityCache[e.student.id]) {
                const res = await api.get(`/classes/${classId}/students/${e.student.id}/activity`)
                setActivityCache((prev) => ({ ...prev, [e.student.id]: res.data.data.sessions }))
              }
            }

            return (
              // Keyed on the Fragment, which is the array element. The keys used to sit on
              // the rows inside it, leaving the element React actually reconciles without
              // one — a warning today, and a real mix-up the moment rows reorder.
              <Fragment key={e.student.id}>
                <tr
                  onClick={toggleExpand}
                  className="border-t border-hairline hover:bg-surface-2 cursor-pointer"
                >
                  <td className="px-5 py-3.5 font-medium text-ink flex items-center gap-1.5">
                    <ChevronDown size={14} className={`text-hairline-strong transition-transform shrink-0 ${isExpanded ? 'rotate-180' : ''}`} />
                    {e.student.netId}
                  </td>
                  <td className="px-5 py-3.5 text-ink-2">{e.student.email}</td>
                  {hasSections && (
                    <td className="px-5 py-3.5" onClick={(ev) => ev.stopPropagation()}>
                      <select
                        value={e.section?.id ?? ''}
                        onChange={(ev) => assignSection(e.student.id, ev.target.value || null)}
                        className="text-xs border border-hairline rounded px-1.5 py-1 bg-surface text-ink-2 focus:outline-none focus:ring-1 focus:ring-signal"
                      >
                        <option value="">— unassigned</option>
                        {sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                    </td>
                  )}
                  <td className="px-5 py-3.5 text-ink-2">
                    {e.stats.totalClosedSessions > 0 ? (
                      <span className={e.stats.sessionsParticipated === 0 ? 'text-muted' : ''}>
                        {e.stats.sessionsParticipated}/{e.stats.totalClosedSessions} sessions
                      </span>
                    ) : (
                      <span className="text-hairline-strong">—</span>
                    )}
                  </td>
                  <td className="px-5 py-3.5 text-right" onClick={(ev) => ev.stopPropagation()}>
                    <div className="flex items-center justify-end gap-3">
                      <button
                        onClick={() => onResetPassword(e.student)}
                        className="flex items-center gap-1.5 text-xs text-muted hover:text-signal transition-colors"
                      >
                        <KeyRound size={13} /> Reset password
                      </button>
                      <button
                        onClick={() => onRemove(e.student)}
                        className="flex items-center gap-1.5 text-xs text-muted hover:text-red-500 transition-colors"
                      >
                        <Trash2 size={13} /> Remove
                      </button>
                    </div>
                  </td>
                </tr>

                {isExpanded && (
                  <tr className="border-t border-hairline bg-surface-2">
                    <td colSpan={hasSections ? 5 : 4} className="px-5 py-4">
                      {!activity ? (
                        <p className="text-xs text-muted">Loading…</p>
                      ) : activity.length === 0 ? (
                        <p className="text-xs text-muted">No sessions yet.</p>
                      ) : (
                        <div className="space-y-3">
                          {activity.map((session) => (
                            <div key={session.id}>
                              <div className="flex items-center gap-2 mb-1.5">
                                <span className="text-xs font-medium text-ink-2">{session.title}</span>
                                <Pill variant={statusPill(session.status)}>
                                  {session.status.charAt(0) + session.status.slice(1).toLowerCase()}
                                </Pill>
                              </div>
                              <div className="flex flex-wrap gap-2">
                                {session.questions.map((q) => (
                                  <span
                                    key={q.id}
                                    title={q.text + (q.response ? `\n"${q.response.responseText}"` : '')}
                                    className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border ${
                                      q.response
                                        ? 'border-good/30 bg-good-soft text-good'
                                        : 'border-hairline bg-surface text-muted'
                                    }`}
                                  >
                                    Q{q.number} {q.response ? '✓' : '—'}
                                    {q.response && q.type === 'FREE_TEXT' && (
                                      <span className="text-good">{q.response.wordCount}w</span>
                                    )}
                                  </span>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
