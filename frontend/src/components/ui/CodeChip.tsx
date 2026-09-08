import { useState } from 'react'
import { cn } from '@/lib/utils'

interface CodeChipProps {
  children: React.ReactNode
  className?: string
  /** Off for a code that is only being shown, not handed out. */
  copyable?: boolean
}

/**
 * Every code this renders is one a professor has to get to a student — read out,
 * pasted into an announcement, typed into a message to the one who missed the
 * lecture. Transcribing six characters by eye is exactly where an I becomes a 1, so
 * the chip copies itself.
 *
 * The click is stopped as well as prevented: these sit inside the class cards on the
 * dashboard, which are links, and copying a code should not also navigate away from
 * the page you wanted to copy it from.
 */
export default function CodeChip({ children, className, copyable = true }: CodeChipProps) {
  const [copied, setCopied] = useState(false)
  const text = typeof children === 'string' ? children : String(children ?? '')

  if (!copyable || !text) {
    return (
      <span
        className={cn(
          'font-mono bg-surface-2 text-ink-2 px-2 py-0.5 rounded-md tracking-wider text-sm',
          className,
        )}
      >
        {children}
      </span>
    )
  }

  async function copy(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // A denied clipboard permission is not worth an error state — the code is
      // on screen and can still be read.
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      title={copied ? 'Copied' : 'Copy code'}
      className={cn(
        'font-mono bg-surface-2 text-ink-2 px-2 py-0.5 rounded-md tracking-wider text-sm hover:bg-hairline transition-colors',
        copied && 'text-good',
        className,
      )}
    >
      {copied ? 'Copied' : children}
    </button>
  )
}
