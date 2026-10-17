import { useState } from 'react'
import type { GradebookStudentRow } from 'shared'

type Metric = 'participation' | 'homework'

interface Props {
  /** The students in view: the section filter applies here, the NetID search does not. */
  students: GradebookStudentRow[]
  /** Shown beside the title when the view is narrowed to a section. */
  sectionLabel: string | null
  /** Percent the participation max is reduced by, 0–100. */
  reduction: number
  onReductionChange: (pct: number) => void
}

const BINS = 10
const W = 360
// Two label rows above the plot: the peak count, then the mean's label beneath it, so
// the two never collide however far left the mean sits.
const H = 148
const PAD = { top: 30, right: 4, bottom: 20, left: 4 }
const GAP = 2

/**
 * A student's participation as a fraction, with the max reduced by `reduction` percent.
 *
 * The reduction forgives missed questions: with 30 asked and 20% off, 24 is full marks. It
 * caps at 1, so a student who answered more than the reduced max does not pass 100%.
 */
export function adjustedParticipation(s: GradebookStudentRow, reduction: number): number | null {
  if (s.participationMax <= 0) return null
  const max = s.participationMax * (1 - reduction / 100)
  if (max <= 0) return 1
  return Math.min(1, s.participationTotal / max)
}

function homeworkFraction(s: GradebookStudentRow): number | null {
  return s.hwMax > 0 ? s.hwTotal / s.hwMax : null
}

function summarize(values: number[]) {
  const n = values.length
  const sorted = [...values].sort((a, b) => a - b)
  const mean = values.reduce((a, b) => a + b, 0) / n
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2
  const sd = Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / n)
  return { n, mean, median, sd, min: sorted[0], max: sorted[n - 1] }
}

const pct = (v: number) => `${Math.round(v * 100)}%`

/**
 * Distribution of participation or homework scores, as a histogram in tenths, with
 * summary statistics beside it.
 *
 * Fixed width rather than full width: ten bars stretched across a wide screen turn into
 * slabs and the shape gets harder to read, not easier. The statistics take the space left.
 */
