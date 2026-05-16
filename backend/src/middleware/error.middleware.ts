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
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ success: false, error: err.message })
    return
  }

  if (err instanceof ZodError) {
    res.status(400).json({ success: false, error: err.errors[0]?.message ?? 'Validation error' })
    return
  }

  logger.error(err)
  res.status(500).json({ success: false, error: 'Internal server error' })
}
