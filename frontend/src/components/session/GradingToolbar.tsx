import { AlertCircle, Check, Flag, GraduationCap } from 'lucide-react'
import { calcResponseScore } from '@/lib/scoring'
import type { QuestionWithResponses } from 'shared'

/**
 * The response list shows everything, or one narrowing of it. Mutually exclusive on
 * purpose: two independent toggles can combine into an empty list, which reads as a bug.
 */
export type ResponseFilter = 'all' | 'review' | 'short'

interface Props {
  question: QuestionWithResponses
  /** Socket-driven progress for this question while the AI grades it, else null. */
  progress: { graded: number; total: number } | null
  /** Outcome of the last AI grading run on this question, else null. */
  result: { failedCount: number } | null
  gradeError: string | null
  isGradePending: boolean
  /** AI grading is only offered once there is a run to grade. */
  canGradeWithAi: boolean
  onGrade: (mode: 'all' | 'ungraded') => void
  onFullCredit: () => void
  isFullCreditPending: boolean
  /** Which subset of the response list is showing. */
  filter: ResponseFilter
  onFilter: (mode: ResponseFilter) => void
}

/**
 * Everything needed to grade one question, in one bar that stays put while you scroll
 * the responses it acts on.
 *
 * These controls were spread down four separate stretches of the page: the average and
 * "give all full credit" in a summary line, the AI grade buttons in their own block
 * below it, the needs-review filter below that, and the per-response scores in the list
 * itself. Grading one question meant travelling through all four.
 *
 * Presentational on purpose — the socket that drives `progress` and `result` belongs to
 * the page, so this takes values and callbacks rather than owning mutations.
 */
export default function GradingToolbar({
  question, progress, result, gradeError, isGradePending, canGradeWithAi,
  onGrade, onFullCredit, isFullCreditPending, filter, onFilter,
}: Props) {
  const total = question.responses.length
  if (total === 0) return null

  const scores = question.responses
    .map((r) => calcResponseScore(question, r))
    .filter((s): s is number => s !== null)
  const avg = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null

  const needsReview = question.responses.filter((r) => {
    const s = calcResponseScore(question, r)
    return s !== null && s < 1.0
  }).length

  // Short answers are flagged on submit, free text only, under ten words. The only
  // aggregate of that anywhere — and under effort grading they are what loses credit,
  // so the count is worth having before grading rather than after.
  const shortCount = question.responses.filter((r) => r.isFlagged).length

  const ungraded = question.responses.filter((r) => r.aiScore === null).length
  const isFreeText = question.type === 'FREE_TEXT'
  const showAi = isFreeText && canGradeWithAi
  // Offered only when it would do something different from "grade all".
  const showUngradedOnly = ungraded > 0 && (ungraded < total || !!result)

  return (
    <div className="sticky top-0 z-20 mb-4 bg-surface border border-hairline rounded-[14px] px-3 py-2">
      {progress ? (
        <div className="flex items-center gap-3 py-1">
          <div className="flex-1 h-1.5 rounded-full bg-surface-2 overflow-hidden">
            <div
              className="h-full rounded-full bg-good transition-all duration-300"
              style={{ width: `${Math.round((progress.graded / progress.total) * 100)}%` }}
            />
          </div>
          <span className="text-xs text-muted font-mono shrink-0">
            Grading {progress.graded} / {progress.total}
          </span>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <p className="text-xs text-muted font-mono">
            {avg !== null
              ? <>{scores.length} of {total} scored — avg <span className="font-medium text-ink-2">{avg.toFixed(2)} / 1.0</span></>
              : <span className="text-hairline-strong">{total} response{total !== 1 ? 's' : ''}</span>}
          </p>

          <div className="flex items-center gap-2 flex-wrap">
            {showAi && (
              <button
                onClick={() => onGrade('all')}
                disabled={isGradePending}
                className="flex items-center gap-1.5 text-xs font-medium text-good border border-good/20 px-2.5 py-1.5 rounded-sm hover:bg-good-soft disabled:opacity-50 transition-colors"
              >
                <GraduationCap size={13} /> Grade with AI
              </button>
            )}
            {showAi && showUngradedOnly && (
              <button
                onClick={() => onGrade('ungraded')}
                disabled={isGradePending}
                className="flex items-center gap-1.5 text-xs font-medium text-ink-2 border border-hairline px-2.5 py-1.5 rounded-sm hover:bg-surface-2 disabled:opacity-50 transition-colors"
              >
                <GraduationCap size={13} /> Ungraded ({ungraded})
              </button>
            )}
            {needsReview > 0 && (
              <button
                onClick={() => onFilter(filter === 'review' ? 'all' : 'review')}
                className={`flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-sm border transition-colors ${
                  filter === 'review'
                    ? 'bg-warn-soft border-warn/30 text-warn'
                    : 'bg-surface border-hairline text-muted hover:text-ink'
                }`}
              >
                <AlertCircle size={11} />
                {filter === 'review' ? `Showing ${needsReview} to review` : `Needs review (${needsReview})`}
              </button>
            )}
            {shortCount > 0 && (
              <button
                onClick={() => onFilter(filter === 'short' ? 'all' : 'short')}
                title="Answers under ten words"
                className={`flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-sm border transition-colors ${
                  filter === 'short'
                    ? 'bg-warn-soft border-warn/30 text-warn'
                    : 'bg-surface border-hairline text-muted hover:text-ink'
                }`}
              >
                <Flag size={11} />
                {filter === 'short' ? `Showing ${shortCount} short` : `Short (${shortCount})`}
              </button>
            )}
            <button
              onClick={onFullCredit}
              disabled={isFullCreditPending}
              className="flex items-center gap-1.5 text-xs font-medium text-muted hover:text-good border border-hairline hover:border-good/30 px-2.5 py-1.5 rounded-sm transition-colors disabled:opacity-50"
            >
              <Check size={11} /> All full credit
            </button>
          </div>
        </div>
      )}

      {result && !progress && (
        result.failedCount > 0 ? (
          <p className="text-xs text-warn bg-warn-soft border border-warn/20 rounded-sm px-3 py-1.5 mt-2">
            Graded {total - result.failedCount} of {total} — {result.failedCount} failed.
            Use &ldquo;Ungraded&rdquo; to retry.
          </p>
        ) : (
          <p className="text-xs text-good bg-good-soft border border-good/20 rounded-sm px-3 py-1.5 mt-2">
            All {total} responses graded.
          </p>
        )
      )}

      {gradeError && <p className="text-xs text-red-500 mt-2">{gradeError}</p>}
    </div>
  )
}
