import { cn } from '@/lib/utils'

interface Tab {
  key: string
  label: string
}

interface TabsProps {
  tabs: Tab[]
  active: string
  onChange: (key: string) => void
  className?: string
}

export default function Tabs({ tabs, active, onChange, className }: TabsProps) {
  return (
    // Scrolls sideways when the labels outrun a phone. The baseline is an inset shadow, not
    // a border the active tab overlaps with -mb-px: a scroll container clips that 1px
    // overhang (and can grow a vertical scrollbar over it).
    <div className={cn('flex overflow-x-auto no-scrollbar shadow-[inset_0_-1px_0_var(--hairline)]', className)}>
      {tabs.map((tab) => (
        <button
          key={tab.key}
          onClick={() => onChange(tab.key)}
          className={cn(
            'shrink-0 whitespace-nowrap px-4 py-2.5 text-sm font-medium transition-colors border-b-2',
            active === tab.key
              ? 'text-ink border-signal'
              : 'text-muted border-transparent hover:text-ink',
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}
