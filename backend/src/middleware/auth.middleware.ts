import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { prisma } from '../db/index.js'
import { config } from '../config/index.js'
import { AppError } from './error.middleware.js'
import type { Professor, Student } from '@prisma/client'

interface JwtPayload {
  sub: string
  role: 'professor' | 'student'
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
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const token = extractToken(req)
    const payload = jwt.verify(token, config.jwtSecret) as JwtPayload
    if (payload.role !== 'professor') throw new AppError('Unauthorized', 401)

    const professor = await prisma.professor.findUnique({ where: { id: payload.sub } })
    if (!professor) throw new AppError('Unauthorized', 401)

    ;(req as ProfessorRequest).professor = professor
    next()
  } catch (err) {
    if (err instanceof AppError) return next(err)
    next(new AppError('Unauthorized', 401))
  }
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
