import { Check } from 'lucide-react'
import type { QuestionWithResponses } from 'shared'

interface Props {
  question: QuestionWithResponses
}

export default function ResultsSummary({ question }: Props) {
  const { type, options, responses, correctAnswer } = question
  const total = responses.length
  if (total === 0) return null

  if (type === 'MULTIPLE_CHOICE' && options) {
    const counts = Object.fromEntries(options.map((o) => [o, 0]))
    for (const r of responses) {
      if (r.responseText in counts) counts[r.responseText]++
    }
    const max = Math.max(...Object.values(counts), 1)

    return (
      <div className="bg-surface border border-hairline rounded-[14px] p-5 mb-5 space-y-3">
        {options.map((opt) => {
          const count = counts[opt]
          const pct = total > 0 ? Math.round((count / total) * 100) : 0
          const isCorrect = correctAnswer != null && opt === correctAnswer
          return (
            <div key={opt}>
              <div className="flex items-center justify-between text-sm mb-1">
                <span className={`truncate max-w-[70%] flex items-center gap-1 ${isCorrect ? 'text-good font-medium' : 'text-ink-2'}`}>
                  {isCorrect && <Check size={12} className="shrink-0 text-good" />}
                  {opt}
                </span>
                <span className="text-muted shrink-0 ml-2 font-mono">{count} <span className="text-muted">({pct}%)</span></span>
              </div>
              <div className="h-3 bg-surface-2 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${isCorrect ? 'bg-good' : 'bg-signal'}`}
                  style={{ width: `${(count / max) * 100}%` }}
                />
              </div>
            </div>
          )
        })}
        <p className="text-xs text-muted pt-1 font-mono">{total} response{total !== 1 ? 's' : ''}</p>
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
      <div className="bg-surface border border-hairline rounded-[14px] p-5 mb-5">
        <div className="flex items-end gap-2 h-24 mb-2">
          {[1, 2, 3, 4, 5].map((n) => {
            const count = counts[n]
            const heightPct = (count / max) * 100
            return (
              <div key={n} className="flex-1 flex flex-col items-center gap-1">
                <span className="text-xs text-muted font-mono">{count > 0 ? count : ''}</span>
                <div className="w-full bg-surface-2 rounded-t-md overflow-hidden" style={{ height: '64px' }}>
                  <div
                    className="w-full bg-signal rounded-t-md transition-all duration-500 absolute bottom-0"
                    style={{ height: `${heightPct}%`, position: 'relative', marginTop: `${100 - heightPct}%` }}
                  />
                </div>
                <span className="text-xs font-medium text-ink-2 font-mono">{n}</span>
              </div>
            )
          })}
        </div>
        <div className="flex items-center justify-between text-xs text-muted mt-2">
          <span className="font-mono">{total} response{total !== 1 ? 's' : ''}</span>
          <span className="text-ink font-semibold text-sm font-mono">avg {avg}</span>
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
      <div className="bg-surface border border-hairline rounded-[14px] p-5 mb-5">
        <div className="flex gap-3 mb-3">
          <div className="flex-1 text-center">
            <p className={`text-3xl font-bold font-mono ${yesIsCorrect ? 'text-good' : correctAnswer ? 'text-muted' : 'text-good'}`}>
              {yesPct}%
            </p>
            <p className="text-sm text-muted mt-0.5 flex items-center justify-center gap-1">
              {yesIsCorrect && <Check size={11} className="text-good" />}
              Yes · {yes}
            </p>
          </div>
          <div className="flex-1 text-center">
            <p className={`text-3xl font-bold font-mono ${noIsCorrect ? 'text-good' : 'text-muted'}`}>
              {noPct}%
            </p>
            <p className="text-sm text-muted mt-0.5 flex items-center justify-center gap-1">
              {noIsCorrect && <Check size={11} className="text-good" />}
              No · {no}
            </p>
          </div>
        </div>
        <div className="flex h-3 rounded-full overflow-hidden bg-surface-2">
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
        <p className="text-xs text-muted mt-2 font-mono">{total} response{total !== 1 ? 's' : ''}</p>
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
      <div className="bg-surface border border-hairline rounded-[14px] p-5 mb-5 space-y-3">
        {options.map((opt) => {
          const count = counts[opt]
          const pct = total > 0 ? Math.round((count / total) * 100) : 0
          const isCorrect = correctSet.size > 0 && correctSet.has(opt)
          return (
            <div key={opt}>
              <div className="flex items-center justify-between text-sm mb-1">
                <span className={`truncate max-w-[70%] flex items-center gap-1 ${isCorrect ? 'text-good font-medium' : 'text-ink-2'}`}>
                  {isCorrect && <Check size={12} className="shrink-0 text-good" />}
                  {opt}
                </span>
                <span className="text-muted shrink-0 ml-2 font-mono">{count} <span className="text-muted">({pct}%)</span></span>
              </div>
              <div className="h-3 bg-surface-2 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${isCorrect ? 'bg-good' : 'bg-signal'}`}
                  style={{ width: `${(count / max) * 100}%` }}
                />
              </div>
            </div>
          )
        })}
        <p className="text-xs text-muted pt-1 font-mono">{total} response{total !== 1 ? 's' : ''}</p>
      </div>
    )
  }

  if (type === 'FREE_TEXT') {
    const flagged = responses.filter((r) => r.isFlagged).length
    return (
      <div className="flex items-center gap-6 bg-surface border border-hairline rounded-[14px] px-5 py-3 mb-5">
        <div>
          <p className="text-2xl font-bold text-ink font-mono">{total}</p>
          <p className="text-xs text-muted">responses</p>
        </div>
        {flagged > 0 && (
          <div>
            <p className="text-2xl font-bold text-warn font-mono">{flagged}</p>
            <p className="text-xs text-muted">short (&lt;10 words)</p>
          </div>
        )}
        {total > 0 && (
          <div>
            <p className="text-2xl font-bold text-ink-2 font-mono">
              {Math.round(responses.reduce((s, r) => s + r.wordCount, 0) / total)}
            </p>
            <p className="text-xs text-muted">avg words</p>
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

    const MAX_ORDERINGS = 6
    const displayed = sorted.slice(0, MAX_ORDERINGS)
    const remaining = sorted.slice(MAX_ORDERINGS).reduce((s, g) => s + g.count, 0)
    const remainingGroups = sorted.length - MAX_ORDERINGS

    return (
      <div className="bg-surface border border-hairline rounded-[14px] p-5 mb-5 space-y-3">
        {displayed.map((group, i) => (
          <div
            key={i}
            className={`rounded-sm p-3 border ${group.isExactMatch ? 'border-good/30 bg-good-soft' : 'border-hairline bg-surface-2'}`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex flex-wrap gap-1 flex-1 min-w-0">
                {group.items.map((item, idx) => (
                  <span
                    key={idx}
                    className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded border font-mono ${
                      group.isExactMatch
                        ? 'bg-good-soft border-good/20 text-good'
                        : 'bg-surface border-hairline text-ink-2'
                    }`}
                  >
                    <span className="text-muted">{idx + 1}.</span>
                    {item}
                  </span>
                ))}
              </div>
              <span
                className={`shrink-0 text-xs font-mono font-bold px-2 py-0.5 rounded-full ${
                  group.isExactMatch ? 'bg-good text-white' : 'bg-surface text-ink-2 border border-hairline'
                }`}
              >
                {group.count}
              </span>
            </div>
            {group.isExactMatch && (
              <p className="text-[10px] text-good mt-1.5 flex items-center gap-0.5">
                <Check size={10} /> Correct order
              </p>
            )}
          </div>
        ))}
        {remaining > 0 && (
          <p className="text-xs text-muted font-mono pl-1">
            and {remaining} response{remaining !== 1 ? 's' : ''} in {remainingGroups} more ordering{remainingGroups !== 1 ? 's' : ''}
          </p>
        )}
        <p className="text-xs text-muted pt-1 font-mono">{total} response{total !== 1 ? 's' : ''}</p>
      </div>
    )
  }

  return null
}
