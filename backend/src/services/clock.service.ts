import { prisma } from '../db/index.js'
import { getIo } from '../socket.js'
import { logger } from '../utils/logger.js'

/**
 * Ephemeral per-question close clocks — "going, going, gone".
 *
 * A question with `autoClose` on gets a deadline that resets every time an answer
 * lands. Once it passes, the server refuses further answers for that question for
 * the rest of the run. This inverts the incentive that made waiting pay: a
 * collective stall used to buy time, and now it ends the question.
 *
 * Deliberately in memory, and deliberately not persisted. A clock only means
 * anything during a live run, and a new run should start with fresh clocks. The
 * map is a cache, never a source of truth — every value in it is derivable from
 * `Response.submittedAt`, which is exactly what warmFromDb() does after a restart.
 * Only the `autoClose` toggle itself lives in the database.
 *
 * Single-process only. The backend runs one instance (see index.ts); if that ever
 * changes this has to move to the database or a shared store.
 */

// Close after roughly this many typical inter-arrival gaps of silence. Three is
// long enough that a normal lull does not trip it and short enough to be visible.
const GRACE_GAPS = 3
// The observed-gap grace is clamped: a burst of simultaneous answers must not
// produce a sub-second deadline, and a slow trickle must not hold the room forever.
const MIN_GRACE_MS = 8_000
const MAX_GRACE_MS = 45_000
// A question never closes sooner than this after its first answer, or it shuts
// before the back of the room has finished reading the slide.
const FLOOR_MS = 20_000
// Bound the retained gap history. A lecture question sees a few hundred answers at
// most, but there is no reason to keep them all to compute a median.
const MAX_GAPS = 64

interface Clock {
  sessionId: string
  runId: string
  questionId: string
  firstAt: number
  lastAt: number
  /** Inter-arrival gaps in ms, most recent last, capped at MAX_GAPS. */
  gaps: number[]
  closesAt: number
  /**
   * How long the current window is: from the answer that last *moved* `closesAt` to
   * `closesAt` itself. Measured from that answer rather than from the most recent one,
   * because an answer that leaves the deadline where it is must leave the window alone
   * too — otherwise the projector re-times a running animation and the bar stutters.
   *
   * The projector needs this as well as the deadline: a bar that drains proportionally
   * has to know the whole span, and one mounting mid-drain seeks into its animation by
   * `closesAt - windowMs`, which is when the window started.
   */
  windowMs: number
  /** When the current `closesAt` was established — the start of the bar's window. */
  windowStartedAt: number
  /** Set once the sweep has announced this close, so it announces only once. */
  announced: boolean
}

const clocks = new Map<string, Clock>()

const key = (runId: string, questionId: string) => `${runId}:${questionId}`

/**
 * Whether auto-close is on for a question. Per-question `autoClose` wins; null
 * inherits the class default. Mirrors themesEnabled() in themes.service.ts.
 */
export function autoCloseEnabled(
  question: { autoClose: boolean | null },
  cls: { autoCloseDefault: boolean }
): boolean {
  return question.autoClose ?? cls.autoCloseDefault
}

