import { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  flat?: boolean
}

export default function Card({ flat = false, className, children, ...props }: CardProps) {
  return (
    <div
      className={cn(
        'bg-surface border border-hairline rounded-[14px]',
        !flat && 'shadow-card',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  )
}
