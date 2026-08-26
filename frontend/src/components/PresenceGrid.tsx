/**
 * The room filling up, one dot per expected answer.
 *
 * A percentage tells you where the class is; this shows it. On a projector that
 * difference matters — a bar that creeps is easy to miss from the back of a hall,
 * whereas a dot appearing where an empty one sat is a discrete event the room catches,
 * and catches as its own.
 *
 * Aggregate only, like everything else on /present: a dot is a count reaching one, not a
 * student. Nothing here is ordered by, keyed to, or derived from identity — the nth dot
 * fills because n answers exist, and which n answers is not knowable from it.
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

/**
 * Rows wrap at a fixed count rather than at whatever the container happens to fit.
 *
 * Spacing dots to span the object exactly would mean measuring it — a ResizeObserver and
 * a layout read, on a frame a slide show throttles — and all it buys is a row that ends
 * flush. A fixed wrap is deterministic, costs nothing, and gives the same block shape at
 * every projector size.
 */
const PER_ROW = 60

// One size at every roster. Shrinking dots for large classes was tried and looked worse:
// at 800 it drew a dense little rectangle a third of the width, which reads as a smudge
// rather than a room. Holding the size lets the block grow downward instead, which is the
// thing that actually says how big the class is.
const DOT = 'clamp(4px, 0.55vw, 11px)'
const GAP = 'clamp(2px, 0.30vw, 5px)'

export default function PresenceGrid({ answered, enrolled }: Props) {
  // Never fewer cells than answers: an add/drop can put more responses on screen than the
  // roster expects, and swallowing them would make the grid disagree with the counter.
  const cells = Math.max(enrolled, answered)
  if (cells <= 0) return null

  // Only the dot that just filled animates. It is identified by position rather than by
  // response, so no per-response state is held here.
  const newest = answered - 1

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${Math.min(PER_ROW, cells)}, ${DOT})`,
        gap: GAP,
        justifyContent: 'start',
      }}
      // The counts either side of this say the same thing in words; a screen reader
      // walking 800 dots would be told nothing it has not already heard.
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
              width: DOT,
              height: DOT,
              background: filled ? 'var(--signal-bright)' : 'var(--pip-empty)',
              transition: 'background-color .4s ease-out',
            }}
          />
        )
      })}
    </div>
  )
}
