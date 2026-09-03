import { Request, Response, NextFunction } from 'express'
import { Prisma } from '@prisma/client'
import { ZodError } from 'zod'
import { logger } from '../utils/logger.js'
import { captureException } from '../utils/reporting.js'

export class AppError extends Error {
  constructor(
    public message: string,
    public statusCode: number = 500
  ) {
    super(message)
    this.name = 'AppError'
  }
}

/**
 * A unique constraint was violated — two writes raced past the same check, or a
 * client sent the same request twice. Always the caller's conflict rather than
 * our fault, so it must not leave here as a 500.
 */
export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
}

export function errorMiddleware(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof AppError) {
    // The status alone is not diagnostic: "409" could be a duplicate answer, a closed
    // session or an expired countdown, and after a bad lecture the difference is the
    // whole question. Handed to requestLogger rather than logged here, so a refusal
    // costs one line carrying both the reason and who hit it.
    res.locals.refusalReason = err.message
    res.status(err.statusCode).json({ success: false, error: err.message })
    return
  }

  if (err instanceof ZodError) {
    const reason = err.errors[0]?.message ?? 'Validation error'
    res.locals.refusalReason = reason
    res.status(400).json({ success: false, error: reason })
    return
  }

  // Backstop for every check-then-create in the codebase. Routes that can say
  // something better catch P2002 themselves and throw a specific AppError; this
  // is here so that the ones that don't still refuse honestly instead of
  // reporting our race as the student's server error.
  if (isUniqueViolation(err)) {
    const reason = 'Already exists'
    res.locals.refusalReason = reason
    res.status(409).json({ success: false, error: reason })
    return
  }

  logger.error(err)
  captureException(err, { path: req.path, method: req.method })
  res.status(500).json({ success: false, error: 'Internal server error' })
}
