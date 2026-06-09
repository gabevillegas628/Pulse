import { cn } from '@/lib/utils'

type PillVariant = 'live' | 'good' | 'warn' | 'muted'

interface PillProps {
  variant?: PillVariant
  dot?: boolean
  children: React.ReactNode
  className?: string
}

const styles: Record<PillVariant, string> = {
  live:  'bg-signal-soft text-signal',
  good:  'bg-good-soft text-good',
  warn:  'bg-warn-soft text-warn',
  muted: 'bg-surface-2 text-muted',
}

export default function Pill({ variant = 'muted', dot = false, children, className }: PillProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-semibold',
        styles[variant],
        className,
      )}
    >
      {dot && variant === 'live' && (
        <span className="w-1.5 h-1.5 rounded-full bg-signal live-dot" />
      )}
      {children}
    </span>
  )
}
