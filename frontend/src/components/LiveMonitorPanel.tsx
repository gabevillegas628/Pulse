import { useState } from 'react'
import type { QuestionWithResponses, SummaryCategory } from 'shared'
import PulseMark from '@/components/ui/PulseMark'
import LiveDot from '@/components/ui/LiveDot'
import { Maximize2, X, Sparkles } from 'lucide-react'

interface Props {
  question: QuestionWithResponses | undefined
  enrolledCount: number
  summary: SummaryCategory[] | null
  summaryQuestionId: string | null
  isSummarizing: boolean
  onSummarize: () => void
  onOpenPip: () => void
  onClose: () => void
}

type MonitorMode = 'themes' | 'wall'

export default function LiveMonitorPanel({
  question, enrolledCount, summary, summaryQuestionId, isSummarizing, onSummarize, onOpenPip, onClose,
}: Props) {
  const [mode, setMode] = useState<MonitorMode>('themes')

  const answered = question?.responses.length ?? 0
  const pct = enrolledCount > 0 ? Math.round((answered / enrolledCount) * 100) : 0
  const stillOut = Math.max(0, enrolledCount - answered)

  const isFreText = question?.type === 'FREE_TEXT'
  const hasSummary = isFreText && summary && summaryQuestionId === question?.id
  const recentResponses = question?.responses.slice(0, 14) ?? []

  return (
    <div className="pulse-dark sticky top-4 w-[384px] shrink-0 rounded-[14px] border border-hairline-strong overflow-hidden shadow-pop" style={{ fontFamily: 'var(--font-ui)' }}>

      {/* ── Title bar ──────────────────────────────────────────────────────── */}
      <div className="bg-surface-2 border-b border-hairline px-3.5 py-2.5 flex items-center justify-between select-none">
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
          <button onClick={onOpenPip} title="Pop out to Picture-in-Picture" className="text-muted hover:text-ink-2 transition-colors p-0.5">
            <Maximize2 size={13} />
          </button>
          <button onClick={onClose} title="Close monitor" className="text-muted hover:text-ink-2 transition-colors p-0.5">
            <X size={13} />
          </button>
        </div>
      </div>

      {/* ── Counter ────────────────────────────────────────────────────────── */}
      <div className="px-4 pt-4 pb-3">
        <div className="flex items-end justify-between gap-3">
          <div className="flex items-baseline gap-2">
            <span className="font-mono font-bold text-ink leading-none" style={{ fontSize: 46, letterSpacing: '-0.02em' }}>
              {answered}
            </span>
            <span className="font-mono text-lg font-semibold text-muted">/ {enrolledCount}</span>
          </div>
          <div className="text-right shrink-0">
            <p className="font-mono font-bold text-[var(--signal-bright)] text-lg leading-none">{pct}%</p>
            <p className="text-[11px] text-muted mt-0.5 tracking-wide">answered</p>
          </div>
        </div>

        {/* Sub-row */}
        <div className="flex items-center justify-between mt-3 mb-1.5">
          <span className="text-[11px] text-muted">{stillOut} still out</span>
          <span className="text-[11px] text-muted font-mono">{answered}/{enrolledCount}</span>
        </div>

        {/* Participation bar */}
        <div className="h-1.5 rounded-full bg-surface-2 overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-500 ease-out"
            style={{ width: `${pct}%`, background: 'var(--signal-bright)' }}
          />
        </div>
      </div>

      {/* ── Mode toggle ────────────────────────────────────────────────────── */}
      <div className="flex gap-1 px-4 pb-3">
        {(['themes', 'wall'] as MonitorMode[]).map((m) => (
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

      {/* ── Body ───────────────────────────────────────────────────────────── */}
      <div className="pulse-scroll overflow-y-auto px-4 pb-4" style={{ maxHeight: 240 }}>
        {answered === 0 ? (
          <p className="text-center text-muted text-sm py-8">Waiting for the room…</p>
        ) : mode === 'themes' ? (
          <ThemesBody
            question={question}
            summary={hasSummary ? summary : null}
            isSummarizing={isSummarizing}
            answered={answered}
            onSummarize={onSummarize}
          />
        ) : (
          <WallBody responses={recentResponses} />
        )}
      </div>
    </div>
  )
}

// ── Themes body ───────────────────────────────────────────────────────────────

function ThemesBody({ question, summary, isSummarizing, answered, onSummarize }: {
  question: QuestionWithResponses | undefined
  summary: SummaryCategory[] | null
  isSummarizing: boolean
  answered: number
  onSummarize: () => void
}) {
  if (!question || question.type !== 'FREE_TEXT') {
    return <WallBody responses={question?.responses.slice(0, 14) ?? []} />
  }

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
              <div className="h-0.5 rounded-full bg-surface-2 overflow-hidden mb-2">
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
        className="flex items-center gap-1.5 text-xs font-bold px-3 py-2 rounded-sm transition-colors disabled:opacity-50"
        style={{ background: 'var(--signal)', color: '#fff' }}
      >
        <Sparkles size={13} />
        {isSummarizing ? 'Summarizing…' : 'Summarize responses'}
      </button>
      <p className="text-[11px] text-muted text-center">
        AI groups responses into themes
      </p>
    </div>
  )
}

// ── Live wall body ────────────────────────────────────────────────────────────

function WallBody({ responses }: { responses: QuestionWithResponses['responses'] }) {
  return (
    <div className="space-y-2">
      {responses.map((r, i) => (
        <div
          key={r.id}
          className={`bg-surface-2 rounded-sm px-3 py-2.5 ${i === 0 ? 'rise-in' : ''}`}
        >
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] font-mono text-muted">{r.student.netId}</span>
            {'wordCount' in r && (
              <span className="text-[10px] font-mono text-muted">{(r as typeof r & { wordCount: number }).wordCount}w</span>
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
