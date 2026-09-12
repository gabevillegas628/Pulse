import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import Button from '@/components/ui/Button'
import { cn } from '@/lib/utils'

interface PopoverProps {
  /** Contents of the trigger button — usually a summary of what is inside. */
  trigger: React.ReactNode
  /**
   * Panel contents. As a function it receives `close`, which a menu item needs: clicking
   * inside the panel is not an outside click, so an item that acts and leaves would
   * otherwise act and stay.
   */
  children: React.ReactNode | ((close: () => void) => React.ReactNode)
  /** Accessible name for the trigger. */
  label: string
  /** A summary trigger earns a chevron; an icon-only menu button does not. */
  chevron?: boolean
  /** Which edge the panel is pinned to. Use `left` when the trigger sits left of centre. */
  align?: 'left' | 'right'
  triggerClassName?: string
  /** Extra classes for the floating panel — override `w-*` here to resize it. */
  className?: string
}

/**
 * A click-to-open panel anchored under its trigger.
 *
 * Closes on Escape and on a click anywhere outside, which is the whole reason this
 * isn't a `<details>` — the settings inside fire mutations, and a stray click landing
 * on the page behind an open panel was the bug worth avoiding.
 *
 * The trigger is a `sm` ghost `Button`, so it matches the other inline controls it sits
 * beside rather than carrying styling of its own.
 */
export default function Popover({
  trigger, children, label, align = 'right', chevron = true, triggerClassName, className,
}: PopoverProps) {
  const [open, setOpen] = useState(false)
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

  return (
    <div ref={wrapRef} className="relative">
      <Button
        variant="ghost"
        size="sm"
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={label}
        className={cn(open && 'bg-surface-2 text-ink border-signal', triggerClassName)}
      >
        {trigger}
        {chevron && (
          <ChevronDown
            size={12}
            className={cn('text-muted transition-transform', open && 'rotate-180')}
          />
        )}
      </Button>

      {open && (
        <div
          className={cn(
            'absolute top-full mt-1.5 z-40 w-[min(24rem,calc(100vw-2rem))]',
            align === 'right' ? 'right-0' : 'left-0',
            'bg-surface border border-hairline rounded-[14px] shadow-pop p-4',
            className,
          )}
        >
          {typeof children === 'function' ? children(() => setOpen(false)) : children}
        </div>
      )}
    </div>
  )
}
