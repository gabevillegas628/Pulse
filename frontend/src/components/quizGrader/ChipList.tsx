import { useState } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Props {
  values: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  /** Mark the first chip as the main form (an enzyme's canonical name). */
  firstIsPrimary?: boolean
  label?: string
}

/**
 * A list of short names, one chip each. Enter adds what is typed — not comma, since
 * names like "fructose 1,6-bisphosphate" contain commas.
 */
export default function ChipList({ values, onChange, placeholder = 'Add…', firstIsPrimary, label }: Props) {
  const [text, setText] = useState('')

  function add() {
    const v = text.trim()
    if (!v) return
    if (!values.some((x) => x.toLowerCase() === v.toLowerCase())) onChange([...values, v])
    setText('')
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label={label}>
      {values.map((v, i) => (
        <span
          key={`${v}-${i}`}
          className={cn(
            'inline-flex items-center gap-1 rounded-full pl-2.5 pr-1 py-0.5 text-xs border',
            firstIsPrimary && i === 0 ? 'bg-signal-soft border-signal/30 text-ink font-semibold' : 'bg-surface-2 border-hairline text-ink-2',
          )}
          title={firstIsPrimary && i === 0 ? 'Main name: shown to the model as the expected answer' : undefined}
        >
          {v}
          <button
            type="button"
            onClick={() => onChange(values.filter((_, j) => j !== i))}
            className="rounded-full p-0.5 text-muted hover:text-ink hover:bg-hairline"
            aria-label={`Remove ${v}`}
          >
            <X size={11} />
          </button>
        </span>
      ))}
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); add() }
        }}
        onBlur={add}
        placeholder={placeholder}
        className="min-w-[8rem] flex-1 bg-transparent text-xs px-1 py-1 focus:outline-none"
      />
    </div>
  )
}
