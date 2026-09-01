import { useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'

/**
 * The countdown to a question closing — going, going, gone.
 *
 * The bar drains, and every answer that lands snaps it back to full. That reset is the
 * whole point: under a fixed timer a collective stall buys the room time, and under this
 * one it spends it. The room has to be able to see that rule operating, or it is just a
 * server behaviour nobody can act on.
 *
 * Motion is CSS, for the reason documented in globals.css: a slide show backgrounds this
 * frame, where Chromium throttles timers and requestAnimationFrame stops being dependable.
 * So the bar is a single linear keyframe whose duration is the window and whose delay is a
 * negative offset into it — one declarative animation the compositor runs on its own,
 * correct even if this component mounts halfway through a window.
 *
 * The seconds readout is the one thing JavaScript drives, on a 1s tick. If the frame is
 * throttled the number goes coarse and jumpy while the bar stays smooth, which is the
 * right way round: the bar is what the back of the room reads.
 */

interface Props {
  /** Epoch ms when this question stops accepting answers. */
  closesAt: number
  /** Length of the current window, so a mid-drain mount can seek into the animation. */
  windowMs: number
  /** Fired once when the countdown reaches zero, so the page can refetch. */
  onExpire?: () => void
}

/** Below this share of the window remaining, the bar has cooled to the warn colour. */
const URGENT_FRACTION = 0.34

export default function CloseCountdown({ closesAt, windowMs, onExpire }: Props) {
  const [remaining, setRemaining] = useState(() => Math.max(0, closesAt - Date.now()))
  const firedRef = useRef(false)
  const onExpireRef = useRef(onExpire)
  onExpireRef.current = onExpire

  // A new deadline is a new window: re-arm the expiry so a reset can fire it again.
  useEffect(() => { firedRef.current = false }, [closesAt])

  useEffect(() => {
    function tick() {
      const left = Math.max(0, closesAt - Date.now())
      // Synchronous commit, as everywhere else on this page: an unfocused add-in frame
      // does not reliably paint a state update, and a countdown that stops counting is
      // worse than one that never started.
      flushSync(() => setRemaining(left))
      if (left <= 0 && !firedRef.current) {
        firedRef.current = true
        onExpireRef.current?.()
      }
    }
    tick()
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [closesAt])

  const closed = remaining <= 0
  const urgent = !closed && remaining < windowMs * URGENT_FRACTION

  const seconds = Math.ceil(remaining / 1000)
  const label = closed ? 'Closed' : `${seconds}s`

  return (
    <div className="shrink-0" style={{ marginTop: 'clamp(8px, 1.4vw, 22px)' }}>
      <div className="flex items-end justify-between gap-3" style={{ marginBottom: 'clamp(4px, 0.6vw, 10px)' }}>
        <span
          className="uppercase tracking-widest font-bold"
          style={{
            fontSize: 'clamp(8px, 1.1vw, 19px)',
            color: closed ? 'var(--muted)' : urgent ? 'var(--warn)' : 'var(--muted)',
          }}
        >
          {closed ? 'Answers closed' : 'Closing in'}
        </span>
        <span
          // Remounting on each whole second re-fires the pop, the same trick the answer
          // counter uses — so the last few seconds visibly tick rather than just shrink.
          key={closed ? 'closed' : seconds}
          className={`font-mono font-bold leading-none inline-block ${urgent && seconds <= 5 ? 'count-pop' : ''}`}
          style={{
            fontSize: 'clamp(13px, 2.4vw, 44px)',
            letterSpacing: '-0.02em',
            color: closed ? 'var(--muted)' : urgent ? 'var(--warn)' : 'var(--signal-bright)',
          }}
        >
          {label}
        </span>
      </div>

      <div
        className="relative w-full overflow-hidden rounded-full"
        style={{ height: 'clamp(4px, 0.7vw, 13px)', background: 'var(--surface-2)' }}
        role="timer"
        aria-label={closed ? 'Answers closed' : `Closing in ${seconds} seconds`}
      >
        {/* Keyed on the deadline so a reset remounts the bar: the drain restarts from full
            and the flash re-fires, in one commit, with nothing imperative restarting it. */}
        {!closed && <DrainBar key={closesAt} closesAt={closesAt} windowMs={windowMs} />}
      </div>
    </div>
  )
}

/**
 * The bar itself, split out so the seek offset is computed exactly once.
 *
 * `animation-delay` is read live by the compositor: recomputing it on every tick of the
 * seconds readout would re-seek a running animation once a second, which shows up as a
 * stutter. This component only ever mounts, so the offset is fixed at mount and the
 * animation is left alone until the deadline changes and the parent remounts it.
 */
function DrainBar({ closesAt, windowMs }: { closesAt: number; windowMs: number }) {
  // Negative delay seeks forward: a bar mounting with 4s left of a 20s window starts 16s
  // in rather than at full. Captured on the first render and never recomputed.
  const [elapsed] = useState(() =>
    Math.max(0, Math.min(windowMs, windowMs - (closesAt - Date.now())))
  )

  return (
    <div className="absolute inset-0">
      {/* Underneath: where the bar is heading. */}
      <div
        className="clock-drain absolute inset-0 rounded-full"
        style={{
          background: 'var(--warn)',
          animationDuration: `${windowMs}ms`,
          animationDelay: `-${elapsed}ms`,
        }}
      />
      {/* On top: fades out over the last third, letting the warn colour through. */}
      <div
        className="clock-drain-cool absolute inset-0 rounded-full"
        style={{
          background: 'var(--signal-bright)',
          animationDuration: `${windowMs}ms, ${windowMs}ms`,
          animationDelay: `-${elapsed}ms, -${elapsed}ms`,
        }}
      />
      {/* The reset — a bright sweep that fades, so an answer landing reads as an event and
          not merely as a bar longer than it was a moment ago. */}
      <div className="clock-reset absolute inset-0 rounded-full" style={{ background: 'var(--ink)' }} />
    </div>
  )
}
