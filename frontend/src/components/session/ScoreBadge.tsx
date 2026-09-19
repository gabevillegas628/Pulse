import { useEffect, useRef, useState } from 'react'
import { MoreVertical } from 'lucide-react'
import { cn } from '@/lib/utils'

const PRESETS = [0, 0.5, 1] as const

/**
 * `1` reads "1.0" and `0` reads "0", which is how this badge always labelled them.
 * Anything between keeps up to two decimals, which is what makes a custom score legible
 * instead of collapsing into one of the presets.
 */
export function formatScore(score: number): string {
  if (score === 1) return '1.0'
  if (score === 0) return '0'
  return String(+score.toFixed(2))
}

/**
 * The same number with nothing in it that does not distinguish one score from another:
 * `½` rather than `0.5`, `1` rather than `1.0`. Every preset is one glyph wide.
 *
 * Only for the pill, where four labels sit side by side and the leading zero every one of
 * them shares is pure width. `formatScore` stays as it is — a chip standing on its own
 * elsewhere in the app has no neighbours to be read against, and `1.0 pt` says "out of
 * one" in a way `1 pt` does not.
 *
 * A score that is none of the presets keeps its decimal, minus the leading zero. Halves
 * are a mark someone chooses by name; `0.7` is a measurement, and `⁷⁄₁₀` would be showing
 * off rather than reading faster.
 */
function compactScore(score: number): string {
  if (score === 1) return '1'
  if (score === 0.5) return '½'
  if (score === 0) return '0'
  return formatScore(score).replace(/^0/, '')
}

/**
 * Full credit is good, nothing is bad, anything in between is partial.
 *
 * Deliberately a threshold rather than the exact-match it used to be: `=== 0.5 ? warn :
 * red` painted every custom score red, so 0.75 looked like a zero.
 *
 * Split from `toneFor` because the pill's segments share edges with their neighbours and
 * draw no borders of their own; the chips elsewhere still want one.
 */
function fillFor(score: number): string {
  if (score >= 1) return 'bg-good-soft text-good'
  if (score > 0) return 'bg-warn-soft text-warn'
  return 'bg-red-100 text-red-600'
}

/** The same tones with a border, for the read-only chips elsewhere in the app. */
export function toneFor(score: number): string {
  if (score >= 1) return `${fillFor(score)} border-good/20`
  if (score > 0) return `${fillFor(score)} border-warn/20`
  return `${fillFor(score)} border-red-200`
}

interface Props {
  /** `null` while nothing has scored this response yet — no segment is lit. */
  score: number | null
  /** The grader's justification for this score, if it has one. */
  reason?: string | null
  onChange: (score: number) => void
  pending?: boolean
  disabled?: boolean
}

/**
 * A response's score, as a segmented pill: 0, 0.5, 1.0, and a panel for anything else.
 *
 * The three marks that account for nearly every grade are one click each, in place, with
 * nothing laid over the table. That is the whole point of the shape — this used to be a
 * single chip whose only affordance was a popover, so the common case (give this one full
 * credit) cost an open, an aim and a click, and the panel covered the rows either side of
 * the one being graded.
 *
 * The last segment keeps what only a panel can do: a score that is not a preset, and the
 * grader's reasoning. A custom score is shown *in* that segment rather than behind it, so
 * a 0.75 still reads as 0.75 from the table.
 */
