import { useState } from 'react'
import type { QuestionWithResponses, SummaryCategory } from 'shared'
import PulseMark from '@/components/ui/PulseMark'
import LiveDot from '@/components/ui/LiveDot'
import ResultsSummary from '@/components/ResultsSummary'
import { X, Sparkles } from 'lucide-react'

interface Props {
  question: QuestionWithResponses | undefined
  questionNumber: number
  totalQuestions: number
  sessionTitle: string
  enrolledCount: number
  summary: SummaryCategory[] | null
  summaryQuestionId: string | null
  isSummarizing: boolean
  onSummarize: () => void
  onClose: () => void
}

type Mode = 'themes' | 'wall'

const CHART_TYPES = new Set(['MULTIPLE_CHOICE', 'RATING', 'YES_NO', 'MULTI_SELECT', 'NUMERIC', 'ORDERING', 'STRUCTURE'])

export default function LiveMonitorPanel({
  question, questionNumber, totalQuestions, sessionTitle,
  enrolledCount, summary, summaryQuestionId, isSummarizing, onSummarize, onClose,
}: Props) {
  const [mode, setMode] = useState<Mode>('themes')

  const answered = question?.responses.length ?? 0
  const pct = enrolledCount > 0 ? Math.round((answered / enrolledCount) * 100) : 0
  const stillOut = enrolledCount > 0 ? Math.max(0, enrolledCount - answered) : null

  const isFreeText = question?.type === 'FREE_TEXT'
  const hasSummary = isFreeText && summary != null && summaryQuestionId === question?.id

  return (
    <div className="pulse-dark flex flex-col min-h-screen bg-surface" style={{ fontFamily: 'var(--font-ui)' }}>

      {/* ── Title bar ──────────────────────────────────────────────────────── */}
      <div className="bg-surface-2 border-b border-hairline px-3.5 py-2.5 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2.5">
          <span className="flex gap-1">
            {[0, 1, 2].map((i) => (
              <span key={i} className="w-1 h-1 rounded-full bg-muted" />
            ))}
          </span>
          <PulseMark size={15} color="var(--signal-bright)" />
          <span className="text-xs font-bold text-ink tracking-tight">Live results</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <LiveDot />
            <span className="text-[10px] font-bold text-signal uppercase tracking-widest">Live</span>
          </div>
          <button onClick={onClose} title="Close monitor" className="text-muted hover:text-ink-2 transition-colors p-0.5">
            <X size={13} />
          </button>
        </div>
      </div>

      {/* ── Question label ─────────────────────────────────────────────────── */}
      <div className="px-4 pt-3 pb-1 shrink-0">
        <p className="text-[10px] text-muted uppercase tracking-widest font-medium truncate">
          {sessionTitle} · Q{questionNumber}{totalQuestions > 1 ? ` of ${totalQuestions}` : ''}
        </p>
        {question && (
          <p className="text-sm font-semibold text-ink mt-0.5 leading-snug line-clamp-2">{question.text}</p>
        )}
      </div>

      {/* ── Counter + participation bar ─────────────────────────────────────── */}
      <div className="px-4 pt-2 pb-3 shrink-0">
        <div className="flex items-end justify-between gap-3">
          <div className="flex items-baseline gap-2">
            <span
              className="font-mono font-bold text-ink leading-none"
              style={{ fontSize: 46, letterSpacing: '-0.02em' }}
            >
              {answered}
            </span>
            {enrolledCount > 0 && (
              <span className="font-mono text-lg font-semibold text-muted">/ {enrolledCount}</span>
            )}
          </div>
          {enrolledCount > 0 && (
            <div className="text-right shrink-0">
              <p className="font-mono font-bold text-lg leading-none" style={{ color: 'var(--signal-bright)' }}>
                {pct}%
              </p>
              <p className="text-[11px] text-muted mt-0.5 tracking-wide">answered</p>
            </div>
          )}
        </div>

        {enrolledCount > 0 && (
          <>
            <div className="flex items-center justify-between mt-2 mb-1.5">
              <span className="text-[11px] text-muted">{stillOut} still out</span>
              <span className="text-[11px] text-muted font-mono">{answered}/{enrolledCount}</span>
            </div>
            <div className="h-1.5 rounded-full bg-surface-2 overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500 ease-out"
                style={{ width: `${pct}%`, background: 'var(--signal-bright)' }}
              />
            </div>
          </>
        )}
      </div>

      {/* ── Body: type-specific ────────────────────────────────────────────── */}
      {isFreeText ? (
        <>
          {/* Mode toggle */}
          <div className="flex gap-1 px-4 pb-3 shrink-0">
            {(['themes', 'wall'] as Mode[]).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className="flex-1 py-1.5 rounded-sm text-xs font-bold transition-colors"
                style={{
                  background: mode === m ? 'var(--signal)' : 'transparent',
                  color: mode === m ? '#fff' : 'var(--muted)',
                  border: `1px solid ${mode === m ? 'transparent' : 'var(--hairline)'}`,
                }}
              >
                {m === 'themes' ? 'Themes' : 'Live wall'}
              </button>
            ))}
          </div>

          {/* Scrollable body */}
          <div className="pulse-scroll flex-1 overflow-y-auto px-4 pb-4">
            {answered === 0 ? (
              <p className="text-center text-muted text-sm py-8">Waiting for the room…</p>
            ) : mode === 'themes' ? (
              <ThemesBody
                summary={hasSummary ? summary : null}
                isSummarizing={isSummarizing}
                answered={answered}
                onSummarize={onSummarize}
              />
            ) : (
              <WallBody responses={question?.responses.slice(0, 14) ?? []} />
            )}
          </div>
        </>
      ) : question && CHART_TYPES.has(question.type) ? (
        /* Structured types: reuse existing ResultsSummary charts */
        <div className="px-4 pb-4 flex-1 overflow-y-auto">
          {answered === 0 ? (
            <p className="text-center text-muted text-sm py-8">Waiting for the room…</p>
          ) : (
            <ResultsSummary question={question} />
          )}
        </div>
      ) : (
        /* Fallback: live wall */
        <div className="pulse-scroll flex-1 overflow-y-auto px-4 pb-4">
          {answered === 0 ? (
            <p className="text-center text-muted text-sm py-8">Waiting for the room…</p>
          ) : (
            <WallBody responses={question?.responses.slice(0, 14) ?? []} />
          )}
        </div>
      )}
    </div>
  )
}

