/**
 * The room filling up, one dot per expected answer.
 *
 * A percentage tells you where the class is; this shows it. On a projector that
 * difference matters — a bar that creeps is easy to miss from the back of a hall,
 * whereas a dot appearing where an empty one sat is a discrete event the room
 * catches, and catches as *theirs*.
 *
 * Aggregate only, like everything else on `/present`: a dot is a count reaching one,
 * not a student. Nothing here is ordered by, keyed to, or derived from identity — the
 * nth dot fills because n answers exist, and which n answers is not knowable from it.
 *
 * Motion is pure CSS by necessity, not preference. A slide show backgrounds this frame,
 * where Chromium throttles timers and requestAnimationFrame cannot be counted on, so the
 * newest dot animates by gaining a class and letting the compositor do the rest.
 */

interface Props {
  /** Responses received. May exceed `enrolled` after an add/drop. */
  answered: number
  enrolled: number
}

// Dots shrink as the class grows so the grid stays a few rows rather than a wall.
// Past the largest tier the caller falls back to a plain bar — see PresentResultsPage.
function scale(count: number) {
  if (count <= 40) return { dot: 'clamp(8px, 1.15vw, 22px)', gap: 'clamp(4px, 0.6vw, 11px)' }
  if (count <= 90) return { dot: 'clamp(6px, 0.85vw, 16px)', gap: 'clamp(3px, 0.45vw, 8px)' }
  return { dot: 'clamp(5px, 0.65vw, 12px)', gap: 'clamp(2px, 0.35vw, 6px)' }
}

export default function PresenceGrid({ answered, enrolled }: Props) {
  // Never fewer cells than answers: an add/drop can put more responses on screen than
  // the roster expects, and swallowing them would make the grid disagree with the counter.
  const cells = Math.max(enrolled, answered)
  if (cells <= 0) return null

  const { dot, gap } = scale(cells)
  // Only the dot that just filled animates. It is identified by position rather than by
  // response, so no per-response state is held here.
  const newest = answered - 1

  return (
    <div
      className="flex flex-wrap"
      style={{ gap }}
      // The counts either side of this say the same thing in words; a screen reader
      // walking 200 dots would be told nothing it has not already heard.
      aria-hidden="true"
    >
      {Array.from({ length: cells }, (_, i) => {
        const filled = i < answered
        return (
          <span
            key={i}
            // Adding the class to an element that lacked it is what starts the animation,
            // so the dot pops as it fills without anything remounting.
            className={`rounded-full ${i === newest ? 'pip-in' : ''}`}
            style={{
              width: dot,
              height: dot,
              background: filled ? 'var(--signal-bright)' : 'var(--surface-2)',
              transition: 'background-color .4s ease-out',
            }}
          />
        )
      })}
    </div>
  )
}
