import type { GradebookSession, GradebookStudentRow } from 'shared'

interface Props {
  sessions: GradebookSession[]
  students: GradebookStudentRow[]
  onCellClick?: (studentId: string, sessionId: string) => void
  onStudentClick?: (studentId: string, netId: string) => void
}

function scoreCell(earned: number, max: number) {
  if (max === 0) return { label: '—', className: 'text-gray-300' }
  if (earned === max) return { label: `${earned.toFixed(1)}/${max}`, className: 'bg-green-50 text-green-800' }
  if (earned === 0) return { label: `0/${max}`, className: 'text-gray-300' }
  return { label: `${earned.toFixed(1)}/${max}`, className: 'text-gray-700' }
}

export default function GradebookTable({ sessions, students, onCellClick, onStudentClick }: Props) {
  const hasSections = students.some((s) => s.section !== null)
  const sorted = [...students].sort((a, b) => a.netId.localeCompare(b.netId))

  if (students.length === 0) {
    return <p className="text-sm text-gray-400 text-center py-12">No students enrolled yet.</p>
  }
  if (sessions.length === 0) {
    return <p className="text-sm text-gray-400 text-center py-12">No graded sessions yet.</p>
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200">
      <table className="text-sm border-collapse min-w-full">
        <thead>
          <tr className="bg-gray-50 border-b border-gray-200">
            {/* Sticky NetID */}
            <th className="sticky left-0 z-10 bg-gray-50 text-left px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wide whitespace-nowrap border-r border-gray-200">
              NetID
            </th>
            {hasSections && (
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wide whitespace-nowrap">
                Section
              </th>
            )}
            {sessions.map((s) => (
              <th
                key={s.id}
                title={s.title}
                className="px-3 py-2 text-center min-w-[80px] max-w-[120px]"
              >
                <p className="text-xs font-medium text-gray-700 truncate max-w-[110px]">
                  {s.title.length > 14 ? s.title.slice(0, 13) + '…' : s.title}
                </p>
                <span className={`mt-0.5 inline-block text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
                  s.type === 'IN_CLASS'
                    ? 'bg-green-100 text-green-700'
                    : 'bg-blue-50 text-blue-600'
                }`}>
                  {s.type === 'IN_CLASS' ? 'Live' : 'HW'}
                </span>
              </th>
            ))}
            <th className="px-4 py-3 text-center text-xs font-medium text-gray-400 uppercase tracking-wide whitespace-nowrap border-l border-gray-100">
              P Total
            </th>
            <th className="px-4 py-3 text-center text-xs font-medium text-gray-400 uppercase tracking-wide whitespace-nowrap">
              HW Total
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((student, rowIdx) => (
            <tr
              key={student.studentId}
              className={rowIdx % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'}
            >
              {/* Sticky NetID */}
              <td
                className={`sticky left-0 z-10 px-4 py-2.5 font-mono font-medium whitespace-nowrap border-r border-gray-100 ${rowIdx % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'} ${onStudentClick ? 'cursor-pointer text-primary-700 hover:underline' : 'text-gray-800'}`}
                onClick={() => onStudentClick?.(student.studentId, student.netId)}
              >
                {student.netId}
              </td>
              {hasSections && (
                <td className="px-4 py-2.5 text-gray-500 whitespace-nowrap">
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
                    className={`px-3 py-2.5 text-center text-xs font-medium ${className} ${clickable ? 'cursor-pointer hover:opacity-70' : ''}`}
                    onClick={clickable ? () => onCellClick(student.studentId, s.id) : undefined}
                  >
                    {label}
                  </td>
                )
              })}
              {/* P Total */}
              {(() => {
                const { label, className } = scoreCell(student.participationTotal, student.participationMax)
                return (
                  <td className={`px-4 py-2.5 text-center text-xs font-semibold border-l border-gray-100 ${className}`}>
                    {label}
                  </td>
                )
              })()}
              {/* HW Total */}
              {(() => {
                const { label, className } = scoreCell(student.hwTotal, student.hwMax)
                return (
                  <td className={`px-4 py-2.5 text-center text-xs font-semibold ${className}`}>
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