// ── Themes body ───────────────────────────────────────────────────────────────

function ThemesBody({ summary, isSummarizing, answered, onSummarize }: {
  summary: SummaryCategory[] | null
  isSummarizing: boolean
  answered: number
  onSummarize: () => void
}) {
  if (summary) {
    return (
      <div className="space-y-4">
        {summary.map((cat, i) => {
          const barPct = answered > 0 ? Math.round((cat.count / answered) * 100) : 0
          return (
            <div key={i}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-semibold text-ink">{cat.label}</span>
                <span className="text-sm font-bold font-mono text-ink">{cat.count}</span>
              </div>
              <div className="h-0.5 rounded-full bg-surface-2 overflow-hidden mb-1.5">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${barPct}%`, background: 'var(--signal)' }}
                />
              </div>
              <p className="text-xs text-muted leading-snug italic line-clamp-2">
                "{cat.description}"
              </p>
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center py-6 gap-3">
      <button
        onClick={onSummarize}
        disabled={isSummarizing}
        className="flex items-center gap-1.5 text-xs font-bold px-4 py-2 rounded-sm disabled:opacity-50 transition-opacity"
        style={{ background: 'var(--signal)', color: '#fff' }}
      >
        <Sparkles size={13} />
        {isSummarizing ? 'Summarizing…' : 'Summarize responses'}
      </button>
      <p className="text-[11px] text-muted text-center">AI groups responses into themes</p>
    </div>
  )
}

// ── Live wall body ────────────────────────────────────────────────────────────

function WallBody({ responses }: { responses: QuestionWithResponses['responses'] }) {
  if (responses.length === 0) {
    return <p className="text-center text-muted text-sm py-8">Waiting for the room…</p>
  }
  return (
    <div className="space-y-2">
      {responses.map((r, i) => (
        <div
          key={r.id}
          className={`bg-surface-2 rounded-sm px-3 py-2.5 ${i === 0 ? 'rise-in' : ''}`}
        >
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] font-mono text-muted">{r.student.netId}</span>
            {'wordCount' in r && (r as typeof r & { wordCount: number }).wordCount > 0 && (
              <span className="text-[10px] font-mono text-muted">
                {(r as typeof r & { wordCount: number }).wordCount}w
              </span>
            )}
          </div>
          <p className="text-xs text-ink-2 leading-snug line-clamp-2">
            {r.responseText || <em className="text-muted">(blank)</em>}
          </p>
        </div>
      ))}
    </div>
  )
}
