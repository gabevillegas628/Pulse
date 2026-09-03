import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { prisma } from '../db/index.js'
import { config } from '../config/index.js'
import { AppError } from './error.middleware.js'
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
  const fresh = jwt.sign({ sub: payload.sub, role: 'professor' }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn as unknown as number, // StringValue cast, as at sign-in
  })
  res.setHeader(RENEWED_TOKEN_HEADER, fresh)
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
  try {
    const token = extractToken(req)
    const payload = jwt.verify(token, config.jwtSecret) as JwtPayload
    if (payload.role !== 'professor') throw new AppError('Unauthorized', 401)

    const professor = await prisma.professor.findUnique({ where: { id: payload.sub } })
    // Deactivation is enforced here, not by revoking tokens: the row is re-read on
    // every request, so a deactivated professor's outstanding tokens die on their
    // next use, renewal included, without anyone keeping a list of them.
    if (!professor || professor.deactivatedAt) throw new AppError('Unauthorized', 401)

    // After the lookup, so a token whose professor no longer exists is not handed a new one.
    renewIfHalfSpent(res, payload)

    ;(req as ProfessorRequest).professor = professor
    next()
  } catch (err) {
    if (err instanceof AppError) return next(err)
    next(new AppError('Unauthorized', 401))
  }
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
    next()
  } catch {
    next(new AppError('Unauthorized', 401))
  }
}

export async function requireStudent(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const token = extractToken(req)
    const payload = jwt.verify(token, config.jwtSecret) as JwtPayload
    if (payload.role !== 'student') throw new AppError('Unauthorized', 401)

    const student = await prisma.student.findUnique({ where: { id: payload.sub } })
    if (!student) throw new AppError('Unauthorized', 401)

    ;(req as StudentRequest).student = student
    next()
  } catch (err) {
    if (err instanceof AppError) return next(err)
    next(new AppError('Unauthorized', 401))
  }
}