export default function ScoreBadge({ score, reason, onChange, pending, disabled }: Props) {
  const [open, setOpen] = useState(false)
  const [custom, setCustom] = useState('')
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  function apply(value: number) {
    onChange(value)
    setOpen(false)
    setCustom('')
  }

  function applyCustom() {
    const parsed = parseFloat(custom)
    if (Number.isNaN(parsed)) return
    // The route accepts any float in [0, 1]; clamping here keeps it from 400ing on a typo.
    apply(Math.min(1, Math.max(0, parsed)))
  }

  // A score of its own only when it is not one of the presets — that is the case the panel
  // exists for, and the one the pill would otherwise show as unscored.
  const customScore = score !== null && !PRESETS.some((v) => v === score) ? score : null
  // A write is already in flight, so the presets would be racing it. The panel still
  // opens: reading the grader's reason is not a write.
  const inert = disabled || pending

  return (
    <div ref={wrapRef} className="relative inline-block">
      <div
        role="group"
        aria-label={score === null ? 'Not scored — set a score' : `Score ${formatScore(score)} of 1.0`}
        className={cn(
          'inline-flex items-stretch rounded-full border border-hairline-strong bg-surface',
          'divide-x divide-hairline overflow-hidden transition-opacity',
          pending && 'opacity-50',
          disabled && 'opacity-60',
        )}
      >
        {PRESETS.map((v) => (
          <button
            key={v}
            // Clicking the score it already has is a no-op rather than another write.
            onClick={() => { if (!inert && score !== v) apply(v) }}
            disabled={inert}
            aria-pressed={score === v}
            aria-label={`Give ${formatScore(v)}`}
            // No shared minimum width: `0` and `1` are one glyph and `.5` is two, so
            // matching them all to the widest spends a third of the pill on nothing.
            className={cn(
              'px-2.5 py-0.5 text-xs font-mono font-medium text-center transition-colors',
              score === v ? fillFor(v) : 'text-muted hover:bg-surface-2 hover:text-ink-2',
              inert && 'cursor-not-allowed',
            )}
          >
            {compactScore(v)}
          </button>
        ))}

        <button
          onClick={() => !disabled && setOpen((o) => !o)}
          disabled={disabled}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={
            customScore !== null
              ? `Score ${formatScore(customScore)} — change`
              : reason ? 'Another score, or why this one' : 'Another score'
          }
          title={reason ? 'Why this score — and set another' : 'Set another score'}
          className={cn(
            'py-0.5 flex items-center justify-center text-xs font-mono font-medium transition-colors',
            // Upright dots need barely any width; a number in this slot needs as much as
            // the presets beside it.
            customScore !== null ? 'px-2.5' : 'px-1.5',
            customScore !== null
              ? fillFor(customScore)
              : cn('hover:bg-surface-2 hover:text-ink-2', open ? 'bg-surface-2 text-ink-2' : 'text-muted'),
            disabled && 'cursor-not-allowed',
          )}
        >
          {customScore !== null
            ? compactScore(customScore)
            // Darker dots are the only hint that there is something to read behind them.
            : <MoreVertical size={14} className={reason ? 'text-ink-2' : undefined} />
          }
        </button>
      </div>

      {open && (
        <div
          className={cn(
            // Beside the pill, not beneath it. Opening downwards covered the score
            // controls of the rows below — in a dense table that is the column you are
            // working along, so the picker was hiding its own next target. To the right it
            // lands on the time and answer columns instead.
            'absolute left-full top-0 ml-1.5 z-30 bg-surface border border-hairline rounded-[14px] shadow-pop p-3',
            // `white-space` inherits, and this pill sits in a table cell set to
            // `whitespace-nowrap` to keep the pill itself on one line. Without resetting it
            // here the reason below refused to wrap and ran out of the panel. Set on the
            // panel rather than fixed in the table, so the component survives being dropped
            // anywhere.
            'whitespace-normal',
            // Wider only when there is prose to read; the bare input stays compact.
            reason ? 'w-72' : 'w-56',
          )}
        >
          <p className="text-[11px] font-medium text-muted uppercase tracking-wide mb-2">Another score</p>

          <div className="flex gap-1.5">
            <input
              type="number"
              min={0}
              max={1}
              step={0.05}
              autoFocus
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') applyCustom() }}
              placeholder="0–1"
              className="flex-1 min-w-0 border border-hairline rounded-sm px-2 py-1 text-xs bg-surface focus:outline-none focus:ring-2 focus:ring-signal"
            />
            <button
              onClick={applyCustom}
              disabled={pending || custom.trim() === ''}
              className="text-xs font-medium px-2 py-1 rounded-sm border border-hairline text-ink-2 hover:bg-surface-2 disabled:opacity-40 transition-colors"
            >
              Set
            </button>
          </div>

          {reason && (
            <p className="mt-2 pt-2 border-t border-hairline text-[11px] text-muted leading-snug break-words">
              <span className="font-medium">AI:</span> {reason}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
