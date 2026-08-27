import type { ThemeCategory, ThemeSetStatus } from 'shared'

/**
 * Aggregate theme distribution. Counts only — never a response, never a student.
 *
 * Deliberately its own file rather than living beside `WallBody` in LiveMonitorPanel,
 * which renders netIDs and raw answer text. This component is used on `/present`, which
 * is projected in a lecture hall, so it must not be one careless import away from
 * something that shows who said what.
 *
 * Two variants: `panel` for the professor's task pane, `stage` for the projector, where
 * everything scales with the viewport so it reads from the back of a room.
 */

interface Props {
  categories: ThemeCategory[]
  /** Answers with a category assigned. Lags `total` while classification catches up. */
  classified: number
  /** All answers received, assigned or not. Bars are a share of this. */
  total: number
  status: ThemeSetStatus
  /** WAITING only: answers needed before categories appear. */
  need?: number
  variant?: 'panel' | 'stage'
}

const T = {
  panel: {
    label: '0.875rem', count: '0.875rem', desc: '0.75rem', note: '0.6875rem',
    bar: 3, gap: '0.875rem',
  },
  stage: {
    label: 'clamp(13px, 2.1vw, 40px)',
    count: 'clamp(15px, 2.4vw, 46px)',
    desc: 'clamp(10px, 1.5vw, 26px)',
    note: 'clamp(9px, 1.3vw, 22px)',
    bar: 10,
    gap: 'clamp(10px, 1.8vw, 30px)',
  },
} as const

export default function ThemeBars({
  categories, classified, total, status, need, variant = 'panel',
}: Props) {
  const t = T[variant]

  // Before there is anything to show, say how far off it is rather than going blank.
  // This is also the only thing on screen during the pause before the first cluster.
  if (status === 'WAITING' || categories.length === 0) {
    const have = total
    const target = need ?? 0
    // `need` stays at the threshold while `total` keeps climbing past it, so counting up
    // to it only makes sense while it is still ahead. Otherwise the line reads 12 of 8.
    const counting = target > 0 && have < target
    return (
      <div className="text-center py-4">
        <p className="text-muted" style={{ fontSize: t.desc }}>
          {counting
            ? `Finding themes… ${have} of ${target} answers`
            : `Finding themes in ${have} answer${have === 1 ? '' : 's'}…`}
        </p>
        {counting && (
          <div
            className="mx-auto mt-2 rounded-full bg-surface-2 overflow-hidden"
            style={{ height: 4, maxWidth: variant === 'stage' ? '40%' : '60%' }}
          >
            <div
              className="h-full rounded-full transition-all duration-500 ease-out"
              style={{ width: `${Math.min(100, (have / target) * 100)}%`, background: 'var(--signal)' }}
            />
          </div>
        )}
      </div>
    )
  }

  // Biggest first, but Forming is pinned last however large it grows — it is a holding
  // area, not a finding, and sorting it to the top would read as the class's main answer.
  const ordered = [
    ...categories.filter((c) => !c.isOther).sort((a, b) => b.count - a.count),
    ...categories.filter((c) => c.isOther),
  ]

  const denominator = Math.max(total, 1)
  const pending = Math.max(0, total - classified)

  return (
    <div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: t.gap }}>
        {ordered.map((cat, i) => {
          // Share of every answer received, not of those sorted so far. Bars then only
          // ever grow toward their true share instead of rescaling under each other as
          // classification catches up.
          const pct = Math.round((cat.count / denominator) * 100)
          return (
            // Two elements rather than one: `rise-in` ends at opacity 1 and holds it, so
            // a category that carries its own dimming needs that dimming on a parent the
            // animation is not touching, or Forming would quietly brighten to full.
            <div key={cat.id} style={{ opacity: cat.isOther ? 0.55 : 1 }}>
              <div className="rise-in" style={{ animationDelay: `${i * 70}ms` }}>
                <div className="flex items-baseline justify-between gap-3 mb-1">
                  <span
                    className="font-semibold text-ink truncate"
                    style={{ fontSize: t.label }}
                  >
                    {cat.label}
                  </span>
                  <span
                    className="font-mono font-bold text-ink shrink-0 tabular-nums"
                    style={{ fontSize: t.count }}
                  >
                    {cat.count}
                  </span>
                </div>
                <div
                  className="rounded-full bg-surface-2 overflow-hidden"
                  style={{ height: t.bar }}
                >
                  <div
                    // Sweeps out from zero the first time this category exists, then hands
                    // over to the width transition for every later change. Both land on
                    // scaleX(1), so the animation holding its end state costs nothing.
                    className="h-full rounded-full bar-grow transition-all duration-700 ease-out"
                    style={{
                      width: `${pct}%`,
                      background: cat.isOther ? 'var(--muted)' : 'var(--signal)',
                    }}
                  />
                </div>
                {/* The label is a handle; this sentence is the actual finding. Worth the
                    vertical space on a projector too — a room reads "Caveats and limits of
                    the ratio" and learns nothing it did not already know. */}
                <p className="text-muted leading-snug italic line-clamp-2 mt-1.5" style={{ fontSize: t.desc }}>
                  {cat.description}
                </p>
              </div>
            </div>
          )
        })}
      </div>

      {/* Honest about a lagging classifier rather than quietly showing partial counts. */}
      {pending > 0 && (
        <p className="text-muted mt-3" style={{ fontSize: t.note }}>
          {classified} of {total} sorted{status === 'RECLUSTERING' ? ' · regrouping' : ''}
        </p>
      )}
    </div>
  )
}
