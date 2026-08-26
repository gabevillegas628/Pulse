import { Check } from 'lucide-react'
import type { QuestionWithResponses } from 'shared'

/**
 * Counts and distributions for every question type. Aggregate only — it renders totals
 * and shares, never an individual response or a student, which is what lets `/present`
 * put it on a projector.
 *
 * Two variants, the same split `ThemeBars` uses: `panel` is the professor's task pane at
 * fixed type sizes, `stage` is the lecture hall, where everything scales with the viewport
 * so it reads from the back of the room. Without that split the distribution stayed at
 * task-pane size next to a counter set in `clamp(38px, 9vw, 170px)`, so the one number
 * nobody needed help reading dwarfed the answer everybody did.
 *
 * On stage the card chrome goes too: a bordered box inside an already-framed slide object
 * is one frame too many, and the space it costs is better spent on the bars.
 */

interface Props {
  question: QuestionWithResponses
  variant?: 'panel' | 'stage'
}

const T = {
  panel: {
    label: '0.875rem', count: '0.875rem', note: '0.75rem', tiny: '0.625rem',
    big: '1.5rem', huge: '1.875rem',
    bar: '12px', gap: '0.75rem', check: '12px',
    ratingCol: '64px', ratingRow: '96px',
  },
  stage: {
    label: 'clamp(13px, 2.1vw, 40px)',
    count: 'clamp(13px, 2.1vw, 40px)',
    note: 'clamp(9px, 1.3vw, 22px)',
    tiny: 'clamp(8px, 1.1vw, 18px)',
    big: 'clamp(20px, 3.4vw, 62px)',
    huge: 'clamp(24px, 4.4vw, 84px)',
    bar: 'clamp(8px, 1.5vw, 28px)',
    gap: 'clamp(8px, 1.5vw, 26px)',
    check: 'clamp(11px, 1.7vw, 32px)',
    ratingCol: 'clamp(48px, 9vw, 170px)',
    ratingRow: 'clamp(72px, 13vw, 240px)',
  },
} as const

