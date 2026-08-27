/**
 * The room writing, in the window before there are themes to show.
 *
 * That window is two different events wearing one label. Under the threshold the wait is
 * on people, and the screen should be recruiting. Over it the wait is on the model, and
 * the screen should look like something is being read. Neither is served by a bar ticking
 * toward a number that means nothing to anyone but the professor, so the number does not
 * appear here at all — it lives in the task pane, where it is actually actionable.
 *
 * What makes this possible: a FREE_TEXT answer reaches the projector with its words
 * stripped but its word count intact. So the shape of an answer is knowable when its
 * content is not, and a room can watch itself write without a single word being shown.
 *
 * The props are word counts, deliberately. Handing this component numbers rather than
 * responses means it cannot leak text by accident, however it is later edited — the same
 * reason ThemeBars lives apart from the panel that renders netIDs.
 */

interface Props {
  /** One entry per answer received, any order. Counts only — never text, never identity. */
  wordCounts: number[]
  /** True once the threshold is met and the model is building categories. */
  sorting: boolean
}

// Word count maps to a width rather than being printed. Past this the tiles stop growing:
// the point is visible variety, not a chart, and one very long answer should not set the
// scale for everybody else.
const LONG_ANSWER = 40

export default function AnswersArriving({ wordCounts, sorting }: Props) {
  const n = wordCounts.length
  if (n === 0) return null

  // Sorted by length, not arrival. Arrival order weakly encodes who answered when, and
  // sorting removes that signal — the staircase happens to read better as well.
  const sorted = [...wordCounts].sort((a, b) => a - b)

  // Stable keys without carrying an id: the nth answer of a given length keeps its key as
  // others arrive, so exactly one tile mounts per new answer and only that one animates.
  const seen = new Map<number, number>()
  const tiles = sorted.map((words) => {
    const nth = seen.get(words) ?? 0
    seen.set(words, nth + 1)
    return { words, key: `${words}-${nth}` }
  })

  return (
    <div className="text-center">
      <p className="text-muted" style={{ fontSize: 'clamp(11px, 1.8vw, 32px)' }}>
        {sorting
          ? `Reading ${n} answer${n === 1 ? '' : 's'}…`
          : `${n} answer${n === 1 ? '' : 's'} so far`}
      </p>

      <div
        className="flex flex-wrap justify-center items-center"
        style={{ fontSize: 'clamp(10px, 1.4vw, 26px)', gap: '0.5em', marginTop: '1.3em' }}
        // Every tile is a width. There is nothing here for a screen reader that the count
        // above does not already say better.
        aria-hidden="true"
      >
        {tiles.map(({ words, key }, i) => (
          // Two elements: the wrapper pops once when the answer lands, the inner tile
          // carries the reading wave. One element cannot hold both without the arrival
          // animation being lost the moment the wave takes over.
          <span key={key} className="rise-in inline-flex">
            <span
              className={`rounded-full ${sorting ? 'answer-wave' : ''}`}
              style={{
                // Rounded because the raw arithmetic lands on 1.7999999999999998em, which is
                // harmless to CSS and unreadable in the DOM.
                width: `${(1.2 + (Math.min(words, LONG_ANSWER) / LONG_ANSWER) * 8).toFixed(2)}em`,
                height: '0.55em',
                background: 'var(--signal)',
                // Staggered, so the wave travels along the answers rather than blinking
                // them all at once. Reads as something moving through them in order.
                animationDelay: `${i * 60}ms`,
              }}
            />
          </span>
        ))}
      </div>

      {!sorting && (
        <p
          className="text-muted"
          style={{ fontSize: 'clamp(9px, 1.3vw, 24px)', marginTop: '1.5em', opacity: 0.75 }}
        >
          The more answers, the better the themes
        </p>
      )}
    </div>
  )
}