export default function GradeDistribution({ students, sectionLabel, reduction, onReductionChange }: Props) {
  const hasHomework = students.some((s) => s.hwMax > 0)
  const hasParticipation = students.some((s) => s.participationMax > 0)
  const [picked, setPicked] = useState<Metric>('participation')
  const metric: Metric = !hasParticipation && hasHomework ? 'homework' : !hasHomework ? 'participation' : picked
  const [hover, setHover] = useState<number | null>(null)

  const values = students
    .map((s) => (metric === 'participation' ? adjustedParticipation(s, reduction) : homeworkFraction(s)))
    .filter((v): v is number => v !== null)

  if (values.length === 0) return null

  const stats = summarize(values)
  const counts = Array.from({ length: BINS }, () => 0)
  for (const v of values) counts[Math.min(BINS - 1, Math.floor(v * BINS))]++
  const peak = Math.max(...counts)

  const plotW = W - PAD.left - PAD.right
  const plotH = H - PAD.top - PAD.bottom
  const binW = plotW / BINS
  const barH = (c: number) => (peak > 0 ? (c / peak) * plotH : 0)
  const baseline = PAD.top + plotH

  // The largest max in view, for the "out of" line. Sections can differ by a session.
  const fullMax = Math.max(0, ...students.map((s) => s.participationMax))
  const reducedMax = Math.round(fullMax * (1 - reduction / 100) * 10) / 10

  return (
    <div className="bg-surface border border-hairline rounded-[14px] p-4 flex flex-wrap gap-x-8 gap-y-4">
      {/* Chart */}
      <div className="w-full max-w-[360px]">
        <div className="flex items-center justify-between gap-2 mb-2">
          <p className="text-xs font-medium text-muted uppercase tracking-wide">
            Distribution{sectionLabel && <span className="normal-case tracking-normal"> · {sectionLabel}</span>}
          </p>
          {hasParticipation && hasHomework && (
            <div className="inline-flex rounded-full border border-hairline overflow-hidden text-xs">
              {(['participation', 'homework'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setPicked(m)}
                  aria-pressed={metric === m}
                  className={`px-2.5 py-0.5 transition-colors ${metric === m ? 'bg-surface-2 text-ink font-medium' : 'text-muted hover:text-ink-2'}`}
                >
                  {m === 'participation' ? 'Participation' : 'Homework'}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="relative">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="w-full h-auto block"
            role="img"
            aria-label={`${metric === 'participation' ? 'Participation' : 'Homework'} scores in tenths: ${counts.map((c, i) => `${i * 10}–${i * 10 + 10}%: ${c}`).join(', ')}`}
            onMouseLeave={() => setHover(null)}
          >
            {/* Baseline and peak gridline, recessive */}
            <line x1={PAD.left} x2={W - PAD.right} y1={baseline} y2={baseline} stroke="var(--hairline-strong)" strokeWidth={1} />
            <line x1={PAD.left} x2={W - PAD.right} y1={PAD.top} y2={PAD.top} stroke="var(--hairline)" strokeWidth={1} strokeDasharray="2 3" />
            <text x={PAD.left} y={10} fontSize={10} fill="var(--muted)">Peak: {peak} student{peak !== 1 ? 's' : ''}</text>

            {counts.map((c, i) => {
              const h = barH(c)
              const x = PAD.left + i * binW + GAP / 2
              const w = binW - GAP
              const y = baseline - h
              const r = Math.min(4, h, w / 2)
              return (
                <g key={i} onMouseEnter={() => setHover(i)}>
                  {/* Hit target: the whole column, not just the bar */}
                  <rect x={PAD.left + i * binW} y={PAD.top} width={binW} height={plotH} fill="transparent" />
                  {h > 0 && (
                    <path
                      d={`M${x},${baseline} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${baseline} Z`}
                      fill="var(--signal)"
                      opacity={hover === null || hover === i ? 1 : 0.45}
                    />
                  )}
                </g>
              )
            })}

            {/* Mean marker, labelled where it stands. Past three quarters the label hangs
                to the left of the line so it stays inside the chart. */}
            {(() => {
              const mx = PAD.left + stats.mean * plotW
              const flip = stats.mean > 0.75
              return (
                <g pointerEvents="none">
                  <line
                    x1={mx} x2={mx} y1={PAD.top - 12} y2={baseline}
                    stroke="var(--ink-2)" strokeWidth={1.5} strokeDasharray="3 3"
                  />
                  <text
                    x={flip ? mx - 4 : mx + 4}
                    y={PAD.top - 4}
                    fontSize={10}
                    fill="var(--ink-2)"
                    textAnchor={flip ? 'end' : 'start'}
                  >
                    Mean {pct(stats.mean)}
                  </text>
                </g>
              )
            })()}

            {[0, 0.5, 1].map((t) => (
              <text
                key={t}
                x={PAD.left + t * plotW}
                y={H - 6}
                fontSize={10}
                fill="var(--muted)"
                textAnchor={t === 0 ? 'start' : t === 1 ? 'end' : 'middle'}
              >
                {t * 100}%
              </text>
            ))}
          </svg>

          {hover !== null && (
            <div
              className="absolute pointer-events-none -translate-x-1/2 -translate-y-full bg-surface border border-hairline rounded-sm shadow-pop px-2 py-1 text-xs whitespace-nowrap"
              style={{
                left: `${((PAD.left + (hover + 0.5) * binW) / W) * 100}%`,
                top: `${((baseline - barH(counts[hover])) / H) * 100}%`,
              }}
            >
              <span className="text-muted">{hover * 10}–{hover * 10 + 10}%</span>{' '}
              <span className="font-mono font-medium text-ink">{counts[hover]}</span>
              <span className="text-muted"> student{counts[hover] !== 1 ? 's' : ''}</span>
            </div>
          )}
        </div>
      </div>

      {/* Stats and the participation reduction */}
      <div className="flex-1 min-w-[220px] flex flex-col gap-4">
        <dl className="grid grid-cols-3 gap-x-6 gap-y-3">
          {([
            ['Mean', pct(stats.mean)],
            ['Median', pct(stats.median)],
            ['Std dev', pct(stats.sd)],
            ['Lowest', pct(stats.min)],
            ['Highest', pct(stats.max)],
            ['Students', String(stats.n)],
          ] as const).map(([label, value]) => (
            <div key={label}>
              <dt className="text-[10px] text-muted uppercase tracking-wide">{label}</dt>
              <dd className="text-base font-bold font-mono text-ink leading-tight">{value}</dd>
            </div>
          ))}
        </dl>

        {metric === 'participation' && (
          <div className="border-t border-hairline pt-3">
            <label className="flex items-center gap-2 text-sm text-ink-2">
              Reduce P max by
              <input
                type="number"
                min={0}
                max={90}
                step={5}
                value={reduction}
                onChange={(e) => {
                  const v = parseFloat(e.target.value)
                  onReductionChange(Number.isNaN(v) ? 0 : Math.min(90, Math.max(0, v)))
                }}
                className="w-16 border border-hairline rounded-sm px-2 py-1 text-sm font-mono bg-surface focus:outline-none focus:ring-2 focus:ring-signal"
              />
              %
            </label>
            <p className="text-xs text-muted mt-1.5">
              {reduction > 0
                ? <>Full marks at <span className="font-mono text-ink-2">{reducedMax}</span> of <span className="font-mono text-ink-2">{fullMax}</span>. Applies to this chart and these stats only; the table keeps the real totals.</>
                : 'Forgive a share of missed questions. Applies to this chart and these stats only.'}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