export default function ResultsSummary({ question, variant = 'panel' }: Props) {
  const { type, options, responses, correctAnswer } = question
  const total = responses.length
  if (total === 0) return null

  const t = T[variant]
  const stage = variant === 'stage'
  // Panel keeps its card; stage lets the page provide the frame.
  const card = stage ? '' : 'bg-surface border border-hairline rounded-[14px] p-5 mb-5'
  const column = { display: 'flex', flexDirection: 'column' as const, gap: t.gap }
  // Lucide writes width/height as attributes, which CSS overrides — so the clamp lands.
  const checkStyle = { width: t.check, height: t.check }

  if (type === 'MULTIPLE_CHOICE' && options) {
    const counts = Object.fromEntries(options.map((o) => [o, 0]))
    for (const r of responses) {
      if (r.responseText in counts) counts[r.responseText]++
    }
    const max = Math.max(...Object.values(counts), 1)

    return (
      <div className={card} style={column}>
        {options.map((opt) => {
          const count = counts[opt]
          const pct = total > 0 ? Math.round((count / total) * 100) : 0
          const isCorrect = correctAnswer != null && opt === correctAnswer
          return (
            <div key={opt}>
              <div className="flex items-center justify-between mb-1" style={{ fontSize: t.label }}>
                <span className={`truncate max-w-[70%] flex items-center gap-1 ${isCorrect ? 'text-good font-medium' : 'text-ink-2'}`}>
                  {isCorrect && <Check size={12} style={checkStyle} className="shrink-0 text-good" />}
                  {opt}
                </span>
                <span className="text-muted shrink-0 ml-2 font-mono tabular-nums" style={{ fontSize: t.count }}>
                  {count} <span className="text-muted">({pct}%)</span>
                </span>
              </div>
              <div className="bg-surface-2 rounded-full overflow-hidden" style={{ height: t.bar }}>
                <div
                  // Sweeps out from zero the first time the option paints, then the width
                  // transition carries every later change.
                  className={`h-full rounded-full bar-grow transition-all duration-500 ${isCorrect ? 'bg-good' : 'bg-signal'}`}
                  style={{ width: `${(count / max) * 100}%` }}
                />
              </div>
            </div>
          )
        })}
        <p className="text-muted font-mono" style={{ fontSize: t.note }}>{total} response{total !== 1 ? 's' : ''}</p>
      </div>
    )
  }

  if (type === 'RATING') {
    const counts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
    let sum = 0
    for (const r of responses) {
      const n = parseInt(r.responseText)
      if (n >= 1 && n <= 5) { counts[n]++; sum += n }
    }
    const avg = total > 0 ? (sum / total).toFixed(1) : '—'
    const max = Math.max(...Object.values(counts), 1)

    return (
      <div className={card}>
        <div className="flex items-end gap-2 mb-2" style={{ height: t.ratingRow }}>
          {[1, 2, 3, 4, 5].map((n) => {
            const count = counts[n]
            const heightPct = (count / max) * 100
            return (
              <div key={n} className="flex-1 flex flex-col items-center gap-1">
                <span className="text-muted font-mono" style={{ fontSize: t.note }}>{count > 0 ? count : ''}</span>
                {/* Bottom-aligned by flex. The column was previously positioned with a
                    percentage top margin, which resolves against the container width
                    rather than its height, so the bars sat wherever the layout was wide. */}
                <div
                  className="w-full bg-surface-2 rounded-t-md overflow-hidden flex items-end"
                  style={{ height: t.ratingCol }}
                >
                  <div
                    className="w-full bg-signal rounded-t-md transition-all duration-500"
                    style={{ height: `${heightPct}%` }}
                  />
                </div>
                <span className="font-medium text-ink-2 font-mono" style={{ fontSize: t.note }}>{n}</span>
              </div>
            )
          })}
        </div>
        <div className="flex items-center justify-between text-muted mt-2" style={{ fontSize: t.note }}>
          <span className="font-mono">{total} response{total !== 1 ? 's' : ''}</span>
          <span className="text-ink font-semibold font-mono" style={{ fontSize: t.label }}>avg {avg}</span>
        </div>
      </div>
    )
  }

  if (type === 'YES_NO') {
    const yes = responses.filter((r) => r.responseText === 'yes').length
    const no  = responses.filter((r) => r.responseText === 'no').length
    const yesPct = total > 0 ? Math.round((yes / total) * 100) : 0
    const noPct  = total > 0 ? Math.round((no  / total) * 100) : 0
    const yesIsCorrect = correctAnswer === 'Yes'
    const noIsCorrect  = correctAnswer === 'No'

    return (
      <div className={card}>
        <div className="flex gap-3 mb-3">
          <div className="flex-1 text-center">
            <p
              className={`font-bold font-mono tabular-nums ${yesIsCorrect ? 'text-good' : correctAnswer ? 'text-muted' : 'text-good'}`}
              style={{ fontSize: t.huge }}
            >
              {yesPct}%
            </p>
            <p className="text-muted mt-0.5 flex items-center justify-center gap-1" style={{ fontSize: t.label }}>
              {yesIsCorrect && <Check size={11} style={checkStyle} className="text-good" />}
              Yes · {yes}
            </p>
          </div>
          <div className="flex-1 text-center">
            <p
              className={`font-bold font-mono tabular-nums ${noIsCorrect ? 'text-good' : 'text-muted'}`}
              style={{ fontSize: t.huge }}
            >
              {noPct}%
            </p>
            <p className="text-muted mt-0.5 flex items-center justify-center gap-1" style={{ fontSize: t.label }}>
              {noIsCorrect && <Check size={11} style={checkStyle} className="text-good" />}
              No · {no}
            </p>
          </div>
        </div>
        <div className="flex rounded-full overflow-hidden bg-surface-2" style={{ height: t.bar }}>
          {yesPct > 0 && (
            <div
              className={`transition-all duration-500 ${yesIsCorrect ? 'bg-good' : 'bg-signal'}`}
              style={{ width: `${yesPct}%` }}
            />
          )}
          {noPct > 0 && (
            <div
              className={`transition-all duration-500 ${noIsCorrect ? 'bg-good' : 'bg-hairline-strong'}`}
              style={{ width: `${noPct}%` }}
            />
          )}
        </div>
        <p className="text-muted mt-2 font-mono" style={{ fontSize: t.note }}>{total} response{total !== 1 ? 's' : ''}</p>
      </div>
    )
  }

  if (type === 'MULTI_SELECT' && options) {
    let correctSet: Set<string> = new Set()
    if (correctAnswer) {
      try { correctSet = new Set(JSON.parse(correctAnswer) as string[]) } catch { /* ignore */ }
    }

    const counts = Object.fromEntries(options.map((o) => [o, 0]))
    for (const r of responses) {
      try {
        const arr: string[] = JSON.parse(r.responseText)
        for (const item of arr) {
          if (item in counts) counts[item]++
        }
      } catch { /* skip malformed */ }
    }
    const max = Math.max(...Object.values(counts), 1)

    return (
      <div className={card} style={column}>
        {options.map((opt) => {
          const count = counts[opt]
          const pct = total > 0 ? Math.round((count / total) * 100) : 0
          const isCorrect = correctSet.size > 0 && correctSet.has(opt)
          return (
            <div key={opt}>
              <div className="flex items-center justify-between mb-1" style={{ fontSize: t.label }}>
                <span className={`truncate max-w-[70%] flex items-center gap-1 ${isCorrect ? 'text-good font-medium' : 'text-ink-2'}`}>
                  {isCorrect && <Check size={12} style={checkStyle} className="shrink-0 text-good" />}
                  {opt}
                </span>
                <span className="text-muted shrink-0 ml-2 font-mono tabular-nums" style={{ fontSize: t.count }}>
                  {count} <span className="text-muted">({pct}%)</span>
                </span>
              </div>
              <div className="bg-surface-2 rounded-full overflow-hidden" style={{ height: t.bar }}>
                <div
                  className={`h-full rounded-full bar-grow transition-all duration-500 ${isCorrect ? 'bg-good' : 'bg-signal'}`}
                  style={{ width: `${(count / max) * 100}%` }}
                />
              </div>
            </div>
          )
        })}
        <p className="text-muted font-mono" style={{ fontSize: t.note }}>{total} response{total !== 1 ? 's' : ''}</p>
      </div>
    )
  }

  if (type === 'FREE_TEXT') {
    const flagged = responses.filter((r) => r.isFlagged).length
    return (
      <div
        className={stage ? 'flex items-center' : 'flex items-center bg-surface border border-hairline rounded-[14px] px-5 py-3 mb-5'}
        style={{ gap: stage ? t.gap : '1.5rem' }}
      >
        <div>
          <p className="font-bold text-ink font-mono tabular-nums" style={{ fontSize: t.big }}>{total}</p>
          <p className="text-muted" style={{ fontSize: t.note }}>responses</p>
        </div>
        {flagged > 0 && (
          <div>
            <p className="font-bold text-warn font-mono tabular-nums" style={{ fontSize: t.big }}>{flagged}</p>
            <p className="text-muted" style={{ fontSize: t.note }}>short (&lt;10 words)</p>
          </div>
        )}
        {total > 0 && (
          <div>
            <p className="font-bold text-ink-2 font-mono tabular-nums" style={{ fontSize: t.big }}>
              {Math.round(responses.reduce((s, r) => s + r.wordCount, 0) / total)}
            </p>
            <p className="text-muted" style={{ fontSize: t.note }}>avg words</p>
          </div>
        )}
      </div>
    )
  }

  if (type === 'ORDERING') {
    let correctArr: string[] | null = null
    if (correctAnswer) {
      try { correctArr = JSON.parse(correctAnswer) } catch { /* ignore */ }
    }

    const groupMap = new Map<string, { items: string[]; count: number; isExactMatch: boolean }>()
    for (const r of responses) {
      let arr: string[]
      try { arr = JSON.parse(r.responseText) } catch { continue }
      const key = JSON.stringify(arr)
      if (!groupMap.has(key)) {
        const isExactMatch =
          correctArr != null &&
          correctArr.length === arr.length &&
          correctArr.every((v, i) => v === arr[i])
        groupMap.set(key, { items: arr, count: 0, isExactMatch })
      }
      groupMap.get(key)!.count++
    }

    const allGroups = [...groupMap.values()]
    const exactMatches = allGroups.filter((g) => g.isExactMatch).sort((a, b) => b.count - a.count)
    const others = allGroups.filter((g) => !g.isExactMatch).sort((a, b) => b.count - a.count)
    const sorted = [...exactMatches, ...others]

    // Each ordering is a row of chips, so on stage they cost several times the height
    // they do in the panel. Fewer of them, or the tail pushes the rest off the slide.
    const MAX_ORDERINGS = stage ? 4 : 6
    const displayed = sorted.slice(0, MAX_ORDERINGS)
    const remaining = sorted.slice(MAX_ORDERINGS).reduce((s, g) => s + g.count, 0)
    const remainingGroups = sorted.length - MAX_ORDERINGS

    return (
      <div className={card} style={column}>
        {displayed.map((group, i) => (
          <div
            key={i}
            className={`rounded-sm border ${group.isExactMatch ? 'border-good/30 bg-good-soft' : 'border-hairline bg-surface-2'}`}
            style={{ padding: stage ? t.gap : '0.75rem' }}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex flex-wrap gap-1 flex-1 min-w-0">
                {group.items.map((item, idx) => (
                  <span
                    key={idx}
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border font-mono ${
                      group.isExactMatch
                        ? 'bg-good-soft border-good/20 text-good'
                        : 'bg-surface border-hairline text-ink-2'
                    }`}
                    style={{ fontSize: t.note }}
                  >
                    <span className="text-muted">{idx + 1}.</span>
                    {item}
                  </span>
                ))}
              </div>
              <span
                className={`shrink-0 font-mono font-bold px-2 py-0.5 rounded-full tabular-nums ${
                  group.isExactMatch ? 'bg-good text-white' : 'bg-surface text-ink-2 border border-hairline'
                }`}
                style={{ fontSize: t.note }}
              >
                {group.count}
              </span>
            </div>
            {group.isExactMatch && (
              <p className="text-good mt-1.5 flex items-center gap-0.5" style={{ fontSize: t.tiny }}>
                <Check size={10} style={checkStyle} /> Correct order
              </p>
            )}
          </div>
        ))}
        {remaining > 0 && (
          <p className="text-muted font-mono pl-1" style={{ fontSize: t.note }}>
            and {remaining} response{remaining !== 1 ? 's' : ''} in {remainingGroups} more ordering{remainingGroups !== 1 ? 's' : ''}
          </p>
        )}
        <p className="text-muted font-mono" style={{ fontSize: t.note }}>{total} response{total !== 1 ? 's' : ''}</p>
      </div>
    )
  }

  return null
}
