import { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Flag, Search } from 'lucide-react'
import { calcResponseScore } from '@/lib/scoring'
import StructureRenderer from '@/components/StructureRenderer'
import ScoreBadge from '@/components/session/ScoreBadge'
import type { ResponseFilter } from '@/components/session/GradingToolbar'
import type { QuestionWithResponses } from 'shared'

type SortKey = 'score' | 'student' | 'time'
type Sort = { key: SortKey; dir: 'asc' | 'desc' }

/**
 * A sortable column heading.
 *
 * Module scope on purpose: defined inside the table body it took a new identity on every
 * render, so React remounted these cells whenever the sort changed and the button you had
 * just used lost focus.
 */
function SortHeader({ label, k, sort, onSort }: {
  label: string
  k: SortKey
  sort: Sort
  onSort: (next: (s: Sort) => Sort) => void
}) {
  const active = sort.key === k
  return (
    <th className="text-left px-3 py-2 text-xs font-medium uppercase tracking-wide whitespace-nowrap">
      <button
        onClick={() => onSort((s) => ({ key: k, dir: s.key === k && s.dir === 'asc' ? 'desc' : 'asc' }))}
        className={`inline-flex items-center gap-1 transition-colors ${active ? 'text-ink-2' : 'text-muted hover:text-ink-2'}`}
      >
        {label}
        {active && (sort.dir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
      </button>
    </th>
  )
}

/** Types whose answer is a sentence rather than a token, so it needs room and a clamp. */
const LONG_ANSWER = ['FREE_TEXT', 'STRUCTURE']

/**
 * A response as a reader wants it, rather than as it is stored.
 *
 * Three types were showing their raw column on this page: multi-select and ordering as
 * JSON arrays, and structure as the InChI string it is compared by. The assignment side
 * renders structures properly; this page never did.
 */
function formatAnswer(question: QuestionWithResponses, text: string): string {
  if (question.type === 'MULTI_SELECT' || question.type === 'ORDERING') {
    try {
      const arr = JSON.parse(text)
      if (Array.isArray(arr)) return arr.join(question.type === 'ORDERING' ? ' → ' : ', ')
    } catch { /* stored value is not an array; show it as-is */ }
  }
  return text
}

interface Props {
  question: QuestionWithResponses
  /** Socket-fresh grader reasons, which beat the stored ones during a run. */
  gradeReasons: Record<string, string>
  filter: ResponseFilter
  onScoreChange: (responseId: string, aiScore: number) => void
  isScorePending: boolean
}

/**
 * The responses to one question, as a table.
 *
 * They were a stack of bordered cards, one per response, each spending roughly 90px to
 * carry an eighteen-word answer and four pieces of metadata at competing sizes. At two
 * hundred responses that is a scroll nobody reads, with no way to sort it, no way to find
 * a student in it, and the answer — the only part that matters — indistinguishable from
 * the chrome around it.
 *
 * Sorted by score ascending by default, because the responses a professor has to actually
 * look at are the ones that did not get full credit. Unscored rows sort with the zeros:
 * both mean unfinished business, and "newest first" was never the order anyone graded in.
 *
 * No virtualisation. Eight hundred rows is noticeable and not broken, and sorting plus
 * search is the cheaper fix for the same complaint. Worth measuring before adding a
 * windowing dependency to a page this redesign just finished simplifying.
 */
export default function ResponseTable({
  question, gradeReasons, filter, onScoreChange, isScorePending,
}: Props) {
  const [sort, setSort] = useState<Sort>({ key: 'score', dir: 'asc' })
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const isLong = LONG_ANSWER.includes(question.type)

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    let list = question.responses.filter((r) => {
      if (filter === 'short' && !r.isFlagged) return false
      if (filter === 'review') {
        const s = calcResponseScore(question, r)
        if (s === null || s >= 1.0) return false
      }
      if (q && !r.student.netId.toLowerCase().includes(q) && !r.responseText.toLowerCase().includes(q)) {
        return false
      }
      return true
    })

    const dir = sort.dir === 'asc' ? 1 : -1
    list = [...list].sort((a, b) => {
      if (sort.key === 'student') return a.student.netId.localeCompare(b.student.netId) * dir
      if (sort.key === 'time') {
        return (new Date(a.submittedAt).getTime() - new Date(b.submittedAt).getTime()) * dir
      }
      // Unscored sorts alongside zero rather than off the end: ascending means "what
      // still needs me", and nothing-yet belongs with the worst, not after the best.
      const sa = calcResponseScore(question, a) ?? -1
      const sb = calcResponseScore(question, b) ?? -1
      if (sa === sb) return new Date(a.submittedAt).getTime() - new Date(b.submittedAt).getTime()
      return (sa - sb) * dir
    })
    return list
  }, [question, filter, query, sort])

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (question.responses.length === 0) return null

  const sortProps = { sort, onSort: setSort }

  return (
    <div className="bg-surface border border-hairline rounded-[14px]">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-hairline rounded-t-[14px]">
        <Search size={13} className="text-muted shrink-0" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find a student or an answer…"
          className="flex-1 min-w-0 bg-transparent text-sm text-ink placeholder:text-muted focus:outline-none"
        />
        <span className="text-[11px] text-muted font-mono shrink-0">
          {rows.length === question.responses.length
            ? `${rows.length}`
            : `${rows.length} of ${question.responses.length}`}
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="px-3 py-6 text-sm text-muted text-center">Nothing matches that.</p>
      ) : (
        <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-2 border-b border-hairline">
                <SortHeader label="Student" k="student" {...sortProps} />
                <SortHeader label="Score" k="score" {...sortProps} />
                <SortHeader label="Time" k="time" {...sortProps} />
                <th className="text-left px-3 py-2 text-xs font-medium text-muted uppercase tracking-wide w-full">
                  Answer
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const score = calcResponseScore(question, r)
                const why = gradeReasons[r.id] || r.aiReason
                const isOpen = expanded.has(r.id)
                const answer = formatAnswer(question, r.responseText)
                return (
                  <tr
                    key={r.id}
                    className={`border-b border-hairline last:border-b-0 align-top ${
                      r.isFlagged ? 'bg-warn-soft/40' : ''
                    }`}
                  >
                    <td className="px-3 py-2 font-mono text-ink whitespace-nowrap">
                      <span className="inline-flex items-center gap-1.5">
                        {r.student.netId}
                        {r.isFlagged && (
                          <span title="Under ten words" className="text-warn">
                            <Flag size={10} />
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {score === null ? (
                        <span className="text-xs text-hairline-strong font-mono">—</span>
                      ) : (
                        <ScoreBadge
                          score={score}
                          reason={why}
                          pending={isScorePending}
                          onChange={(aiScore) => onScoreChange(r.id, aiScore)}
                        />
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-hairline-strong font-mono whitespace-nowrap">
                      {new Date(r.submittedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </td>
                    <td className="px-3 py-2 text-ink-2 break-words">
                      {isLong ? (
                        <>
                          <button
                            onClick={() => toggle(r.id)}
                            aria-expanded={isOpen}
                            className="flex items-start gap-1.5 text-left w-full group"
                          >
                            <span className="mt-0.5 shrink-0 text-hairline-strong group-hover:text-muted">
                              {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                            </span>
                            <span className={`leading-relaxed ${isOpen ? '' : 'line-clamp-2'}`}>
                              {answer}
                            </span>
                          </button>
                          {isOpen && question.type === 'STRUCTURE' && (
                            // Only once opened: a thumbnail per row would be one Indigo
                            // render request per response.
                            <div className="mt-2 ml-5">
                              <StructureRenderer inchi={r.responseText} width={200} height={130} />
                            </div>
                          )}
                          {isOpen && why && score !== null && score < 1.0 && (
                            <p className="mt-2 ml-5 pt-2 border-t border-hairline text-[11px] text-muted leading-snug">
                              <span className="font-medium">AI:</span> {why}
                            </p>
                          )}
                        </>
                      ) : (
                        <span className="leading-relaxed">{answer}</span>
                      )}
                    </td>
                  </tr>
                )
              })}
          </tbody>
        </table>
      )}
    </div>
  )
}
