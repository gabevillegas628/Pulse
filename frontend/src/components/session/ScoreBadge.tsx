import { useEffect, useRef, useState } from 'react'
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
 * Full credit is good, nothing is bad, anything in between is partial.
 *
 * Deliberately a threshold rather than the exact-match it used to be: `=== 0.5 ? warn :
 * red` painted every custom score red, so 0.75 looked like a zero.
 */
function toneFor(score: number): string {
  if (score >= 1) return 'bg-good-soft text-good border-good/20'
  if (score > 0) return 'bg-warn-soft text-warn border-warn/20'
  return 'bg-red-100 text-red-600 border-red-200'
}

interface Props {
  score: number
  /** The grader's justification for this score, if it has one. */
  reason?: string | null
  onChange: (score: number) => void
  pending?: boolean
  disabled?: boolean
}

/**
 * A response's score, and the picker for changing it.
 *
 * This used to cycle 1 → 0.5 → 0 on click with the reason hidden in a `title`, which made
 * the only scoring control in the app both undiscoverable and impossible to aim: setting
 * 0.5 from 0 meant two clicks through a value you did not want, each one a write.
 *
 * Opens on hover, and also on click and focus — hover alone would strand keyboard and
 * touch users on the one control that assigns marks.
 */
export default function ScoreBadge({ score, reason, onChange, pending, disabled }: Props) {
  const [open, setOpen] = useState(false)
  const [custom, setCustom] = useState('')
  const wrapRef = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<number | null>(null)

  function cancelClose() {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }

  /** A grace period, so crossing the gap from badge to panel does not dismiss it. */
  function scheduleClose() {
    cancelClose()
    closeTimer.current = window.setTimeout(() => setOpen(false), 140)
  }

  useEffect(() => cancelClose, [])

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

  return (
    <div
      ref={wrapRef}
      className="relative"
      onMouseEnter={() => { if (!disabled) { cancelClose(); setOpen(true) } }}
      onMouseLeave={scheduleClose}
    >
      <button
        onClick={() => !disabled && setOpen((o) => !o)}
        onFocus={() => !disabled && setOpen(true)}
        disabled={disabled}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={`Score ${formatScore(score)} of 1.0 — change`}
        className={cn(
          'text-xs font-mono font-medium px-2 py-0.5 rounded-full border transition-opacity',
          toneFor(score),
          !disabled && 'cursor-pointer hover:opacity-80',
          pending && 'opacity-50',
        )}
      >
        {formatScore(score)} pt
      </button>

      {open && (
        <div
          className={cn(
            'absolute right-0 top-full mt-1 z-30 bg-surface border border-hairline rounded-[14px] shadow-pop p-3',
            // `white-space` inherits, and this badge sits in a table cell set to
            // `whitespace-nowrap` to keep the badge itself on one line. Without resetting
            // it here the reason below refused to wrap and ran out of the panel. Set on the
            // panel rather than fixed in the table, so the component survives being
            // dropped anywhere.
            'whitespace-normal',
            // Wider only when there is prose to read; the bare picker stays compact.
            reason ? 'w-72' : 'w-56',
          )}
          onMouseEnter={cancelClose}
        >
          <p className="text-[11px] font-medium text-muted uppercase tracking-wide mb-2">Score</p>

          <div className="flex gap-1.5">
            {PRESETS.map((v) => (
              <button
                key={v}
                onClick={() => apply(v)}
                disabled={pending}
                className={cn(
                  'flex-1 text-xs font-mono font-medium py-1.5 rounded-sm border transition-colors disabled:opacity-50',
                  score === v
                    ? toneFor(v)
                    : 'bg-surface border-hairline text-ink-2 hover:bg-surface-2',
                )}
              >
                {formatScore(v)}
              </button>
            ))}
          </div>

          <div className="flex gap-1.5 mt-2">
            <input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') applyCustom() }}
              placeholder="Custom 0–1"
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
