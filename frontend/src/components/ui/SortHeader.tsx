import { ArrowUpDown, ChevronDown, ChevronUp } from 'lucide-react'

/**
 * A sortable column heading.
 *
 * The icon is the whole affordance: a faint two-way arrow on the columns you could sort by,
 * a solid chevron on the one you are sorting by, pointing the way the rows run. Lifted out of
 * ClassPage's session list when the roster gained sorting of its own, rather than copied —
 * two of these drifting apart would be two tables that disagree about what a column header
 * means.
 */

interface Props<K extends string> {
  label: string
  /** The key this column sorts by. */
  sortKey: K
  /** The key currently sorted by, which may be another column's. */
  activeKey: K
  dir: 'asc' | 'desc'
  onSort: (key: K) => void
}

export default function SortHeader<K extends string>({
  label, sortKey, activeKey, dir, onSort,
}: Props<K>) {
  const active = activeKey === sortKey
  const Icon = !active ? ArrowUpDown : dir === 'asc' ? ChevronUp : ChevronDown
  return (
    <th className="px-5 py-3">
      <button
        onClick={() => onSort(sortKey)}
        className={`flex items-center gap-1 text-xs font-medium uppercase tracking-wide transition-colors ${
          active ? 'text-ink-2' : 'text-muted hover:text-ink-2'
        }`}
      >
        {label}
        <Icon size={12} className={active ? '' : 'opacity-40'} />
      </button>
    </th>
  )
}
