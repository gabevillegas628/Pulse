import { Router, Request, Response, NextFunction } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { z } from 'zod'
import { prisma } from '../db/index.js'
import { config } from '../config/index.js'
import { AppError } from '../middleware/error.middleware.js'
import { requireProfessor, requireStudent, ProfessorRequest, StudentRequest } from '../middleware/auth.middleware.js'

const router = Router()

const rutgersEmail = z.string().email().endsWith('@rutgers.edu', { message: 'Must be a @rutgers.edu email address' })

const professorRegisterSchema = z.object({
  name: z.string().min(1),
  email: rutgersEmail,
  password: z.string().min(8),
  inviteCode: z.string().min(1),
})

const professorLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

const studentRegisterSchema = z.object({
  name: z.string().min(1),
  netId: z.string().min(1),
  email: rutgersEmail,
  password: z.string().min(8),
})

const studentLoginSchema = z.object({
  credential: z.string().min(1),
  password: z.string().min(1),
})

// --- Professor auth ---

router.post('/professor/register', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = professorRegisterSchema.parse(req.body)
    if (!config.professorInviteCode || body.inviteCode !== config.professorInviteCode)
      throw new AppError('Invalid invite code', 403)
    const existing = await prisma.professor.findUnique({ where: { email: body.email } })
    if (existing) throw new AppError('Email already in use', 409)

    const passwordHash = await bcrypt.hash(body.password, 12)
    const professor = await prisma.professor.create({
      data: { name: body.name, email: body.email, passwordHash },
    })

    const token = jwt.sign({ sub: professor.id, role: 'professor' }, config.jwtSecret, {
      expiresIn: config.jwtExpiresIn as unknown as number, // StringValue cast
    })

    const { passwordHash: _, ...safe } = professor
    res.status(201).json({ success: true, data: { token, professor: safe } })
  } catch (err) {
    next(err)
  }
})

router.post('/professor/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = professorLoginSchema.parse(req.body)
    const professor = await prisma.professor.findUnique({ where: { email: body.email } })
    if (!professor) throw new AppError('Invalid credentials', 401)

    const valid = await bcrypt.compare(body.password, professor.passwordHash)
    if (!valid) throw new AppError('Invalid credentials', 401)

    const token = jwt.sign({ sub: professor.id, role: 'professor' }, config.jwtSecret, {
      expiresIn: config.jwtExpiresIn as unknown as number,
    })

    const { passwordHash: _, ...safe } = professor
    res.json({ success: true, data: { token, professor: safe } })
  } catch (err) {
    next(err)
  }
})

router.get('/professor/me', requireProfessor, (req: Request, res: Response) => {
  const { passwordHash: _, ...safe } = (req as ProfessorRequest).professor
  res.json({ success: true, data: { professor: safe } })
})

router.patch('/professor/me/password', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { currentPassword, newPassword } = z.object({
      currentPassword: z.string().min(1),
      newPassword: z.string().min(8),
    }).parse(req.body)

    const professor = (req as ProfessorRequest).professor
    const valid = await bcrypt.compare(currentPassword, professor.passwordHash)
    if (!valid) throw new AppError('Current password is incorrect', 401)

    const passwordHash = await bcrypt.hash(newPassword, 12)
    await prisma.professor.update({ where: { id: professor.id }, data: { passwordHash } })

    res.json({ success: true, data: null })
  } catch (err) {
    next(err)
  }
})

// --- Student auth ---

router.post('/student/register', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = studentRegisterSchema.parse(req.body)
    const existing = await prisma.student.findFirst({
      where: { OR: [{ email: body.email }, { netId: body.netId }] },
    })
    if (existing) throw new AppError('Email or NetID already in use', 409)

    const passwordHash = await bcrypt.hash(body.password, 12)
    const student = await prisma.student.create({
      data: { name: body.name, netId: body.netId, email: body.email, passwordHash },
    })

    const token = jwt.sign({ sub: student.id, role: 'student' }, config.jwtSecret, {
      expiresIn: config.jwtExpiresIn as unknown as number,
    })

    const { passwordHash: _, ...safe } = student
    res.status(201).json({ success: true, data: { token, student: safe } })
  } catch (err) {
    next(err)
  }
})

router.post('/student/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = studentLoginSchema.parse(req.body)
    const student = await prisma.student.findFirst({
      where: { OR: [{ email: body.credential }, { netId: body.credential }] },
    })
    if (!student) throw new AppError('Invalid credentials', 401)

    const valid = await bcrypt.compare(body.password, student.passwordHash)
    if (!valid) throw new AppError('Invalid credentials', 401)

    const token = jwt.sign({ sub: student.id, role: 'student' }, config.jwtSecret, {
      expiresIn: config.jwtExpiresIn as unknown as number,
    })

    const { passwordHash: _, ...safe } = student
    res.json({ success: true, data: { token, student: safe } })
  } catch (err) {
    next(err)
  }
})

router.get('/student/me', requireStudent, (req: Request, res: Response) => {
  const { passwordHash: _, ...safe } = (req as StudentRequest).student
  res.json({ success: true, data: { student: safe } })
})

router.patch('/student/me/password', requireStudent, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { currentPassword, newPassword } = z.object({
      currentPassword: z.string().min(1),
      newPassword: z.string().min(8),
    }).parse(req.body)

    const student = (req as StudentRequest).student
    const valid = await bcrypt.compare(currentPassword, student.passwordHash)
    if (!valid) throw new AppError('Current password is incorrect', 401)

    const passwordHash = await bcrypt.hash(newPassword, 12)
    await prisma.student.update({ where: { id: student.id }, data: { passwordHash } })

    res.json({ success: true, data: null })
  } catch (err) {
    next(err)
  }
})

export default router
