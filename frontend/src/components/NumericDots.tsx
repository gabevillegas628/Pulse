import { useEffect, useRef, useState } from 'react'
import { normalizeNumeric, parseValueUnit } from '@/lib/scoring'

/**
 * Every numeric answer as one dot, in ascending order of value.
 *
 * Bars were tried first and lost on the projector for two structural reasons. A fixed cap
 * plus an "and 40 answers across 39 other values" footer leaves most of a class
 * unrenderable; and sorting by frequency hands the top slots to whatever concentrates, so
 * one shared mistake outranks a correct answer the room spelled several ways.
 *
 * Here nothing is hidden — every response is a dot — and position is rank, not distance.
 * Columns sit one step apart because they are the next distinct answer, never because they
 * are that far apart, so an axis spanning eight orders of magnitude cannot squash the
 * interesting part. A log axis was the other candidate and it fails on real data: a class
 * asked "what percent" writes 0 more often than anything else, and log has no position for
 * zero.
 *
 * Answers that are not numbers are not dropped. They dock to the left with their own count,
 * because "close to 0" on a question about a vanishing fraction is a student who understood
 * it, and a chart that silently discards them is lying about its own total.
 *
 * Two variants, the split `ResultsSummary` and `ThemeBars` use: `panel` is the professor's
 * task pane, `stage` is the lecture hall.
 */

interface Props {
  /**
   * `inKeyGroup` is set by /addin/live, which knows the answer key but does not send it.
   * Where it is absent — the professor's own surfaces — the key is present and the same
   * grouping is worked out here instead.
   */
  responses: { responseText: string; inKeyGroup?: boolean }[]
  correctAnswer: string | null
  tolerance: number | null
  unit: string | null
  variant?: 'panel' | 'stage'
}

const T = {
  panel: {
    maxStack: 132, minR: 2, maxR: 5,
    label: '0.8125rem', count: '0.75rem', note: '0.625rem', dock: '0.625rem',
    gap: 34, labelGap: 56, labelDrop: 22, edge: 30,
  },
  stage: {
    maxStack: 300, minR: 3, maxR: 5,
    // The value labels are what a room actually reads off this chart, so they are sized
    // like a heading rather than a caption. `labelDrop` clears the axis line: at this size
    // a baseline 22px under it put the ascenders back through the rule.
    label: 'clamp(14px, 2.1vw, 36px)',
    count: 'clamp(12px, 1.7vw, 28px)',
    note: 'clamp(9px, 1.2vw, 20px)',
    dock: 'clamp(9px, 1.15vw, 19px)',
    gap: 64, labelGap: 124, labelDrop: 36, edge: 64,
  },
} as const

/**
 * The width of the box this actually sits in. The same question the textbook reader asks:
 * several of the mounts are embedded panels, so the window is never the answer.
 */
function useElementWidth(ref: React.RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState<number | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])
  return width
}

/** Short enough to sit under a column without colliding with its neighbours. */
function fmt(v: number): string {
  if (v === 0) return '0'
  const a = Math.abs(v)
  if (a < 0.0001 || a >= 1e6) return v.toExponential(1)
  return String(+v.toPrecision(6))
}

/**
 * Stable pseudo-random in [0,1). Scatter positions have to survive a re-render: a new
 * answer arrives every few seconds and re-runs this whole component, and anything drawn
 * from Math.random would reshuffle the entire cloud each time.
 */
function jitter(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}

/** One column's worth before layout: a value, or the whole key group standing as one. */
interface Entry {
  sort: number
  label: number
  count: number
  /** How many responses actually wrote `label`. Below `count` when the entry stands for a group. */
  labelCount: number
  isKey: boolean
}

