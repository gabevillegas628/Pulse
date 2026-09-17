import type { ComponentProps } from 'react'
import type Pill from '@/components/ui/Pill'

type PillVariant = NonNullable<ComponentProps<typeof Pill>['variant']>

/**
 * Which pill a session or assignment status wears.
 *
 * Shared rather than local because the roster's activity detail and the session and
 * assignment lists all render the same statuses, and they sat in one file only for as long
 * as they happened to live on one page.
 */
export function statusPill(status: string): PillVariant {
  const map: Record<string, PillVariant> = {
    OPEN: 'good', DRAFT: 'warn', CLOSED: 'muted', ARCHIVED: 'muted',
  }
  return map[status] ?? 'muted'
}
