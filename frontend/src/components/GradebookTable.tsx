import type { GradebookSession, GradebookStudentRow } from 'shared'

interface Props {
  sessions: GradebookSession[]
  students: GradebookStudentRow[]
  onCellClick?: (studentId: string, sessionId: string) => void
  onStudentClick?: (studentId: string, netId: string) => void
}

function scoreCell(earned: number, max: number) {
  if (max === 0) return { label: '—', className: 'text-hairline-strong' }
  if (earned === max) return { label: `${earned.toFixed(1)}/${max}`, className: 'bg-good-soft text-good' }
  if (earned === 0) return { label: `0/${max}`, className: 'text-hairline-strong' }
  return { label: `${earned.toFixed(1)}/${max}`, className: 'text-ink-2' }
}

export default function GradebookTable({ sessions, students, onCellClick, onStudentClick }: Props) {
  const hasSections = students.some((s) => s.section !== null)
  const sorted = [...students].sort((a, b) => a.netId.localeCompare(b.netId))

  if (students.length === 0) {
    return <p className="text-sm text-muted text-center py-12">No students enrolled yet.</p>
  }
  if (sessions.length === 0) {
    return <p className="text-sm text-muted text-center py-12">No graded sessions yet.</p>
  }

  return (
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
                  s.type === 'IN_CLASS'
                    ? 'bg-good-soft text-good'
                    : 'bg-surface-2 text-ink-2'
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
          {sorted.map((student, rowIdx) => (
            <tr
              key={student.studentId}
              className={rowIdx % 2 === 0 ? 'bg-surface' : 'bg-surface-2/50'}
            >
              <td
                className={`sticky left-0 z-10 px-4 py-2.5 font-mono font-medium whitespace-nowrap border-r border-hairline ${rowIdx % 2 === 0 ? 'bg-surface' : 'bg-surface-2/50'} ${onStudentClick ? 'cursor-pointer text-signal hover:underline' : 'text-ink'}`}
                onClick={() => onStudentClick?.(student.studentId, student.netId)}
              >
                {student.netId}
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
          ))}
        </tbody>
      </table>
    </div>
  )
}
