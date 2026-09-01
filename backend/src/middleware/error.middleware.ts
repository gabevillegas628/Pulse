import { Request, Response, NextFunction } from 'express'
import { ZodError } from 'zod'
import { logger } from '../utils/logger.js'

export class AppError extends Error {
  constructor(
    public message: string,
    public statusCode: number = 500
  ) {
    super(message)
    this.name = 'AppError'
  }
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

  logger.error(err)
  res.status(500).json({ success: false, error: 'Internal server error' })
}
