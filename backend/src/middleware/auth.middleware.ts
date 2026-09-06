import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { prisma } from '../db/index.js'
import { config } from '../config/index.js'
import { AppError } from './error.middleware.js'
import { logger } from '../utils/logger.js'
import type { Professor, Student } from '@prisma/client'

interface JwtPayload {
  sub: string
  role: 'professor' | 'student'
  /** Set by jwt.sign, in seconds. Absent only on a token minted without expiry. */
  iat?: number
  exp?: number
}

/**
 * Carries a renewed professor token back to the client, which stores it and uses it from
 * the next request on. Lowercased by the time axios reads it.
 */
export const RENEWED_TOKEN_HEADER = 'X-Pulse-Token'

/**
 * Replace a professor token that is past halfway through its life.
 *
 * Without this a token is a cliff: minted at sign-in, dead exactly `jwtExpiresIn` later
 * whatever is happening at the time. A PowerPoint deck left open across a day hits that
 * cliff mid-lecture, and the surface that discovers it is the projector â which is polling
 * every few seconds and so could not be more obviously in use.
 *
 * Renewing on activity rather than on a schedule keeps the point of a short window: a deck
 * nobody has opened for longer than the window still expires, because nothing was there to
 * renew it. Only the professor role is renewed; a student answers a question in minutes and
 * never sees the edge of a window.
 *
 * Silent by design. It is a header on a response the client already wanted, so there is no
 * refresh call to schedule, nothing to fail on its own, and no moment where the projector
 * is between tokens.
 */
function renewIfHalfSpent(res: Response, payload: JwtPayload): void {
  if (payload.iat == null || payload.exp == null) return
  const halfway = payload.iat + (payload.exp - payload.iat) / 2
  if (Date.now() / 1000 < halfway) return
  try {
    const fresh = jwt.sign({ sub: payload.sub, role: 'professor' }, config.jwtSecret, {
      expiresIn: config.jwtExpiresIn as unknown as number, // StringValue cast, as at sign-in
    })
    res.setHeader(RENEWED_TOKEN_HEADER, fresh)
  } catch (err) {
    // A renewal that cannot be minted is not a reason to refuse the request carrying it.
    // The caller's current token is still valid and still has half its life left, so the
    // only cost of skipping is that the next request tries again.
    logger.error('professor token renewal failed', err)
  }
}

/**
 * The error to refuse a request with, keeping "not signed in" apart from "we broke".
 *
 * These middlewares used to answer 401 for anything that threw, which reads as a safe
 * default until you notice what else is inside the try: a database round trip. A pool
 * checkout that times out behind a heavy query, a connection dropped by a restarting
 * database, a renewal that fails to sign — every one of those left here as
 * "Unauthorized", and the client has no way to know better. It deletes the token and
 * raises the session-expired prompt, so a blip lasting a single request costs the
 * professor their sign-in and a retyped password on a token with hours of life left.
 * That is the shape of the report from the textbook and roster tabs: their queries are
 * the heaviest in the app, so they are the likeliest to have the pool short when the
 * next request needs a connection to look up who is asking.
 *
 * jsonwebtoken's own errors — malformed, wrong secret, past exp — are the only failures
 * here that genuinely mean sign in again. TokenExpiredError and NotBeforeError both
 * extend JsonWebTokenError, so one check covers all three. Anything else travels to the
 * error middleware as itself: logged, reported, and answered 500. Honest to the client,
 * and visible to us rather than disguised as somebody's expired session.
 */
function asAuthError(err: unknown): unknown {
  if (err instanceof AppError) return err
  if (err instanceof jwt.JsonWebTokenError) return new AppError('Unauthorized', 401)
  return err
}

export interface ProfessorRequest extends Request {
  professor: Professor
}

export interface StudentRequest extends Request {
  student: Student
}

function extractToken(req: Request): string {
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) throw new AppError('Unauthorized', 401)
  return auth.slice(7)
}

export async function requireProfessor(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  let professor: Professor
  try {
    const token = extractToken(req)
    const payload = jwt.verify(token, config.jwtSecret) as JwtPayload
    if (payload.role !== 'professor') throw new AppError('Unauthorized', 401)

    const row = await prisma.professor.findUnique({ where: { id: payload.sub } })
    // Deactivation is enforced here, not by revoking tokens: the row is re-read on
    // every request, so a deactivated professor's outstanding tokens die on their
    // next use, renewal included, without anyone keeping a list of them.
    if (!row || row.deactivatedAt) throw new AppError('Unauthorized', 401)
    professor = row

    // After the lookup, so a token whose professor no longer exists is not handed a new one.
    renewIfHalfSpent(res, payload)
  } catch (err) {
    return next(asAuthError(err))
  }

  // Outside the try, so that an error raised by a route downstream cannot travel back
  // through this catch and be relabelled a problem with the caller's sign-in.
  ;(req as ProfessorRequest).professor = professor
  next()
}

/**
 * requireProfessor, plus the admin bit on the row it just fetched.
 *
 * Admin lives only in the database, never in the JWT. The professor row is already
 * re-read on every authenticated request, so granting and revoking admin take
 * effect on the next request with nothing to reissue. The 403 rather than 401 is
 * deliberate: the caller is authenticated fine — this surface just isn't theirs.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  void requireProfessor(req, res, (err?: unknown) => {
    if (err) return next(err)
    if (!(req as ProfessorRequest).professor.isAdmin) return next(new AppError('Forbidden', 403))
    next()
  })
}

export function requireAnyAuth(req: Request, _res: Response, next: NextFunction): void {
  try {
    const auth = req.headers.authorization
    if (!auth?.startsWith('Bearer ')) throw new AppError('Unauthorized', 401)
    jwt.verify(auth.slice(7), config.jwtSecret)
  } catch (err) {
    return next(asAuthError(err))
  }
  next()
}

export async function requireStudent(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  let student: Student
  try {
    const token = extractToken(req)
    const payload = jwt.verify(token, config.jwtSecret) as JwtPayload
    if (payload.role !== 'student') throw new AppError('Unauthorized', 401)

    const row = await prisma.student.findUnique({ where: { id: payload.sub } })
    if (!row) throw new AppError('Unauthorized', 401)
    student = row
  } catch (err) {
    return next(asAuthError(err))
  }

  ;(req as StudentRequest).student = student
  next()
}
