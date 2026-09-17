import { Fragment, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/api/client'
import Pill from '@/components/ui/Pill'
import Empty from '@/components/ui/Empty'
import Switch from '@/components/ui/Switch'
import SortHeader from '@/components/ui/SortHeader'
import { ChevronDown, KeyRound, Search, Trash2, Users } from 'lucide-react'
import type { StudentStats, ActivitySession } from 'shared'
import { sessionTotal } from '@/components/ScoreChip'
import { formatScore, toneFor } from '@/components/session/ScoreBadge'
import { statusPill } from '@/lib/status'

/**
 * The class roster: who is enrolled, which section they are in, and what they have answered.
 *
 * Self-contained. It fetches its own roster and its own per-student detail, because nothing
 * outside it reads either — and because filtering that lives in one component while the query
 * lives in another is a seam you have to unpick the day filtering moves to the server. The
 * two destructive actions stay the page's business, since the dialogs that confirm them do.
 *
 * Filtering and sorting are pure derivations from the fetched list. The endpoint returns the
 * whole roster with stats attached, so none of it costs a round trip, and at class sizes that
 * fit in a lecture hall none of it is worth memoising for speed rather than for stable
 * identity.
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
  /** May answer in any section of this class, not only their own. */
  anySection: boolean
}

type SortKey = 'netId' | 'section' | 'participation'

interface Props {
  classId: string
  sections: RosterSection[]
  onResetPassword: (student: RosterStudent) => void
  onRemove: (student: RosterStudent) => void
}

/** A filter that is either on or off, styled as the signal colour when it is on. */
function FilterChip({
  active, onClick, children,
}: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`text-xs px-2.5 py-1.5 rounded-sm border transition-colors ${
        active
          ? 'border-signal bg-signal-soft text-signal font-medium'
          : 'border-hairline text-muted hover:border-hairline-strong hover:text-ink-2'
      }`}
    >
      {children}
    </button>
  )
}

