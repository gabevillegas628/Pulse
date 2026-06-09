import { cn } from '@/lib/utils'

interface LiveDotProps {
  className?: string
}

export default function LiveDot({ className }: LiveDotProps) {
  return (
    <span
      className={cn('inline-block w-[7px] h-[7px] rounded-full bg-signal live-dot', className)}
    />
  )
}