function median(xs: number[]): number {
  if (xs.length === 0) return MAX_GRACE_MS
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

/**
 * Grace scaled to how fast this particular question is actually drawing answers.
 * A hard question keeps pulling stragglers and stays open; an easy one closes
 * quickly. No per-question configuration, which is the point.
 */
function graceFor(clock: Clock): number {
  // One answer tells us nothing about pace, but the floor already guarantees the room a
  // minimum window from that first answer — so the grace does not need to guard it too.
  // Reaching for the maximum here was tried and was wrong: it pinned the deadline so far
  // out that the next thirty seconds of answers could not move it, and the reset, which
  // is the entire thing this feature teaches, stayed invisible for most of the question.
  if (clock.gaps.length === 0) return MIN_GRACE_MS
  const scaled = median(clock.gaps) * GRACE_GAPS
  return Math.min(MAX_GRACE_MS, Math.max(MIN_GRACE_MS, scaled))
}

/**
 * Move the deadline, given an answer landing at `at`.
 *
 * The deadline is monotonic: it never moves in, only out. That is not a nicety, it is the
 * rule the whole feature teaches. The first answer has no pace to go on and so gets the
 * widest window; the second reveals the pace and the computed grace collapses, which
 * without this clamp lands the deadline tens of seconds *earlier* than the one already on
 * the wall. The room would watch the bar shrink at the moment an answer arrived and learn
 * the exact opposite of "answering buys time".
 */
function recompute(clock: Clock, at: number): void {
  const byGrace = clock.lastAt + graceFor(clock)
  const byFloor = clock.firstAt + FLOOR_MS
  const next = Math.max(clock.closesAt, byGrace, byFloor)
  // An answer that does not move the deadline does not restart the window either: the
  // bar carries on draining rather than re-timing itself under the projector's feet.
  if (next === clock.closesAt) return
  clock.closesAt = next
  clock.windowStartedAt = at
  clock.windowMs = next - at
}

/**
 * Record an answer against a question's clock, starting it if this is the first.
 * Every call pushes the deadline out — this is the reset.
 */
export function touch(
  sessionId: string,
  runId: string,
  questionId: string,
  at: number = Date.now()
): void {
  const k = key(runId, questionId)
  const existing = clocks.get(k)

  if (!existing) {
    const clock: Clock = {
      sessionId, runId, questionId,
      firstAt: at, lastAt: at, gaps: [], closesAt: 0,
      windowStartedAt: at, windowMs: 0, announced: false,
    }
    recompute(clock, at)
    clocks.set(k, clock)
    return
  }

  // Out-of-order arrivals (a warm-up replay, or clock skew) must not push negative
  // values into the gap history or pull the deadline backwards.
  if (at > existing.lastAt) {
    existing.gaps.push(at - existing.lastAt)
    if (existing.gaps.length > MAX_GAPS) existing.gaps.shift()
    existing.lastAt = at
  }
  recompute(existing, at)
}

/** The deadline for a question, or null if its clock has not started. */
export function closesAt(runId: string, questionId: string): number | null {
  return clocks.get(key(runId, questionId))?.closesAt ?? null
}

/**
 * Deadline plus the length of the window it belongs to — everything the projector needs
 * to draw a draining bar, including one that mounts partway through.
 */
export function clockState(
  runId: string,
  questionId: string
): { closesAt: number; windowMs: number } | null {
  const clock = clocks.get(key(runId, questionId))
  return clock ? { closesAt: clock.closesAt, windowMs: clock.windowMs } : null
}

/**
 * Whether a question still accepts answers. A question with no clock yet is open —
 * the clock starts on the first answer, so the first answer is never refused.
 */
export function isOpen(runId: string, questionId: string, now: number = Date.now()): boolean {
  const clock = clocks.get(key(runId, questionId))
  return !clock || clock.closesAt > now
}

/** Drop every clock for a run. Called when the run closes. */
export function clearRun(runId: string): void {
  for (const [k, clock] of clocks) {
    if (clock.runId === runId) clocks.delete(k)
  }
}

/**
 * Reopen a closed question by restarting its clock from now — the professor's
 * override for a question that closed while the room was still thinking.
 */
export function reopen(sessionId: string, runId: string, questionId: string): void {
  clocks.delete(key(runId, questionId))
  touch(sessionId, runId, questionId)
}

/**
 * Rebuild the clocks for every open run from the responses already in the database.
 * Runs once at boot: the map is a cache, so a restart mid-lecture must not silently
 * un-time every question. A server that was down long enough for the deadlines to
 * pass will correctly find those questions already closed.
 */
export async function warmFromDb(): Promise<void> {
  try {
    const runs = await prisma.sessionRun.findMany({
      where: { status: 'OPEN' },
      select: {
        id: true,
        sessionId: true,
        session: {
          select: {
            class: { select: { autoCloseDefault: true } },
            questions: { select: { id: true, autoClose: true } },
          },
        },
      },
    })

    let warmed = 0
    for (const run of runs) {
      const cls = run.session.class
      const timed = run.session.questions.filter((q) => autoCloseEnabled(q, cls))
      if (timed.length === 0) continue

      const responses = await prisma.response.findMany({
        where: { runId: run.id, questionId: { in: timed.map((q) => q.id) } },
        select: { questionId: true, submittedAt: true },
        orderBy: { submittedAt: 'asc' },
      })

      for (const r of responses) {
        touch(run.sessionId, run.id, r.questionId, r.submittedAt.getTime())
      }
      // Nothing is announced for a clock that expired while the server was down —
      // the projector reads the deadline from the payload and renders it closed.
      for (const clock of clocks.values()) {
        if (clock.runId === run.id && clock.closesAt <= Date.now()) clock.announced = true
      }
      warmed += timed.length
    }

    if (warmed > 0) {
      logger.info(`Clock service warmed ${warmed} question clock(s) across ${runs.length} open run(s)`)
    }
  } catch (err) {
    // A failed warm-up leaves questions answerable, which is the pre-existing
    // behaviour. Never let it stop the server booting.
    logger.error('Clock service warm-up failed:', err)
  }
}

/**
 * Announce closes as they happen so the projector and the professor's monitor can
 * react without waiting for their next poll. The authoritative check is isOpen() at
 * submit time; this is only notification.
 */
export function startClockSweep(): void {
  setInterval(() => {
    const now = Date.now()
    for (const clock of clocks.values()) {
      if (clock.announced || clock.closesAt > now) continue
      clock.announced = true
      try {
        getIo().to(clock.sessionId).emit('question_closed', {
          questionId: clock.questionId,
          runId: clock.runId,
          closedAt: new Date(clock.closesAt).toISOString(),
        })
      } catch (err) {
        logger.error('Clock sweep emit failed:', err)
      }
    }
  }, 1_000)
}
