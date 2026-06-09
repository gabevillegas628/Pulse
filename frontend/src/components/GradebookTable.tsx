import { useState } from 'react'
import type { GradebookSession, GradebookStudentRow } from 'shared'

interface Props {
  sessions: GradebookSession[]
  students: GradebookStudentRow[]
  onCellClick?: (studentId: string, sessionId: string) => void
  onStudentClick?: (studentId: string, netId: string) => void
}

const RISK_THRESHOLD = 0.5

function scoreCell(earned: number, max: number) {
  if (max === 0) return { label: '—', className: 'text-hairline-strong' }
  if (earned === max) return { label: `${earned.toFixed(1)}/${max}`, className: 'bg-good-soft text-good' }
  if (earned === 0) return { label: `0/${max}`, className: 'text-muted' }
  return { label: `${earned.toFixed(1)}/${max}`, className: 'text-ink-2' }
}

function StatChip({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex flex-col items-center px-4 py-2.5 min-w-[80px]">
      <span className={`text-base font-bold font-mono leading-none ${accent ? 'text-signal' : 'text-ink'}`}>{value}</span>
      <span className="text-[10px] text-muted mt-1 uppercase tracking-wide whitespace-nowrap">{label}</span>
    </div>
  )
}

export default function GradebookTable({ sessions, students, onCellClick, onStudentClick }: Props) {
  const [selectedSection, setSelectedSection] = useState<string | null>(null)

  if (students.length === 0) {
    return <p className="text-sm text-muted text-center py-12">No students enrolled yet.</p>
  }
  if (sessions.length === 0) {
    return <p className="text-sm text-muted text-center py-12">No graded sessions yet.</p>
  }

  // ── Section filter ──────────────────────────────────────────────────────────
  const sections = [...new Set(students.map((s) => s.section).filter(Boolean))] as string[]
  const hasSections = sections.length > 0

  const filteredStudents = selectedSection
    ? students.filter((s) => s.section === selectedSection)
    : students
  const sorted = [...filteredStudents].sort((a, b) => a.netId.localeCompare(b.netId))

  // ── Summary stats (computed from ALL students, not just filtered) ───────────
  const inClassCount = sessions.filter((s) => s.type === 'IN_CLASS').length
  const participatingStudents = students.filter((s) => s.participationMax > 0)
  const avgParticipation = participatingStudents.length > 0
    ? participatingStudents.reduce((sum, s) => sum + s.participationTotal / s.participationMax, 0) / participatingStudents.length
    : null
  const hwStudents = students.filter((s) => s.hwMax > 0)
  const avgHomework = hwStudents.length > 0
    ? hwStudents.reduce((sum, s) => sum + s.hwTotal / s.hwMax, 0) / hwStudents.length
    : null
  const atRiskCount = participatingStudents.filter(
    (s) => s.participationTotal / s.participationMax < RISK_THRESHOLD
  ).length

  return (
    <div className="space-y-3">
      {/* ── Summary strip ──────────────────────────────────────────────────── */}
      <div className="bg-surface border border-hairline rounded-[14px] flex items-stretch divide-x divide-hairline overflow-hidden">
        {avgParticipation != null && (
          <StatChip
            label="avg participation"
            value={`${Math.round(avgParticipation * 100)}%`}
            accent={avgParticipation >= 0.75}
          />
        )}
        {avgHomework != null && (
          <StatChip label="avg homework" value={`${Math.round(avgHomework * 100)}%`} />
        )}
        {inClassCount > 0 && (
          <StatChip label="openers" value={String(inClassCount)} />
        )}
        {atRiskCount > 0 && (
          <div className="flex flex-col items-center px-4 py-2.5 min-w-[80px] bg-warn-soft">
            <span className="text-base font-bold font-mono text-warn leading-none">{atRiskCount}</span>
            <span className="text-[10px] text-warn mt-1 uppercase tracking-wide whitespace-nowrap">at risk</span>
          </div>
        )}

        {/* Section filter — right-aligned inside the strip */}
        {hasSections && (
          <div className="ml-auto flex items-center px-4 gap-2">
            <span className="text-xs text-muted">Section</span>
            <select
              value={selectedSection ?? ''}
              onChange={(e) => setSelectedSection(e.target.value || null)}
              className="text-xs border border-hairline rounded px-2 py-1 bg-surface text-ink-2 focus:outline-none focus:ring-1 focus:ring-signal"
            >
              <option value="">All</option>
              {sections.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* ── Matrix ─────────────────────────────────────────────────────────── */}
      <div className="overflow-x-auto rounded-[14px] border border-hairline">
        <table className="text-sm border-collapse min-w-full">
          <thead>
            <tr className="bg-surface-2 border-b border-hairline">
              <th className="sticky left-0 z-10 bg-surface-2 text-left px-4 py-3 text-xs font-medium text-muted uppercase tracking-wide whitespace-nowrap border-r border-hairline">
                NetID
              </th>
              {hasSections && (
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase tracking-wide whitespace-nowrap">
                  Section
                </th>
              )}
              {sessions.map((s) => (
                <th
                  key={s.id}
                  title={s.title}
                  className="px-3 py-2 text-center min-w-[80px] max-w-[120px]"
                >
                  <p className="text-xs font-medium text-ink-2 truncate max-w-[110px]">
                    {s.title.length > 14 ? s.title.slice(0, 13) + '…' : s.title}
                  </p>
                  <span className={`mt-0.5 inline-block text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
                    s.type === 'IN_CLASS' ? 'bg-good-soft text-good' : 'bg-surface-2 text-ink-2'
                  }`}>
                    {s.type === 'IN_CLASS' ? 'Live' : 'HW'}
                  </span>
                </th>
              ))}
              <th className="px-4 py-3 text-center text-xs font-medium text-muted uppercase tracking-wide whitespace-nowrap border-l border-hairline">
                P Total
              </th>
              <th className="px-4 py-3 text-center text-xs font-medium text-muted uppercase tracking-wide whitespace-nowrap">
                HW Total
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((student, rowIdx) => {
              const atRisk = student.participationMax > 0 &&
                student.participationTotal / student.participationMax < RISK_THRESHOLD
              const rowBg = rowIdx % 2 === 0 ? 'bg-surface' : 'bg-surface-2/50'
              return (
                <tr key={student.studentId} className={rowBg}>
                  <td
                    className={`sticky left-0 z-10 px-4 py-2.5 font-mono font-medium whitespace-nowrap border-r border-hairline ${rowBg} ${onStudentClick ? 'cursor-pointer text-signal hover:underline' : 'text-ink'}`}
                    onClick={() => onStudentClick?.(student.studentId, student.netId)}
                  >
                    <span className="flex items-center gap-1.5">
                      {atRisk && (
                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-warn shrink-0" title="Below 50% participation" />
                      )}
                      {student.netId}
                    </span>
                  </td>
                  {hasSections && (
                    <td className="px-4 py-2.5 text-muted whitespace-nowrap">
                      {student.section ?? '—'}
                    </td>
                  )}
                  {sessions.map((s) => {
                    const sc = student.scores.find((r) => r.sessionId === s.id)
                    const { label, className } = scoreCell(sc?.earned ?? 0, sc?.max ?? 0)
                    const clickable = onCellClick && (sc?.max ?? 0) > 0
                    return (
                      <td
                        key={s.id}
                        className={`px-3 py-2.5 text-center text-xs font-mono font-medium ${className} ${clickable ? 'cursor-pointer hover:opacity-70' : ''}`}
                        onClick={clickable ? () => onCellClick(student.studentId, s.id) : undefined}
                      >
                        {label}
                      </td>
                    )
                  })}
                  {(() => {
                    const { label, className } = scoreCell(student.participationTotal, student.participationMax)
                    return (
                      <td className={`px-4 py-2.5 text-center text-xs font-mono font-semibold border-l border-hairline ${className}`}>
                        {label}
                      </td>
                    )
                  })()}
                  {(() => {
                    const { label, className } = scoreCell(student.hwTotal, student.hwMax)
                    return (
                      <td className={`px-4 py-2.5 text-center text-xs font-mono font-semibold ${className}`}>
                        {label}
                      </td>
                    )
                  })()}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
