import type { QuestionWithResponses } from 'shared'

interface Props {
  question: QuestionWithResponses
}

export default function ResultsSummary({ question }: Props) {
  const { type, options, responses } = question
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
          return (
            <div key={opt}>
              <div className="flex items-center justify-between text-sm mb-1">
                <span className="text-ink-2 truncate max-w-[70%]">{opt}</span>
                <span className="text-muted shrink-0 ml-2 font-mono">{count} <span className="text-muted">({pct}%)</span></span>
              </div>
              <div className="h-3 bg-surface-2 rounded-full overflow-hidden">
                <div
                  className="h-full bg-signal rounded-full transition-all duration-500"
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
    const no = responses.filter((r) => r.responseText === 'no').length
    const yesPct = total > 0 ? Math.round((yes / total) * 100) : 0
    const noPct = total > 0 ? Math.round((no / total) * 100) : 0

    return (
      <div className="bg-surface border border-hairline rounded-[14px] p-5 mb-5">
        <div className="flex gap-3 mb-3">
          <div className="flex-1 text-center">
            <p className="text-3xl font-bold text-good font-mono">{yesPct}%</p>
            <p className="text-sm text-muted mt-0.5">Yes · {yes}</p>
          </div>
          <div className="flex-1 text-center">
            <p className="text-3xl font-bold text-muted font-mono">{noPct}%</p>
            <p className="text-sm text-muted mt-0.5">No · {no}</p>
          </div>
        </div>
        <div className="flex h-3 rounded-full overflow-hidden bg-surface-2">
          {yesPct > 0 && (
            <div className="bg-good transition-all duration-500" style={{ width: `${yesPct}%` }} />
          )}
          {noPct > 0 && (
            <div className="bg-hairline-strong transition-all duration-500" style={{ width: `${noPct}%` }} />
          )}
        </div>
        <p className="text-xs text-muted mt-2 font-mono">{total} response{total !== 1 ? 's' : ''}</p>
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

  return null
}
