import { Request, Response, NextFunction } from 'express'
import { logger } from '../utils/logger.js'

/**
 * Structured access logging for the requests worth reading later.
 *
 * The first 140-seat rollout had to be reconstructed from Postgres checkpoint records,
 * because the app wrote nothing per-request: a 409 refusing a student, or a 429 locking
 * one out, left no trace at all. Railway's edge log has status and duration but not the
 * reason, and the reason is the only part that says what the room experienced.
 *
 * Successful, fast requests are not logged. A lecture is a few thousand of those and
 * they say nothing; the failures and the slow tail are the whole signal.
 *
 * Socket.io traffic never reaches here — engine.io claims /socket.io on the HTTP server
 * before Express sees it — so long-poll connections cannot drown the log.
 */

/** Above this, a request is worth a line even if it succeeded. */
const SLOW_MS = 1000

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const startedAt = process.hrtime.bigint()

  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6
    const slow = ms >= SLOW_MS
    if (res.statusCode < 400 && !slow) return

    const line = {
      method: req.method,
      // Query strings can carry access codes; the path is what identifies the endpoint.
      path: req.originalUrl.split('?')[0],
      status: res.statusCode,
      ms: Math.round(ms),
      // Set by the error middleware, or by a limiter that answered the request itself.
      // A status without it is not diagnostic: three different 409s read identically.
      ...(res.locals.refusalReason ? { reason: res.locals.refusalReason as string } : {}),
      ...actorOf(req),
    }

    if (res.statusCode >= 500) logger.error('Request failed', line)
    else if (res.statusCode >= 400) logger.warn('Request refused', line)
    else logger.warn('Slow request', line)
  })

  next()
}

/**
 * Who was making the request, when auth has already resolved it.
 *
 * netID rather than an opaque id: the question after a bad lecture is "how many
 * students did this actually affect, and which ones", and a database id cannot answer
 * it without another query. This is a server log, not the projector payload — the rule
 * that keeps netIDs off the wall is about what gets rendered in a lecture hall.
 */
function actorOf(req: Request): { netId?: string; professorId?: string } {
  const r = req as Request & {
    student?: { netId?: string }
    professor?: { id?: string }
  }
  if (r.student?.netId) return { netId: r.student.netId }
  if (r.professor?.id) return { professorId: r.professor.id }
  return {}
}
