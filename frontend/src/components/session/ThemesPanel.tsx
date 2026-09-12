import { useState } from 'react'
import { ChevronDown, ChevronRight, RefreshCw, Sparkles } from 'lucide-react'
import Card from '@/components/ui/Card'
import ConfirmDialog, { type DialogRequest } from '@/components/ui/ConfirmDialog'
import ThemeBars from '@/components/ThemeBars'
import type { ThemeSet } from 'shared'

interface Props {
  /** The persisted set for the question in view, or null if none exists for this run. */
  themes: ThemeSet | null
  isSummarizing: boolean
  isError: boolean
  /** Derive a set. Destructive when one already exists — the server replaces it. */
  onSummarize: () => void
}

/**
 * AI themes for a free-text question, and the two controls that are not the same thing.
 *
 * They used to read as three controls expressing two actions, with the labels hiding
 * which ones destroy. `Summarize responses` and `Regenerate` were the identical call —
 * `POST /summarize`, which `deleteMany`s the existing set and re-derives it — while
 * `Dismiss` only hid the panel locally. Because a dismissed panel made `Summarize`
 * reappear, the way back from Dismiss re-derived the set, unconfirmed, when simply
 * un-hiding it would have done. The destructive path reachable by accident was the one
 * without the warning.
 *
 * Now: collapsing is a view state that touches nothing, `Summarize` appears only when
 * there is genuinely nothing to show, and `Regenerate` is the single path that replaces
 * a set and keeps its confirmation.
 *
 * Collapse is deliberately ephemeral and open by default. Persisting it would let a
 * collapsed panel hide incoming live themes indefinitely; if it is wanted later,
 * `localStorage` keyed by question id is the whole job.
 */
export default function ThemesPanel({ themes, isSummarizing, isError, onSummarize }: Props) {
  const [collapsed, setCollapsed] = useState(false)
  const [ask, setAsk] = useState<DialogRequest | null>(null)

  // Defined once. The two states below are mutually exclusive, so this never renders
  // twice — but it was written out twice, which is the kind of thing that drifts.
  const errorLine = isError
    ? <p className="text-xs text-red-500 mt-2">Failed to summarize — try again.</p>
    : null

  // Nothing derived for this run yet: the one case where summarizing creates rather
  // than replaces, so it needs no warning.
  if (!themes) {
    return (
      <div className="mb-4">
        <button
          onClick={onSummarize}
          disabled={isSummarizing}
          className="flex items-center gap-1.5 text-sm text-signal border border-signal/20 px-3 py-2 rounded-sm hover:bg-signal-soft disabled:opacity-50 transition-colors"
        >
          <Sparkles size={14} />
          {isSummarizing ? 'Summarizing…' : 'Summarize responses'}
        </button>
        {errorLine}
      </div>
    )
  }

  return (
    <Card className="p-5 mb-4">
      <div className="flex items-center justify-between gap-3">
        <button
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          className="flex items-center gap-1.5 text-sm font-semibold text-ink-2 hover:text-ink transition-colors"
        >
          {collapsed ? <ChevronRight size={14} className="text-muted" /> : <ChevronDown size={14} className="text-muted" />}
          <Sparkles size={14} className="text-signal" /> AI Theme Summary
          {collapsed && (
            <span className="font-normal text-xs text-muted">
              — {themes.categories.length} theme{themes.categories.length !== 1 ? 's' : ''}
            </span>
          )}
        </button>

        {/*
          The only correction this feature has. Re-running replaces the set outright,
          which is the fix when the categories miss where the class actually went — a
          single answer in the wrong bucket shifts a bar by one and is not worth a
          control.
        */}
        <button
          onClick={() => setAsk({
            title: 'Re-derive the themes?',
            body: 'The current labels and counts are replaced. If a projector is showing them, the room will see them change.',
            confirmLabel: 'Regenerate',
            destructive: true,
            onConfirm: onSummarize,
          })}
          disabled={isSummarizing}
          className="flex items-center gap-1 text-xs text-muted hover:text-signal disabled:opacity-50 transition-colors shrink-0"
          title="Group the answers again from scratch"
        >
          <RefreshCw size={11} className={isSummarizing ? 'animate-spin' : ''} />
          {isSummarizing ? 'Regrouping…' : 'Regenerate'}
        </button>
      </div>

      {!collapsed && (
        <div className="mt-4">
          <ThemeBars
            variant="panel"
            categories={themes.categories}
            classified={themes.classified}
            total={themes.total}
            status={themes.status}
            need={themes.need}
          />
        </div>
      )}

      {errorLine}
      <ConfirmDialog request={ask} onClose={() => setAsk(null)} />
    </Card>
  )
}
