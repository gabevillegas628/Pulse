/**
 * How long the event loop is being kept waiting.
 *
 * The 9 Sep stampede was diagnosed backwards: from a 304 with an empty body that took
 * 3.2s, and a favicon that took 2.4s. Both were bystanders, and the only thing they could
 * have been queueing behind was the main thread — but establishing that took a load test
 * against a copy of the app, because nothing in the log said so directly.
 *
 * This is the number that would have said so. A request is slow either because its own
 * work was slow or because the loop was blocked when it arrived; those want completely
 * different fixes, and until now the log could not tell them apart.
 *
 * Reported on the same line as the slow request, so the two are never correlated by hand.
 */

import { monitorEventLoopDelay } from 'node:perf_hooks'

const histogram = monitorEventLoopDelay({ resolution: 10 })
histogram.enable()

/**
 * Reset on a short cycle. A max since boot is a high-water mark that never comes down:
 * one bad lecture and every line for the next week reports it, which is worse than
 * useless because it looks like a live reading. Ten seconds is short enough that the
 * number describes conditions around the request it is attached to.
 */
const WINDOW_MS = 10_000
setInterval(() => histogram.reset(), WINDOW_MS).unref()

/** Worst event-loop delay seen in the last ten seconds, in milliseconds. */
export function eventLoopLagMs(): number {
  return Math.round(histogram.max / 1e6)
}
