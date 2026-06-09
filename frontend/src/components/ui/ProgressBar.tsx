import { cn } from '@/lib/utils'

interface ProgressBarProps {
  value: number
  max?: number
  variant?: 'signal' | 'good'
  className?: string
}

export default function ProgressBar({ value, max = 100, variant = 'signal', className }: ProgressBarProps) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100))

  return (
    <div className={cn('h-1.5 w-full rounded-full bg-surface-2 overflow-hidden', className)}>
      <div
        className={cn(
          'h-full rounded-full transition-[width] duration-500',
          variant === 'signal' ? 'bg-signal' : 'bg-good',
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}
