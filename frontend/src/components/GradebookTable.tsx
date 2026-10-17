import { useState } from 'react'
import { Search, X } from 'lucide-react'
import type { GradebookSession, GradebookStudentRow } from 'shared'
import GradeDistribution, { adjustedParticipation } from '@/components/GradeDistribution'
import { SortIcon } from '@/components/ui/SortHeader'

interface Props {
  /** Keys the remembered participation reduction, which is per class. */
  classId: string
  sessions: GradebookSession[]
  students: GradebookStudentRow[]
  onCellClick?: (studentId: string, sessionId: string) => void
  onStudentClick?: (studentId: string, netId: string) => void
}

const RISK_THRESHOLD = 0.5

/** Below the threshold on the real participation totals, the same test as the row's dot. */
const isAtRisk = (s: GradebookStudentRow) =>
  s.participationMax > 0 && s.participationTotal / s.participationMax < RISK_THRESHOLD

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

/** 'netId', 'section', 'p', 'hw', or a session's id prefixed with 's:'. */
type SortKey = string
type SortDir = 'asc' | 'desc'

/** A score as a fraction, or null for "—" (nothing counted), which sorts last either way. */
const fraction = (earned: number, max: number) => (max > 0 ? earned / max : null)

const reductionKey = (classId: string) => `pulse:gradebook-reduction:${classId}`

function readReduction(classId: string): number {
  try {
    const v = parseFloat(localStorage.getItem(reductionKey(classId)) ?? '')
    return Number.isNaN(v) ? 0 : v
  } catch {
    return 0
  }
}

