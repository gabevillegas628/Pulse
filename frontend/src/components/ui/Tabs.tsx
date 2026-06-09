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
    <div className={cn('flex border-b border-hairline', className)}>
      {tabs.map((tab) => (
        <button
          key={tab.key}
          onClick={() => onChange(tab.key)}
          className={cn(
            'px-4 py-2.5 text-sm font-medium transition-colors -mb-px border-b-2',
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
