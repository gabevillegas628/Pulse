import { Router, Request, Response } from 'express'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import { logger } from '../utils/logger.js'

const router = Router()

/**
 * Where the client reports its own auth storage going wrong.
 *
 * Deliberately unauthenticated, because the event it exists to report is "the token is
 * gone" — requiring a token would make it silent in exactly the case it was built for.
 * That makes it an open write path into the logs, so it is bounded on every axis that
 * matters: a tight limiter, a schema that strips unknown keys, enum'd event names, and
 * length caps on every string. Nothing here is trusted; it is one warn line either way.
 */
const diagLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
})

/**
 * Never the token itself — a diagnostic that leaks credentials into a log is worse than
 * the bug it is chasing. `tokenTail` is the last six characters, enough to tell two
 * tokens apart across a renewal and useless to anyone who reads it.
 */
const bodySchema = z.object({
  event: z.enum(['boot', 'token-written', 'token-cleared', 'token-vanished']),
  at: z.string().max(40),
  path: z.string().max(200),
  // Which storage key held the sign-in: a browser tab and an Office surface are otherwise
  // indistinguishable in a report, and that ambiguity cost a day of false alarms.
  key: z.string().max(64).nullable(),
  // Attribution: which of the three possible actors removed the key.
  byApp: z.boolean(),
  appStack: z.string().max(1200).nullable(),
  byOtherTab: z.string().max(300).nullable(),
  // What else survived, which separates a targeted removal from a store-wide wipe.
  canaryLocal: z.boolean(),
  canaryIdb: z.boolean(),
  keyCount: z.number().int().min(0).max(500),
  // Recorded when the token was written, so they survive the token itself.
  tokenTail: z.string().max(12).nullable(),
  tokenIat: z.number().int().nullable(),
  tokenExp: z.number().int().nullable(),
  ageSec: z.number().int().nullable(),
  visibility: z.string().max(20),
})

router.post('/client-diag', diagLimiter, (req: Request, res: Response) => {
  const parsed = bodySchema.safeParse(req.body)
  if (!parsed.success) {
    // A malformed report is not worth a 400 the beacon could never read anyway.
    res.status(204).end()
    return
  }
  logger.warn('client auth diagnostic', { ...parsed.data, ua: String(req.headers['user-agent'] ?? '').slice(0, 160) })
  res.status(204).end()
})

export default router