export default function GradebookTable({ classId, sessions, students, onCellClick, onStudentClick }: Props) {
  const [selectedSection, setSelectedSection] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [atRiskOnly, setAtRiskOnly] = useState(false)
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'netId', dir: 'asc' })
  function toggleSort(key: SortKey) {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        // Names read best A→Z; scores best highest-first.
        : { key, dir: key === 'netId' || key === 'section' ? 'asc' : 'desc' }
    )
  }
  // A view setting, not a grade: remembered on this browser so the curve a professor works
  // with survives a reload, and never sent anywhere.
  const [reduction, setReductionState] = useState(() => readReduction(classId))
  function setReduction(pct: number) {
    setReductionState(pct)
    try { localStorage.setItem(reductionKey(classId), String(pct)) } catch { /* private window */ }
  }

  if (students.length === 0) {
    return <p className="text-sm text-muted text-center py-12">No students enrolled yet.</p>
  }
  if (sessions.length === 0) {
    return <p className="text-sm text-muted text-center py-12">No graded sessions yet.</p>
  }

  // ── Section filter ──────────────────────────────────────────────────────────
  const sections = [...new Set(students.map((s) => s.section).filter(Boolean))] as string[]
  const hasSections = sections.length > 0

  const sectionStudents = selectedSection
    ? students.filter((s) => s.section === selectedSection)
    : students
  // Search narrows the rows only; the distribution keeps the whole section in view.
  const needle = query.trim().toLowerCase()
  // Counted within the section in view, so clicking the chip shows exactly that many rows.
  const atRiskCount = sectionStudents.filter(isAtRisk).length
  // Lapses on its own if a section change leaves nobody at risk, since the chip that
  // would turn it off is gone then.
  const showAtRiskOnly = atRiskOnly && atRiskCount > 0
  const visibleStudents = sectionStudents.filter((s) =>
    (!needle || s.netId.toLowerCase().includes(needle)) && (!showAtRiskOnly || isAtRisk(s)),
  )
  const sortValue = (s: GradebookStudentRow): string | number | null => {
    if (sort.key === 'netId') return s.netId
    if (sort.key === 'section') return s.section
    if (sort.key === 'p') return fraction(s.participationTotal, s.participationMax)
    if (sort.key === 'hw') return fraction(s.hwTotal, s.hwMax)
    const sc = s.scores.find((r) => r.sessionId === sort.key.slice(2))
    return sc ? fraction(sc.earned, sc.max) : null
  }
  const sorted = [...visibleStudents].sort((a, b) => {
    const va = sortValue(a)
    const vb = sortValue(b)
    // Blanks stay at the bottom in both directions; ties fall back to NetID.
    if (va === null || vb === null) {
      if (va !== vb) return va === null ? 1 : -1
    } else {
      const cmp = typeof va === 'number' && typeof vb === 'number'
        ? va - vb
        : String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' })
      if (cmp !== 0) return sort.dir === 'asc' ? cmp : -cmp
    }
    return a.netId.localeCompare(b.netId)
  })

  const sortButton = (key: SortKey, label: React.ReactNode, align: 'left' | 'center' = 'center') => (
    <button
      onClick={() => toggleSort(key)}
      aria-label={`Sort by ${typeof label === 'string' ? label : 'this column'}`}
      className={`inline-flex items-center gap-1 uppercase tracking-wide transition-colors ${
        align === 'left' ? '' : 'justify-center'
      } ${sort.key === key ? 'text-ink-2' : 'text-muted hover:text-ink-2'}`}
    >
      {label}
      <SortIcon active={sort.key === key} dir={sort.dir} />
    </button>
  )

  // ── Summary stats (computed from ALL students, not just filtered) ───────────
  const inClassCount = sessions.filter((s) => s.type === 'IN_CLASS').length
  const participatingStudents = students.filter((s) => s.participationMax > 0)
  const avgParticipation = participatingStudents.length > 0
    ? participatingStudents.reduce((sum, s) => sum + (adjustedParticipation(s, reduction) ?? 0), 0) / participatingStudents.length
    : null
  const hwStudents = students.filter((s) => s.hwMax > 0)
  const avgHomework = hwStudents.length > 0
    ? hwStudents.reduce((sum, s) => sum + s.hwTotal / s.hwMax, 0) / hwStudents.length
    : null

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
          <button
            onClick={() => setAtRiskOnly((v) => !v)}
            aria-pressed={showAtRiskOnly}
            title={showAtRiskOnly ? 'Show all students' : `Show only students below ${RISK_THRESHOLD * 100}% participation`}
            className={`flex flex-col items-center px-4 py-2.5 min-w-[80px] transition-colors ${
              showAtRiskOnly ? 'bg-warn text-surface' : 'bg-warn-soft text-warn hover:brightness-95'
            }`}
          >
            <span className="text-base font-bold font-mono leading-none">{atRiskCount}</span>
            <span className="text-[10px] mt-1 uppercase tracking-wide whitespace-nowrap">
              {showAtRiskOnly ? 'at risk · show all' : 'at risk'}
            </span>
          </button>
        )}

        {/* Search and section filter — right-aligned inside the strip */}
        <div className="ml-auto flex items-center px-4 gap-2">
          <div className="relative">
            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find NetID"
              aria-label="Find a student by NetID"
              className="w-36 text-xs border border-hairline rounded pl-6 pr-6 py-1 bg-surface text-ink-2 focus:outline-none focus:ring-1 focus:ring-signal [&::-webkit-search-cancel-button]:hidden"
            />
            {query && (
              <button
                onClick={() => setQuery('')}
                aria-label="Clear search"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted hover:text-ink"
              >
                <X size={12} />
              </button>
            )}
          </div>
          {hasSections && (
            <>
              <span className="text-xs text-muted ml-2">Section</span>
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
            </>
          )}
        </div>
      </div>

      <GradeDistribution
        students={sectionStudents}
        sectionLabel={selectedSection ? `Section ${selectedSection}` : null}
        reduction={reduction}
        onReductionChange={setReduction}
      />

      {/* ── Matrix ─────────────────────────────────────────────────────────── */}
      {/* Scrolls on its own in both directions so the header row can stick to its top;
          a sticky header cannot pin to the page from inside a horizontal scroller. */}
      <div className="overflow-auto max-h-[calc(100vh-10rem)] rounded-[14px] border border-hairline">
        <table className="text-sm border-collapse min-w-full">
          <thead>
            {/* Sticky cells lose collapsed borders, so the rule under the header is a shadow. */}
            <tr className="[&>th]:sticky [&>th]:top-0 [&>th]:bg-surface-2 [&>th]:shadow-[inset_0_-1px_0_var(--hairline)]">
              <th className="left-0 z-30 bg-surface-2 text-left px-4 py-3 text-xs font-medium text-muted uppercase tracking-wide whitespace-nowrap border-r border-hairline">
                {sortButton('netId', 'NetID', 'left')}
              </th>
              {hasSections && (
                <th className="z-20 text-left px-4 py-3 text-xs font-medium text-muted uppercase tracking-wide whitespace-nowrap">
                  {sortButton('section', 'Section', 'left')}
                </th>
              )}
              {sessions.map((s) => (
                <th
                  key={s.id}
                  title={s.title}
                  className="z-20 px-3 py-2 text-center min-w-[80px] max-w-[120px]"
                >
                  <button
                    onClick={() => toggleSort(`s:${s.id}`)}
                    aria-label={`Sort by ${s.title}`}
                    className="inline-flex items-center gap-1 max-w-[110px] text-xs font-medium text-ink-2 hover:text-ink transition-colors"
                  >
                    <span className="truncate">{s.title.length > 14 ? s.title.slice(0, 13) + '…' : s.title}</span>
                    <SortIcon active={sort.key === `s:${s.id}`} dir={sort.dir} />
                  </button>
                  <br />
                  <span className={`mt-0.5 inline-block text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
                    s.type === 'IN_CLASS' ? 'bg-good-soft text-good' : 'bg-surface-2 text-ink-2'
                  }`}>
                    {s.type === 'IN_CLASS' ? 'Live' : 'HW'}
                  </span>
                </th>
              ))}
              <th className="z-20 px-4 py-3 text-center text-xs font-medium text-muted uppercase tracking-wide whitespace-nowrap border-l border-hairline">
                {sortButton('p', 'P Total')}
              </th>
              <th className="z-20 px-4 py-3 text-center text-xs font-medium text-muted uppercase tracking-wide whitespace-nowrap">
                {sortButton('hw', 'HW Total')}
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr>
                <td colSpan={sessions.length + (hasSections ? 4 : 3)} className="px-4 py-8 text-center text-sm text-muted">
                  No {showAtRiskOnly ? 'at-risk ' : ''}NetID matches “{query.trim()}”{selectedSection ? ` in section ${selectedSection}` : ''}.
                </td>
              </tr>
            )}
            {sorted.map((student, rowIdx) => {
              const atRisk = isAtRisk(student)
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
