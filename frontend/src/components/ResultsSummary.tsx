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
      <div className="bg-white border border-gray-200 rounded-xl p-5 mb-5 space-y-3">
        {options.map((opt) => {
          const count = counts[opt]
          const pct = total > 0 ? Math.round((count / total) * 100) : 0
          return (
            <div key={opt}>
              <div className="flex items-center justify-between text-sm mb-1">
                <span className="text-gray-700 truncate max-w-[70%]">{opt}</span>
                <span className="text-gray-500 shrink-0 ml-2">{count} <span className="text-gray-400">({pct}%)</span></span>
              </div>
              <div className="h-3 bg-gray-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary-500 rounded-full transition-all duration-500"
                  style={{ width: `${(count / max) * 100}%` }}
                />
              </div>
            </div>
          )
        })}
        <p className="text-xs text-gray-400 pt-1">{total} response{total !== 1 ? 's' : ''}</p>
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
      <div className="bg-white border border-gray-200 rounded-xl p-5 mb-5">
        <div className="flex items-end gap-2 h-24 mb-2">
          {[1, 2, 3, 4, 5].map((n) => {
            const count = counts[n]
            const heightPct = (count / max) * 100
            return (
              <div key={n} className="flex-1 flex flex-col items-center gap-1">
                <span className="text-xs text-gray-500">{count > 0 ? count : ''}</span>
                <div className="w-full bg-gray-100 rounded-t-md overflow-hidden" style={{ height: '64px' }}>
                  <div
                    className="w-full bg-primary-500 rounded-t-md transition-all duration-500 absolute bottom-0"
                    style={{ height: `${heightPct}%`, position: 'relative', marginTop: `${100 - heightPct}%` }}
                  />
                </div>
                <span className="text-xs font-medium text-gray-600">{n}</span>
              </div>
            )
          })}
        </div>
        <div className="flex items-center justify-between text-xs text-gray-400 mt-2">
          <span>{total} response{total !== 1 ? 's' : ''}</span>
          <span className="text-gray-700 font-semibold text-sm">avg {avg}</span>
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
      <div className="bg-white border border-gray-200 rounded-xl p-5 mb-5">
        <div className="flex gap-3 mb-3">
          <div className="flex-1 text-center">
            <p className="text-3xl font-bold text-green-600">{yesPct}%</p>
            <p className="text-sm text-gray-500 mt-0.5">Yes · {yes}</p>
          </div>
          <div className="flex-1 text-center">
            <p className="text-3xl font-bold text-gray-400">{noPct}%</p>
            <p className="text-sm text-gray-500 mt-0.5">No · {no}</p>
          </div>
        </div>
        <div className="flex h-3 rounded-full overflow-hidden bg-gray-100">
          {yesPct > 0 && (
            <div className="bg-green-500 transition-all duration-500" style={{ width: `${yesPct}%` }} />
          )}
          {noPct > 0 && (
            <div className="bg-gray-300 transition-all duration-500" style={{ width: `${noPct}%` }} />
          )}
        </div>
        <p className="text-xs text-gray-400 mt-2">{total} response{total !== 1 ? 's' : ''}</p>
      </div>
    )
  }

  if (type === 'FREE_TEXT') {
    const flagged = responses.filter((r) => r.isFlagged).length
    return (
      <div className="flex items-center gap-6 bg-white border border-gray-200 rounded-xl px-5 py-3 mb-5">
        <div>
          <p className="text-2xl font-bold text-gray-900">{total}</p>
          <p className="text-xs text-gray-400">responses</p>
        </div>
        {flagged > 0 && (
          <div>
            <p className="text-2xl font-bold text-yellow-500">{flagged}</p>
            <p className="text-xs text-gray-400">short (&lt;10 words)</p>
          </div>
        )}
        {total > 0 && (
          <div>
            <p className="text-2xl font-bold text-gray-700">
              {Math.round(responses.reduce((s, r) => s + r.wordCount, 0) / total)}
            </p>
            <p className="text-xs text-gray-400">avg words</p>
          </div>
        )}
      </div>
    )
  }

  return null
}
