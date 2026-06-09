import { cn } from '@/lib/utils'

interface StatProps {
  value: React.ReactNode
  label: string
  live?: boolean
  className?: string
}

export default function Stat({ value, label, live = false, className }: StatProps) {
  return (
    <div className={cn('flex flex-col items-start gap-0.5', className)}>
      <span className={cn('font-mono text-2xl font-bold leading-none', live ? 'text-signal' : 'text-ink')}>
        {value}
      </span>
      <span className="text-muted text-xs">{label}</span>
    </div>
  )
}
