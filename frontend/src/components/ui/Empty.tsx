import { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

interface EmptyProps {
  icon?: LucideIcon
  message: string
  className?: string
}

export default function Empty({ icon: Icon, message, className }: EmptyProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 py-12 text-muted', className)}>
      {Icon && <Icon size={28} strokeWidth={1.5} />}
      <span className="text-sm">{message}</span>
    </div>
  )
}
