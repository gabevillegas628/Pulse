import { useEffect, useMemo, useState } from 'react'
import { Check, X } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface Student { netId: string; email: string }

/**
 * Whose paper this is: the matched NetID with Change and Clear, or a box to type one into.
 * Typing suggests roster students (NetIDs that start with what was typed first, then any that
 * contain it, or whose email does); Enter takes the highlighted one, or what was typed when
 * nobody on the roster fits. Used by the matching screen and the single-page view.
 */
export default function StudentPicker({ netId, roster, placeholder, inputRef, onMatch }: {
  netId: string | null
  roster: Student[]
  placeholder: string
  inputRef?: (el: HTMLInputElement | null) => void
  onMatch: (netId: string | null) => void
}) {
  const [editing, setEditing] = useState(!netId)
  const [q, setQ] = useState('')
  const [pick, setPick] = useState(0)
  useEffect(() => { setEditing(!netId) }, [netId])

  const term = q.trim().toLowerCase()
  const hits = useMemo(() => {
    if (!term) return []
    const starts = roster.filter((s) => s.netId.toLowerCase().startsWith(term))
    const within = roster.filter((s) => !starts.includes(s) && (s.netId.toLowerCase().includes(term) || s.email.toLowerCase().includes(term)))
    return [...starts, ...within].slice(0, 6)
  }, [term, roster])

  function choose(n: string) {
    onMatch(n)
    setQ('')
    setPick(0)
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setPick((i) => Math.min(i + 1, hits.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setPick((i) => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter') {
      e.preventDefault()
      if (hits[pick]) choose(hits[pick]!.netId)
      // Not on the roster (or no class chosen): take what was typed; the caller says so.
      else if (term) choose(term)
    } else if (e.key === 'Escape' && netId) { setEditing(false); setQ('') }
  }

  if (netId && !editing) {
    return (
      <div className="flex items-center gap-2">
        <Check size={15} className="text-good shrink-0" />
        <span className="font-mono font-semibold text-ink">{netId}</span>
        <button className="text-xs text-signal hover:underline" onClick={() => setEditing(true)}>Change</button>
        <button className="text-muted hover:text-warn" aria-label="Clear" title="Clear" onClick={() => onMatch(null)}><X size={13} /></button>
      </div>
    )
  }
  return (
    <div className="relative">
      <input ref={inputRef} value={q} onChange={(e) => { setQ(e.target.value); setPick(0) }} onKeyDown={onKey}
        placeholder={placeholder} aria-label="Student NetID"
        className="w-full border border-hairline rounded-sm px-2.5 py-1.5 text-sm font-mono bg-surface focus:outline-none focus:ring-2 focus:ring-signal" />
      {hits.length > 0 && (
        <div className="absolute z-20 mt-1 w-full bg-surface border border-hairline rounded-sm shadow-lg">
          {hits.map((s, i) => (
            <button key={s.netId} onMouseDown={(e) => { e.preventDefault(); choose(s.netId) }}
              className={cn('w-full text-left px-2.5 py-1.5 text-sm flex justify-between gap-2', i === pick ? 'bg-surface-2' : 'hover:bg-surface-2')}>
              <span className="font-mono text-ink">{s.netId}</span>
              <span className="text-xs text-muted truncate">{s.email}</span>
            </button>
          ))}
        </div>
      )}
      {netId && <button className="text-xs text-muted hover:text-ink mt-1" onClick={() => { setEditing(false); setQ('') }}>Cancel</button>}
    </div>
  )
}
