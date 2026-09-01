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
 * A clock does not start on the first answer. A question becomes answerable the moment
 * its code is readable, so the first answer can land while the professor is still
 * putting the QR code up and telling the room to wait — and in a 140-seat rollout that
 * is exactly what happened: two eager students armed a timer nobody had started, it ran
 * out, and it locked the hall out of a question that had never really been asked. The
 * clock therefore waits for a threshold, scaled to the roster, that a handful of
 * early birds cannot reach on their own.
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
// Answers required before the clock starts, as a share of the roster. A tenth means a
// stray early answer or two can never arm a question: in a 140-seat hall it takes 14
// students, which only happens once the room has genuinely been asked.
const ARM_RATIO = 0.1
// Floors and caps that share. Two keeps a one-student answer from arming anything even
// in a tiny section; fifteen keeps a huge roster from setting a threshold so high that
// a poorly-attended lecture never starts a clock at all.
const ARM_MIN = 2
const ARM_MAX = 15

/** Answers needed to arm a question's clock, given the size of the class. */
function armThresholdFor(rosterSize: number): number {
  if (rosterSize <= 0) return ARM_MIN
  return Math.min(ARM_MAX, Math.max(ARM_MIN, Math.ceil(rosterSize * ARM_RATIO)))
}

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
  /** Answers seen so far, armed or not — what the arming threshold is measured against. */
  answers: number
  /** Answers this question needs before its clock starts. See armThresholdFor(). */
  armThreshold: number
  /**
   * Whether the countdown has started. An unarmed clock is collecting pace data and
   * nothing else: it has no deadline, refuses nobody, and shows the projector no bar.
   */
  armed: boolean
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
 * Start a dormant clock's countdown, as of `at`.
 *
 * `firstAt` moves to the arming moment so the floor measures the window the room
 * actually gets. The answers that arrived before arming were given while the question
 * was not yet being asked, and dating the floor from one of those would hand the room
 * a window that had already half elapsed.
 */
function arm(clock: Clock, at: number): void {
  clock.armed = true
  // The latest answer seen, not necessarily this one: an out-of-order arrival can be
  // the answer that reaches the threshold, and dating the floor from a timestamp behind
  // one already recorded would hand the room a window that had partly elapsed.
  clock.firstAt = Math.max(at, clock.lastAt)
  recompute(clock, clock.firstAt)
}

/**
 * Record an answer against a question's clock, creating it if this is the first.
 *
 * Once the clock is armed every call pushes the deadline out — this is the reset.
 * Before that the call only counts toward the arming threshold and contributes its
 * gap to the pace estimate; no deadline exists to move.
 *
 * `rosterSize` sets the arming threshold. It is passed rather than looked up because
 * this sits on the answer-submit path, where an extra query per student is a cost the
 * room pays; callers already hold an enrollment count from a query they were making
 * anyway. Zero means "unknown" and falls back to the smallest sensible threshold.
 */
export function touch(
  sessionId: string,
  runId: string,
  questionId: string,
  at: number = Date.now(),
  rosterSize: number = 0
): void {
  const k = key(runId, questionId)
  const existing = clocks.get(k)

  if (!existing) {
    const clock: Clock = {
      sessionId, runId, questionId,
      firstAt: at, lastAt: at, gaps: [], closesAt: 0,
      windowStartedAt: at, windowMs: 0, announced: false,
      answers: 1, armThreshold: armThresholdFor(rosterSize), armed: false,
    }
    if (clock.answers >= clock.armThreshold) arm(clock, at)
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
  existing.answers++

  if (!existing.armed) {
    // A late roster figure still counts: the first answer may have arrived before the
    // caller had one, and a threshold set from a stale zero would arm far too early.
    if (rosterSize > 0) existing.armThreshold = armThresholdFor(rosterSize)
    if (existing.answers >= existing.armThreshold) arm(existing, at)
    return
  }

  recompute(existing, at)
}

/** The deadline for a question, or null if its clock has not armed. */
export function closesAt(runId: string, questionId: string): number | null {
  const clock = clocks.get(key(runId, questionId))
  return clock?.armed ? clock.closesAt : null
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
  return clock?.armed ? { closesAt: clock.closesAt, windowMs: clock.windowMs } : null
}

/**
 * Whether a question still accepts answers. A question with no clock, or one whose
 * clock has not armed, is open — nothing can be refused before the countdown starts.
 */
export function isOpen(runId: string, questionId: string, now: number = Date.now()): boolean {
  const clock = clocks.get(key(runId, questionId))
  return !clock || !clock.armed || clock.closesAt > now
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
  // Arm regardless of threshold. The professor has just declared the question live, so
  // the countdown starts now — waiting for a quorum here would leave the room with a
  // reopened question and no visible clock, which is the opposite of what was asked for.
  const clock = clocks.get(key(runId, questionId))
  if (clock && !clock.armed) arm(clock, Date.now())
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
            class: {
              select: {
                autoCloseDefault: true,
                // Sets the arming threshold on replay, so a warmed clock arms at the
                // same answer the live one did.
                _count: { select: { enrollments: true } },
              },
            },
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

      const roster = cls._count.enrollments
      for (const r of responses) {
        touch(run.sessionId, run.id, r.questionId, r.submittedAt.getTime(), roster)
      }
      // Nothing is announced for a clock that expired while the server was down —
      // the projector reads the deadline from the payload and renders it closed.
      for (const clock of clocks.values()) {
        if (clock.runId === run.id && clock.armed && clock.closesAt <= Date.now()) clock.announced = true
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
      if (clock.announced || !clock.armed || clock.closesAt > now) continue
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
