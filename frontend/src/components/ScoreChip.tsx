import { formatScore, toneFor } from '@/components/session/ScoreBadge'

/**
 * A question's score as the gradebook counts it, read-only.
 *
 * Takes the score the server computed (`gradeSession`) rather than a response to judge.
 * The student report panel used to judge answers itself with rules of its own — no
 * numeric, no aiScore on multiple choice — and showed half the points the gradebook did.
 * `counted: false` renders a "not graded" tag instead of a number, so an answered but
 * ungraded question cannot pass for a zero or a full mark.
 */
export default function ScoreChip({ score, counted }: { score: number | null; counted: boolean }) {
  if (!counted || score === null) {
    return (
      <span className="shrink-0 text-[10px] font-medium text-muted border border-hairline px-1.5 py-0.5 rounded-full whitespace-nowrap">
        not graded
      </span>
    )
  }
  return (
    <span className={`shrink-0 text-xs font-mono font-medium px-2 py-0.5 rounded-full border ${toneFor(score)}`}>
      {formatScore(score)} pt
    </span>
  )
}

/** Earned over max for one session, summed from the same per-question scores. */
export function sessionTotal(questions: { score: number | null; counted: boolean }[]) {
  const counted = questions.filter((q) => q.counted)
  const earned = counted.reduce((sum, q) => sum + (q.score ?? 0), 0)
  return { earned: Math.round(earned * 10) / 10, max: counted.length }
}
