import { cn } from '@/lib/utils'

interface CodeChipProps {
  children: React.ReactNode
  className?: string
}

export default function CodeChip({ children, className }: CodeChipProps) {
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
