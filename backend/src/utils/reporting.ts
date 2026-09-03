import { logger } from './logger.js'

/**
 * The seam where an error reporting service goes.
 *
 * Deliberately not a provider yet. Everything that should reach one already
 * calls through here — the 500 branch of the error middleware, and the two
 * process-level handlers below — so adopting Sentry or its equivalent is a
 * change to this file and an env var, not a hunt through the routes.
 *
 * Until then it is winston, which means a 500 mid-lecture is still only a log
 * line. That is the known gap; the point of the seam is that closing it is
 * cheap rather than that it is closed.
 */

export interface ErrorContext {
  path?: string
  method?: string
  /** Where the error surfaced, when it wasn't a request. */
  source?: string
}

export function captureException(err: unknown, context: ErrorContext = {}): void {
  // ── Plug a reporter in here. ──────────────────────────────────────────────
  // e.g. Sentry.captureException(err, { extra: context })

  const error = err instanceof Error ? err : new Error(String(err))
  logger.error('captured exception', {
    ...context,
    message: error.message,
    stack: error.stack,
  })
}

/**
 * An error off the request path never reaches the error middleware, which is
 * exactly the failure worth hearing about: it ends a live lecture. Registered
 * once at boot.
 *
 * The two are treated differently on purpose.
 *
 * unhandledRejection logs and continues. Node's default is to crash, and this
 * changes that: a rejected background promise — a theme bootstrap, a clock
 * sweep, anything deliberately not awaited — should not take a lecture down
 * with it. The cost is that a genuinely broken invariant now runs on instead of
 * failing loudly, so the log line is the only warning and wants reading.
 *
 * uncaughtException does not resume, matching Node's default. The process is in
 * an unknown state after one and Railway's restart policy is a better answer
 * than limping on; logging first is what makes the reason survive the restart.
 */
export function installProcessHandlers(): void {
  process.on('unhandledRejection', (reason) => {
    captureException(reason, { source: 'unhandledRejection' })
  })

  process.on('uncaughtException', (err) => {
    captureException(err, { source: 'uncaughtException' })
    process.exit(1)
  })
}