export default function RosterTable({ classId, sections, onResetPassword, onRemove }: Props) {
  const qc = useQueryClient()
  const [expandedStudent, setExpandedStudent] = useState<string | null>(null)
  const [activityCache, setActivityCache] = useState<Record<string, ActivitySession[]>>({})

  const [search, setSearch] = useState('')
  /** A section id, or the two pseudo-values. */
  const [sectionFilter, setSectionFilter] = useState<string>('all')
  const [floatersOnly, setFloatersOnly] = useState(false)
  const [neverAnswered, setNeverAnswered] = useState(false)
  // netId ascending, because a roster is read to find somebody. The endpoint returns newest
  // enrolment first, which is an order no one is looking in.
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'netId', dir: 'asc' })

  // Owned here rather than passed in. No `enabled` guard is needed: this component only
  // mounts on the roster tab, so mounting is the guard.
  const { data: entries } = useQuery<RosterEntry[]>({
    queryKey: ['roster', classId],
    queryFn: () => api.get(`/classes/${classId}/enrollments`).then((r) => r.data.data.enrollments),
  })

  async function assignSection(studentId: string, sectionId: string | null) {
    await api.patch(`/classes/${classId}/enrollments/${studentId}/section`, { sectionId })
    qc.invalidateQueries({ queryKey: ['roster', classId] })
  }

  async function setAnySection(studentId: string, anySection: boolean) {
    await api.patch(`/classes/${classId}/enrollments/${studentId}/section`, { anySection })
    qc.invalidateQueries({ queryKey: ['roster', classId] })
  }

  function toggleSort(key: SortKey) {
    setSort((prev) => (prev.key === key
      ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      // Names read A→Z; a participation column is asked about from the bottom, so it opens
      // on the students who have answered least.
      : { key, dir: key === 'participation' ? 'asc' : 'asc' }))
  }

  const hasSections = sections.length > 0

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    let list = entries ?? []

    // One box over netId and email. Which of the two someone remembers a student by is not
    // knowable, and asking them to choose a field first is a worse question than the one they
    // came with. Name is deliberately absent: the endpoint does not return it.
    if (q) {
      list = list.filter((e) =>
        e.student.netId.toLowerCase().includes(q) || e.student.email.toLowerCase().includes(q))
    }
    if (sectionFilter === 'unassigned') list = list.filter((e) => !e.section)
    else if (sectionFilter !== 'all') list = list.filter((e) => e.section?.id === sectionFilter)
    if (floatersOnly) list = list.filter((e) => e.anySection)
    if (neverAnswered) list = list.filter((e) => e.stats.sessionsParticipated === 0)

    const sorted = [...list].sort((a, b) => {
      let cmp: number
      if (sort.key === 'netId') {
        cmp = a.student.netId.localeCompare(b.student.netId, undefined, { numeric: true, sensitivity: 'base' })
      } else if (sort.key === 'section') {
        cmp = (a.section?.name ?? '').localeCompare(b.section?.name ?? '', undefined, { numeric: true, sensitivity: 'base' })
      } else {
        cmp = a.stats.sessionsParticipated - b.stats.sessionsParticipated
      }
      return sort.dir === 'asc' ? cmp : -cmp
    })
    return sorted
  }, [entries, search, sectionFilter, floatersOnly, neverAnswered, sort])

  if (!entries) return <Empty icon={Users} message="Loading roster…" />
  if (entries.length === 0) return <Empty icon={Users} message="No students enrolled yet." />

  const filtered = visible.length !== entries.length

  function clearFilters() {
    setSearch('')
    setSectionFilter('all')
    setFloatersOnly(false)
    setNeverAnswered(false)
  }

  return (
    <div>
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search netID or email"
            className="w-56 text-sm border border-hairline rounded-sm pl-7 pr-2.5 py-1.5 bg-surface text-ink placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-signal"
          />
        </div>

        {hasSections && (
          <select
            value={sectionFilter}
            onChange={(e) => setSectionFilter(e.target.value)}
            className="text-sm border border-hairline rounded-sm px-2 py-1.5 bg-surface text-ink-2 focus:outline-none focus:ring-1 focus:ring-signal"
          >
            <option value="all">All sections</option>
            {sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            {/* The list a professor needs after splitting a class: everyone the rendering
                depends on having a section, who has not got one yet. */}
            <option value="unassigned">— unassigned</option>
          </select>
        )}

        {hasSections && (
          <FilterChip active={floatersOnly} onClick={() => setFloatersOnly((v) => !v)}>
            Any section
          </FilterChip>
        )}
        <FilterChip active={neverAnswered} onClick={() => setNeverAnswered((v) => !v)}>
          Never answered
        </FilterChip>

        <span className="ml-auto text-xs text-muted font-mono">
          {filtered ? `${visible.length} of ${entries.length}` : `${entries.length}`} student{entries.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Filtered down to nothing is not the same as an empty roster, and saying so is the
          difference between a filter to clear and a class to go and recruit. */}
      {visible.length === 0 ? (
        <div className="bg-surface border border-hairline rounded-[14px] px-5 py-10 text-center">
          <p className="text-sm text-muted">No students match these filters.</p>
          <button onClick={clearFilters} className="text-sm text-signal hover:underline mt-1">
            Clear filters
          </button>
        </div>
      ) : (
        <div className="bg-surface border border-hairline rounded-[14px] overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-hairline text-left">
                <SortHeader label="NetID" sortKey="netId" activeKey={sort.key} dir={sort.dir} onSort={toggleSort} />
                <th className="px-5 py-3 text-xs font-medium text-muted uppercase tracking-wide">Email</th>
                {hasSections && (
                  <SortHeader label="Section" sortKey="section" activeKey={sort.key} dir={sort.dir} onSort={toggleSort} />
                )}
                <SortHeader label="Participation" sortKey="participation" activeKey={sort.key} dir={sort.dir} onSort={toggleSort} />
                <th className="px-5 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((e) => {
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
                  // one — which sorting turns from a warning into the wrong student's detail.
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
                          <div className="flex items-center gap-2.5">
                            <select
                              value={e.section?.id ?? ''}
                              onChange={(ev) => assignSection(e.student.id, ev.target.value || null)}
                              className="text-xs border border-hairline rounded px-1.5 py-1 bg-surface text-ink-2 focus:outline-none focus:ring-1 focus:ring-signal"
                            >
                              <option value="">— unassigned</option>
                              {sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                            </select>
                            {/* Beside the select rather than in it: a floater still has a home
                                section, and that is what the roster and the participation
                                denominator count. Folding the two into one control would make
                                a floater read as unassigned. */}
                            <label className="flex items-center gap-1.5 cursor-pointer select-none">
                              <Switch
                                checked={e.anySection}
                                onChange={() => setAnySection(e.student.id, !e.anySection)}
                                ariaLabel={`${e.student.netId} may answer in any section`}
                              />
                              <span className="text-xs text-muted whitespace-nowrap">any</span>
                            </label>
                          </div>
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
                                    {(() => {
                                      const total = sessionTotal(session.questions)
                                      return total.max > 0 && (
                                        <span className="text-xs font-mono text-muted">{total.earned}/{total.max} pt</span>
                                      )
                                    })()}
                                  </div>
                                  <div className="flex flex-wrap gap-2">
                                    {session.questions.map((q) => (
                                      <span
                                        key={q.id}
                                        title={q.text + (q.response ? `\n"${q.response.responseText}"` : '')}
                                        // A graded question shows its score. An ungraded one only says it was
                                        // answered, in a neutral colour: this used to be a green ✓ for any
                                        // answer, and fifteen answers read as fifteen correct beside a
                                        // gradebook showing 10/10.
                                        className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border ${
                                          q.counted && q.score !== null
                                            ? toneFor(q.score)
                                            : q.response
                                            ? 'border-hairline-strong bg-surface text-ink-2'
                                            : 'border-hairline bg-surface text-muted'
                                        }`}
                                      >
                                        Q{q.number}{' '}
                                        {q.counted && q.score !== null
                                          ? <span className="font-mono">{formatScore(q.score)}</span>
                                          : q.response ? 'answered' : '—'}
                                        {q.response && q.type === 'FREE_TEXT' && (
                                          <span className="opacity-70">{q.response.wordCount}w</span>
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
      )}
    </div>
  )
}
