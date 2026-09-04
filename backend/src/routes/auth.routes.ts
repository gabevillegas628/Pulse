import { Router, Request, Response, NextFunction } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { z } from 'zod'
import { prisma } from '../db/index.js'
import { config } from '../config/index.js'
import { AppError } from '../middleware/error.middleware.js'
import { requireProfessor, requireStudent, ProfessorRequest, StudentRequest } from '../middleware/auth.middleware.js'
import { rutgersEmail, netId, personName } from '../utils/validation.js'
import {
  loginRateLimiter,
  passwordResetAccountLimiter,
  passwordResetIpLimiter,
} from '../middleware/login-throttle.js'
import {
  sendPasswordResetEmail,
  verifyResetToken,
  redeemResetToken,
} from '../services/password-reset.service.js'
import { captureException } from '../utils/reporting.js'

const router = Router()

const professorRegisterSchema = z.object({
  name: personName,
  email: rutgersEmail,
  password: z.string().min(8),
  inviteCode: z.string().min(1),
})

const professorLoginSchema = z.object({
  // Trimmed for the same reason the student credential is: a pasted address arrives
  // with padding often enough, and an exact-match lookup treats that as a different
  // person. Not narrowed to rutgersEmail — this is a door for accounts that already
  // exist, and it is not login's job to re-litigate what address they were made with.
  email: z.string().trim().email(),
  password: z.string().min(1),
})

const studentRegisterSchema = z.object({
  netId,
  email: rutgersEmail,
  password: z.string().min(8),
})

const studentLoginSchema = z.object({
  // Trimmed and lowercased to match how NetIDs are now stored, and how the throttle
  // above already keys them. Without this a student who typed `SK2997` missed their
  // own row and still spent one of that account's ten attempts.
  credential: z.string().trim().toLowerCase().min(1),
  password: z.string().min(1),
})

// --- Professor auth ---

router.post('/professor/register', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = professorRegisterSchema.parse(req.body)
    if (!config.professorInviteCode || body.inviteCode !== config.professorInviteCode)
      throw new AppError('Invalid invite code', 403)
    const existing = await prisma.professor.findFirst({
      where: { email: { equals: body.email, mode: 'insensitive' } },
    })
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

router.post('/professor/login', loginRateLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = professorLoginSchema.parse(req.body)
    // Case-insensitive for the reason the student lookup is: an address is the same
    // address whatever case it is typed in, and an exact match meant a professor who
    // capitalised their own email missed their row and spent one of that account's
    // ten attempts doing it.
    const professor = await prisma.professor.findFirst({
      where: { email: { equals: body.email, mode: 'insensitive' } },
    })
    if (!professor) throw new AppError('Invalid credentials', 401)

    const valid = await bcrypt.compare(body.password, professor.passwordHash)
    if (!valid) throw new AppError('Invalid credentials', 401)

    // After the password check, so whether an account is deactivated is never
    // leaked to someone guessing at it.
    if (professor.deactivatedAt) throw new AppError('This account has been deactivated', 403)

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
      where: {
        OR: [
          { email: { equals: body.email, mode: 'insensitive' } },
          { netId: { equals: body.netId, mode: 'insensitive' } },
        ],
      },
    })
    if (existing) throw new AppError('Email or NetID already in use', 409)

    const passwordHash = await bcrypt.hash(body.password, 12)
    const student = await prisma.student.create({
      data: { netId: body.netId, email: body.email, passwordHash },
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

router.post('/student/login', loginRateLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = studentLoginSchema.parse(req.body)
    const student = await prisma.student.findFirst({
      where: {
        OR: [
          { email: { equals: body.credential, mode: 'insensitive' } },
          { netId: { equals: body.credential, mode: 'insensitive' } },
        ],
      },
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

// --- Student password reset ---

/**
 * The three routes below are the self-service half of password recovery. The other
 * half — a professor resetting a student from the class roster — stays exactly as it
 * was, and is still the only path for a student whose email address on file is wrong.
 *
 * `token` travels in the body on all three, never in a path segment: paths reach
 * access logs whole, and a reset token in a log line is a working key to an account.
 */

const forgotPasswordSchema = z.object({
  // Same shape as the login credential: a student who has forgotten their password
  // has certainly not memorised which of the two identifiers we store them under.
  credential: z.string().trim().toLowerCase().min(1),
})

const resetTokenSchema = z.object({ token: z.string().min(1) })

const resetPasswordSchema = z.object({
  token: z.string().min(1),
  // Matched to registration and to the signed-in change. A reset is not the place to
  // start enforcing a rule the other two doors do not.
  newPassword: z.string().min(8),
})

/**
 * Ask for a reset link.
 *
 * Answers identically whether or not the account exists, and does not wait for the
 * mail to be handed to Brevo before replying. Both are the same requirement: this
 * endpoint must not become a way to find out who has a Pulse account, and a response
 * that is half a second slower for real accounts says so just as loudly as a
 * different message would.
 */
router.post(
  '/student/forgot-password',
  passwordResetIpLimiter,
  passwordResetAccountLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = forgotPasswordSchema.parse(req.body)

      const student = await prisma.student.findFirst({
        where: {
          OR: [
            { email: { equals: body.credential, mode: 'insensitive' } },
            { netId: { equals: body.credential, mode: 'insensitive' } },
          ],
        },
        select: { id: true, netId: true, email: true },
      })

      if (student) {
        void sendPasswordResetEmail(student).catch((err) =>
          captureException(err, { source: 'forgot-password' })
        )
      }

      res.json({
        success: true,
        data: { message: 'If that account exists, a reset link is on its way to its Rutgers email.' },
      })
    } catch (err) {
      next(err)
    }
  }
)

/**
 * Check a link without spending it, so the page can say "this expired" before a
 * student picks a password rather than after they submit one.
 */
router.post('/student/reset-password/verify', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token } = resetTokenSchema.parse(req.body)
    const { netId } = await verifyResetToken(token)
    res.json({ success: true, data: { netId } })
  } catch (err) {
    next(err)
  }
})

/** Spend a link and set the new password. */
router.post('/student/reset-password', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = resetPasswordSchema.parse(req.body)
    await redeemResetToken(body.token, body.newPassword)
    res.json({ success: true, data: null })
  } catch (err) {
    next(err)
  }
})

export default router
