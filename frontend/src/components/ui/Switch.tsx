import { cn } from '@/lib/utils'

interface SwitchProps {
  checked: boolean
  onChange: () => void
  disabled?: boolean
  /** Required — the switch carries no visible text of its own. */
  ariaLabel: string
  className?: string
}

/**
 * The on/off switch used for class defaults and per-question overrides.
 *
 * Lifted verbatim out of `ClassPage`, which hand-rolled the same markup three times.
 * Kept as a `role="switch"` button rather than a checkbox so the knob can animate.
 */
export default function Switch({ checked, onChange, disabled, ariaLabel, className }: SwitchProps) {
  return (
    <button
      type="button"
      onClick={onChange}
      disabled={disabled}
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      className={cn(
        'shrink-0 w-9 h-5 rounded-full transition-colors disabled:opacity-50',
        checked ? 'bg-signal' : 'bg-surface-2 border border-hairline',
        className,
      )}
    >
      <span
        className={cn(
          'block w-3.5 h-3.5 rounded-full bg-white transition-transform',
          checked ? 'translate-x-[18px]' : 'translate-x-[3px]',
        )}
      />
    </button>
  )
}