export default function NumericDots({
  responses, correctAnswer, tolerance, unit, variant = 'panel',
}: Props) {
  const boxRef = useRef<HTMLDivElement>(null)
  const measured = useElementWidth(boxRef)
  const t = T[variant]
  const total = responses.length

  const [correctVal, correctUnit] = correctAnswer ? parseValueUnit(correctAnswer) : [NaN, '']
  // The key names the unit when it carries one; otherwise the question does.
  const keyUnit = correctUnit || unit || ''
  const hasKey = correctAnswer != null && !isNaN(correctVal)
  const tol = tolerance ?? 0

  const others: number[] = []
  const keyGroup: number[] = []
  let unreadable = 0
  let noUnit = 0
  for (const r of responses) {
    const p = normalizeNumeric(r.responseText, keyUnit)
    if (p.kind === 'nounit') { noUnit++; continue }
    if (p.kind === 'unreadable') { unreadable++; continue }
    const inGroup = r.inKeyGroup ?? (hasKey && Math.abs(p.value - correctVal) <= tol)
    ;(inGroup ? keyGroup : others).push(p.value)
  }
  const docked = unreadable + noUnit

  // Everything outside the key group is tallied by exact value, never by a rounded one.
  // Students who make the same mistake write the same digits; the notation they wrap them
  // in — "0%", ".001", "4.2 mmol/L" — is already folded together by the parse above, and
  // that is the only merging safe to do without a margin to justify it. Rounding to a
  // shared precision was tried and it mislabels: a class whose commonest answers run to
  // one significant figure drags 37.5 and 45 into a column reading 40.
  const tally = new Map<number, number>()
  for (const v of others) tally.set(v, (tally.get(v) ?? 0) + 1)

  const entries: Entry[] = [...tally.entries()]
    .map(([v, n]) => ({ sort: v, label: v, count: n, labelCount: n, isKey: false }))

  if (keyGroup.length > 0) {
    // The key group stands as one column, seated at the rank of the answer most students
    // actually wrote and labelled with it. That label is a real submitted value, so nothing
    // reaches the screen that was not already going to — which is what lets the projector
    // draw this column without being told what it forms around.
    const inner = new Map<number, number>()
    for (const v of keyGroup) inner.set(v, (inner.get(v) ?? 0) + 1)
    let label = keyGroup[0]
    let best = 0
    for (const [v, n] of inner) if (n > best || (n === best && v < label)) { label = v; best = n }
    entries.push({ sort: label, label, count: keyGroup.length, labelCount: best, isKey: true })
  }
  entries.sort((a, b) => a.sort - b.sort)

  if (total === 0 || entries.length === 0) {
    return docked > 0
      ? (
        <p className="text-muted font-mono" style={{ fontSize: t.note }}>
          {docked} answer{docked !== 1 ? 's' : ''}, none of them numbers
        </p>
      )
      : null
  }

  const W = measured ?? 0
  // First paint has no measurement yet. Reserve the box rather than collapsing it, so the
  // panel does not jump once the observer reports.
  if (W < 40) return <div ref={boxRef} style={{ minHeight: variant === 'stage' ? 220 : 120 }} />

  const dockW = docked > 0 ? (variant === 'stage' ? Math.min(150, W * 0.12) : 62) : 0
  const padL = dockW + (docked > 0 ? 26 : 8)
  const padR = 12
  const innerW = Math.max(60, W - padL - padR)

  // Every entry wants its own column, but a class can produce more of them than there are
  // dots' worth of room. Past that point consecutive ranks share a column — still every
  // response, still in order, just no longer claiming two neighbours are distinguishable
  // when they are a pixel apart.
  const maxCols = Math.max(1, Math.floor(innerW / (t.minR * 2)))
  const perCol = Math.max(1, Math.ceil(entries.length / maxCols))
  const cols = []
  for (let i = 0; i < entries.length; i += perCol) {
    const group = entries.slice(i, i + perCol)
    let top = group[0]
    for (const e of group) if (e.count > top.count) top = e
    cols.push({
      count: group.reduce((s, e) => s + e.count, 0),
      label: top.label,
      labelCount: top.labelCount,
      allKey: group.every((e) => e.isKey),
    })
  }

  const step = cols.length > 1 ? innerW / (cols.length - 1) : 0
  const tallest = cols.reduce((m, c) => Math.max(m, c.count), 1)
  // Deliberately not a function of the tallest column any more. It used to be, and the
  // effect on a projector was that every dot in the chart shrank as the room answered —
  // the one column that was growing quietly took the legibility of all the others with
  // it. Size is now set by how much room a column has beside its neighbours, and height
  // is bounded by capping the stack instead.
  const r = Math.max(t.minR, Math.min(t.maxR, step > 0 ? step * 0.44 : t.maxR))

  // Only the projector spills. The task pane's lanes are a few pixels wide, so a scatter
  // there would be a smear sitting directly above its own stack and no clearer than the
  // stack was — it keeps packing tighter instead, which is what small panels are for.
  const spilling = variant === 'stage'
  const capacity = spilling ? Math.max(1, Math.floor(t.maxStack / (2 * r))) : Infinity
  const stackH = Math.min(t.maxStack, Math.min(tallest, capacity) * 2 * r)
  /** Panel only: dots pack closer as a column grows, since it has nowhere to put a spill. */
  const packing = (n: number) => (n > 1 ? Math.min(2 * r, (stackH - 2 * r) / (n - 1)) : 0)

  // A column at capacity has reached the ceiling, and the dots behind it have nowhere up
  // to go — so they mushroom: out to the sides of the top dot and back down around the
  // stack, widest where they meet the ceiling and tapering as they hang. The cap lives
  // inside the height the chart already has, which is what finally stops the whole thing
  // growing as a lecture goes on.
  const capSpread = Math.min(step * 2.2, r * 16)
  const capDepthOf = (n: number) =>
    n <= capacity ? 0 : Math.min(stackH * 0.75, Math.ceil((n - capacity) / 5) * r * 2.1)
  /** How far the cap carries on past the ceiling. The rim is widest at the top dot, so a
   *  little above it reads as the dots still pushing rather than politely stopping. */
  const capRiseOf = (n: number) => capDepthOf(n) * 0.3
  const riseH = cols.reduce((m, c) => Math.max(m, capRiseOf(c.count)), 0)

  const H = stackH + t.gap + 26 + riseH
  const base = H - t.gap
  const xOf = (i: number) => padL + i * step

  // Once a key group is on the chart, every label is marked approximate — not only the
  // one that needs it. A tilde on the key group alone would point straight at it, which
  // is the same as colouring it in: the projector is not told which answer is right, so
  // it must not draw anything that says so. Where no key group exists nothing needs
  // hiding, and the labels stay exact.
  const approximate = keyGroup.length > 0

  /** Half a label's width, near enough: inside this of either edge, a label anchors inwards. */
  const EDGE = t.edge

  // Labelled where there is room, commonest first, so the biggest groups win the space. A
  // merged column can still be labelled, but only by a value that speaks for it — naming
  // one of two evenly split answers would put a number under a column that mostly is not
  // it, which is the failure the rounded bars had.
  const labelled = new Set<number>()
  const usedX: number[] = []
  for (const { c, i } of cols.map((c, i) => ({ c, i })).sort((a, b) => b.c.count - a.c.count)) {
    // The key group is a deliberate grouping rather than an accident of layout, so it
    // is always worth labelling however little of it wrote the modal value. Everything
    // else has to be spoken for by its label.
    if (c.count < 2) continue
    if (!c.allKey && c.labelCount * 2 < c.count) continue
    const x = xOf(i)
    if (usedX.some((u) => Math.abs(u - x) < t.labelGap)) continue
    usedX.push(x)
    labelled.add(i)
  }

  return (
    <div ref={boxRef}>
      <svg width={W} height={H} style={{ display: 'block', overflow: 'visible' }} role="img"
           aria-label={`${total} answers, every distinct value in ascending order`}>
        {docked > 0 && (
          <g>
            <rect x={2} y={base - stackH} width={dockW} height={stackH + 8} rx={8}
                  fill="var(--warn-soft)" stroke="var(--warn)" strokeOpacity={0.32} strokeDasharray="5 4" />
            {Array.from({ length: docked }, (_, i) => (
              <circle key={i} cx={2 + dockW / 2}
                      cy={base - r - i * (docked > 1 ? Math.min(r * 2.4, (stackH - 2 * r) / (docked - 1)) : 0)}
                      r={r * 0.9} fill="var(--warn)" />
            ))}
            <text x={2 + dockW / 2} y={base + 20} textAnchor="middle"
                  fill="var(--warn)" style={{ fontSize: t.dock, fontWeight: 600 }}>in words</text>
            <text x={2 + dockW / 2} y={base + 35} textAnchor="middle"
                  fill="var(--muted)" style={{ fontSize: t.note }}>{docked}</text>
          </g>
        )}

        <line x1={padL - 10} y1={base + 8} x2={W - padR} y2={base + 8}
              stroke="var(--hairline-strong)" strokeWidth={1.5} />

        {cols.map((c, i) => {
          const x = xOf(i)
          // Green only where the key is actually in hand. /present is not sent it, so the
          // key group draws there as an ordinary column — tall, but never marked right.
          const correct = c.allKey && hasKey
          const fill = correct ? 'var(--good)' : 'var(--signal)'
          // A column fills its lane and then spills. Every response is still a dot — the
          // ones past the cap sit above the stack instead of inside it, so a column that
          // keeps growing reads as boiling over rather than as a denser and denser stripe.
          const inStack = spilling ? Math.min(c.count, capacity) : c.count
          const over = c.count - inStack
          const dy = spilling ? 2 * r : packing(c.count)
          const capDepth = capDepthOf(c.count)
          const capRise = capRiseOf(c.count)
          /** Centre of the top dot: the ceiling the cap is widest at. */
          const ceiling = base - r - (inStack - 1) * dy
          const topY = ceiling - capRise - r
          // A centred label on the first or last column hangs half of itself off the edge,
          // which is how "0.287" was reaching the projector as ".287". The end columns
          // anchor inwards instead; everything between stays centred over its dots.
          const anchor = x < EDGE ? 'start' : x > W - EDGE ? 'end' : 'middle'
          const lx = anchor === 'start' ? 2 : anchor === 'end' ? W - 2 : x
          return (
            <g key={i}>
              {Array.from({ length: inStack }, (_, k) => (
                <circle key={k} cx={x} cy={base - r - k * dy} r={r * 0.85} fill={fill} opacity={0.9} />
              ))}
              {Array.from({ length: over }, (_, j) => {
                const seed = i * 977 + j
                // Depth below the ceiling, biased upward so the cap is dense where it is
                // widest and thins out as it hangs.
                // Distance from the ceiling, biased toward it so the cap is dense
                // where it is widest and thins out at both edges.
                const m = Math.pow(jitter(seed), 1.4)
                // Roughly a quarter carry on above the top dot; the rest hang below.
                const above = jitter(seed + 0.53) < 0.26
                const d = above ? -m * capRise : m * capDepth
                // Half-width closes to nothing at either extreme, which is what makes the
                // silhouette a cap rather than a column of noise.
                const w = capSpread * Math.sqrt(1 - m)
                return (
                  <circle
                    key={`c${j}`}
                    className="dot-drift"
                    cx={x + (jitter(seed + 0.37) * 2 - 1) * w}
                    cy={ceiling + d}
                    r={r * 0.85} fill={fill} opacity={0.78}
                    // Negative, so a dot mounting mid-lecture lands partway through its
                    // cycle rather than restarting the whole cap in step.
                    style={{ animationDelay: `${-(jitter(seed + 0.71) * 4.2).toFixed(2)}s` }}
                  />
                )
              })}
              {labelled.has(i) && (
                <>
                  <text x={lx} y={topY - 6} textAnchor={anchor}
                        fill={correct ? 'var(--good)' : 'var(--ink)'} style={{ fontSize: t.count }}>
                    {c.count}
                  </text>
                  {/* The key group is many values standing as one, so its label is
                      marked approximate. Without that, a column of 89 sitting under the
                      one answer that happened to repeat reads as 89 students writing it. */}
                  <text x={lx} y={base + t.labelDrop} textAnchor={anchor}
                        fill={correct ? 'var(--good)' : 'var(--ink-2)'} style={{ fontSize: t.label }}>
                    {approximate ? `≈${fmt(c.label)}` : fmt(c.label)}
                  </text>
                </>
              )}
            </g>
          )
        })}
      </svg>

      <p className="text-muted font-mono" style={{ fontSize: t.note, marginTop: 6 }}>
        {total} response{total !== 1 ? 's' : ''} · {entries.length} group{entries.length !== 1 ? 's' : ''}
        {noUnit > 0 && ` · ${noUnit} with no unit`}
        {hasKey && ` · key ${correctAnswer}${tol ? ` ±${tol}` : ''}`}
      </p>
    </div>
  )
}
