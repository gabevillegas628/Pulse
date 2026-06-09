import { ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ghost'
}

export default function Button({ variant = 'ghost', className, children, ...props }: ButtonProps) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-sm px-4 py-2 text-sm font-bold transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
        variant === 'primary' && 'bg-signal text-white hover:bg-[var(--signal-bright)]',
        variant === 'ghost'   && 'bg-surface border border-hairline-strong text-ink-2 hover:bg-surface-2',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  )
}
