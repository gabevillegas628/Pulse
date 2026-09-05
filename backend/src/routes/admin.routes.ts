import type { Prisma } from '@prisma/client'
import { Router, Request, Response, NextFunction } from 'express'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { prisma } from '../db/index.js'
import { AppError } from '../middleware/error.middleware.js'
import { requireAdmin, ProfessorRequest } from '../middleware/auth.middleware.js'
import { rutgersEmail, personName } from '../utils/validation.js'
import { clearLoginThrottle } from '../middleware/login-throttle.js'
import { sendPasswordResetEmail } from '../services/password-reset.service.js'
import { p } from '../utils/params.js'

/**
 * The admin surface: a system view, account creation, transfer, deactivate,
 * and user management — identities, passwords, deletion.
 *
 * Deliberately not built by widening the ownership predicates. `ownedClass`
 * still means "the class you created" for everyone, admins included â an admin
 * using the normal professor UI sees exactly their own classes, cannot edit
 * anyone else's questions, and is not admitted to anyone else's lecture room.
 * Admin power exists only on these routes, all of which say so in the path.
 *
 * What motivated the system view is worth remembering: a real class with 61
 * students and 121 answers ran for a term under a second, forgotten account,
 * and no screen in the app could have shown it. The view's job is to make that
 * impossible to miss, which is why it is a read over *everything* rather than a
 * filter anyone owns.
 *
 * There is no delete here, only deactivation. Class cascades from Professor, so
 * a delete is a semester of education records â see the schema comment.
 */

const router = Router()

router.use(requireAdmin)

const createProfessorSchema = z.object({
  name: personName,
  email: rutgersEmail,
  // A temporary password the admin hands over out of band; the professor changes
  // it from the header menu. Self-service reset is its own register row.
  password: z.string().min(8),
})

const transferSchema = z.object({
  toProfessorId: z.string().min(1),
})

/**
 * Every professor, every class, with the numbers that make a forgotten account
 * visible: enrollment, submitted answers, and when the last answer landed.
 */
router.get('/professors', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const professors = await prisma.professor.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        email: true,
        name: true,
        isAdmin: true,
        deactivatedAt: true,
        createdAt: true,
        updatedAt: true,
        classes: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            name: true,
            joinCode: true,
            createdAt: true,
            _count: { select: { enrollments: true, sessions: true, assignments: true } },
          },
        },
      },
    })

    // Responses reach a class through Question and then either Session or
    // Assignment, which Prisma's nested _count cannot walk. One aggregate for
    // the whole system beats a count per class. Drafts are excluded: the view
    // reports answers, and a draft is not yet one.
    const responseRows = await prisma.$queryRaw<
      Array<{ classId: string; responseCount: number; lastResponseAt: Date | null }>
    >`
      SELECT COALESCE(s."classId", a."classId") AS "classId",
             COUNT(*)::int                      AS "responseCount",
             MAX(r."submittedAt")               AS "lastResponseAt"
      FROM "Response" r
      JOIN "Question" q ON q.id = r."questionId"
      LEFT JOIN "Session" s ON s.id = q."sessionId"
      LEFT JOIN "Assignment" a ON a.id = q."assignmentId"
      WHERE NOT r."isDraft"
      GROUP BY COALESCE(s."classId", a."classId")
    `
    const byClass = new Map(responseRows.map((r) => [r.classId, r]))

    const data = professors.map((prof) => ({
      ...prof,
      classes: prof.classes.map(({ _count, ...cls }) => ({
        ...cls,
        enrollmentCount: _count.enrollments,
        sessionCount: _count.sessions,
        assignmentCount: _count.assignments,
        responseCount: byClass.get(cls.id)?.responseCount ?? 0,
        lastResponseAt: byClass.get(cls.id)?.lastResponseAt ?? null,
      })),
    }))

    res.json({ success: true, data: { professors: data } })
  } catch (err) {
    next(err)
  }
})

/**
 * Create an account and hand it over. This is the door that replaces the shared
 * invite code for colleague number two: no token is minted, because the admin is
 * not the person being created.
 */
router.post('/professors', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = createProfessorSchema.parse(req.body)
    const existing = await prisma.professor.findFirst({
      where: { email: { equals: body.email, mode: 'insensitive' } },
    })
    if (existing) throw new AppError('Email already in use', 409)

    const passwordHash = await bcrypt.hash(body.password, 12)
    const professor = await prisma.professor.create({
      data: { name: body.name, email: body.email, passwordHash },
    })

    const { passwordHash: _, ...safe } = professor
    res.status(201).json({ success: true, data: { professor: safe } })
  } catch (err) {
    next(err)
  }
})

router.post('/professors/:id/deactivate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = p(req.params.id)
    const admin = (req as ProfessorRequest).professor
    // Locking yourself out is not a workflow, and with one admin it would need
    // database access to undo.
    if (id === admin.id) throw new AppError('You cannot deactivate your own account', 400)

    const target = await prisma.professor.findUnique({ where: { id } })
    if (!target) throw new AppError('Professor not found', 404)

    // Idempotent, and a repeat keeps the original timestamp â when access
    // actually ended is the fact worth preserving.
    const updated = target.deactivatedAt
      ? target
      : await prisma.professor.update({ where: { id }, data: { deactivatedAt: new Date() } })

    const { passwordHash: _, ...safe } = updated
    res.json({ success: true, data: { professor: safe } })
  } catch (err) {
    next(err)
  }
})

router.post('/professors/:id/reactivate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = p(req.params.id)
    const target = await prisma.professor.findUnique({ where: { id } })
    if (!target) throw new AppError('Professor not found', 404)

    const updated = await prisma.professor.update({ where: { id }, data: { deactivatedAt: null } })
    const { passwordHash: _, ...safe } = updated
    res.json({ success: true, data: { professor: safe } })
  } catch (err) {
    next(err)
  }
})

/**
 * Reassign a class, whole: sessions, assignments, enrollments, and responses all
 * hang off the class, so one field is the entire move. The workflow for someone
 * leaving mid-semester is transfer first, deactivate second.
 */
router.post('/classes/:id/transfer', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = p(req.params.id)
    const body = transferSchema.parse(req.body)

    const cls = await prisma.class.findUnique({ where: { id } })
    if (!cls) throw new AppError('Class not found', 404)

    const target = await prisma.professor.findUnique({ where: { id: body.toProfessorId } })
    if (!target) throw new AppError('Target professor not found', 404)
    if (target.deactivatedAt)
      throw new AppError('Cannot transfer a class to a deactivated account', 400)

    const updated = await prisma.class.update({
      where: { id },
      data: { professorId: target.id },
    })

    res.json({ success: true, data: { class: updated } })
  } catch (err) {
    next(err)
  }
})

// âââ User management ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
//
// Students first appear here because every other student surface is scoped to a
// class a professor owns. The admin cases are exactly the unscoped ones: a
// typo'd email nobody self-service can reach, a password with no working email
// behind it, a duplicate account that should not exist at all.

const studentPatchSchema = z
  .object({
    netId: z.string().trim().min(1).optional(),
    email: rutgersEmail.optional(),
  })
  .refine((b) => b.netId !== undefined || b.email !== undefined, {
    message: 'Nothing to change',
  })

const professorPatchSchema = z
  .object({
    name: personName.optional(),
    email: rutgersEmail.optional(),
  })
  .refine((b) => b.name !== undefined || b.email !== undefined, {
    message: 'Nothing to change',
  })

const setPasswordSchema = z.object({ newPassword: z.string().min(8) })

/**
 * Search students by netID or email substring. Capped, with the total alongside,
 * so the page can say "showing 50 of 312" instead of shipping a wall.
 *
 * responseCount is every response row, drafts included â it is the number a
 * delete would take with it, which is what the delete confirmation reports.
 */
router.get('/students', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''
    const where: Prisma.StudentWhereInput = q
      ? {
          OR: [
            { netId: { contains: q, mode: 'insensitive' } },
            { email: { contains: q, mode: 'insensitive' } },
          ],
        }
      : {}

    const [total, students] = await Promise.all([
      prisma.student.count({ where }),
      prisma.student.findMany({
        where,
        orderBy: { netId: 'asc' },
        take: 50,
        select: {
          id: true,
          netId: true,
          email: true,
          createdAt: true,
          _count: { select: { responses: true } },
          enrollments: { select: { class: { select: { id: true, name: true } } } },
        },
      }),
    ])

    res.json({
      success: true,
      data: {
        total,
        students: students.map(({ _count, enrollments, ...s }) => ({
          ...s,
          responseCount: _count.responses,
          enrollments: enrollments.map((e) => ({ classId: e.class.id, className: e.class.name })),
        })),
      },
    })
  } catch (err) {
    next(err)
  }
})

/**
 * Fix a netID or an email. Everything FKs on the cuid, so both are display and
 * login identity only â this is the one place a typo'd registration email can be
 * repaired, which is why the professor-resets-student path still exists at all.
 * A collision with another account comes back as the generic P2002 â 409.
 */
router.patch('/students/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = studentPatchSchema.parse(req.body)
    const id = p(req.params.id)
    const target = await prisma.student.findUnique({ where: { id } })
    if (!target) throw new AppError('Student not found', 404)

    const updated = await prisma.student.update({
      where: { id },
      data: {
        ...(body.netId !== undefined ? { netId: body.netId } : {}),
        ...(body.email !== undefined ? { email: body.email } : {}),
      },
      select: { id: true, netId: true, email: true, createdAt: true },
    })
    res.json({ success: true, data: { student: updated } })
  } catch (err) {
    next(err)
  }
})

/**
 * The reset of last resort: when the email on the account is the broken part, a
 * reset link cannot arrive, so the admin sets a temporary password and hands it
 * over out of band. Clears the sign-in throttle for the same reason the
 * professor-side reset does â the student being reset is usually the student
 * the throttle already locked out.
 */
router.post('/students/:id/set-password', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { newPassword } = setPasswordSchema.parse(req.body)
    const target = await prisma.student.findUnique({ where: { id: p(req.params.id) } })
    if (!target) throw new AppError('Student not found', 404)

    const passwordHash = await bcrypt.hash(newPassword, 12)
    await prisma.student.update({ where: { id: target.id }, data: { passwordHash } })
    await clearLoginThrottle(target.netId, target.email)

    res.json({ success: true, data: null })
  } catch (err) {
    next(err)
  }
})

/**
 * Mail the student a reset link â the same machinery as self-service, minus the
 * don't-reveal-who-exists theatre, which has no audience here: the admin is
 * looking at the account. Awaited, unlike the public route, because the admin
 * is owed a real answer about whether the send happened.
 */
router.post('/students/:id/send-reset', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const target = await prisma.student.findUnique({ where: { id: p(req.params.id) } })
    if (!target) throw new AppError('Student not found', 404)

    await sendPasswordResetEmail(target)
    res.json({ success: true, data: null })
  } catch (err) {
    next(err)
  }
})

/**
 * Delete is for accounts that should not exist â a duplicate, a mistake. It is
 * the one place in the app where cascade is the point: responses, enrollments,
 * and outstanding reset tokens all go with the row. The UI makes the caller say
 * the netID back when answers would be lost; the API trusts the admin.
 */
router.delete('/students/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const target = await prisma.student.findUnique({ where: { id: p(req.params.id) } })
    if (!target) throw new AppError('Student not found', 404)

    await prisma.student.delete({ where: { id: target.id } })
    res.json({ success: true, data: null })
  } catch (err) {
    next(err)
  }
})

/** A professor's name and email are fixable the same way a student's are. */
router.patch('/professors/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = professorPatchSchema.parse(req.body)
    const id = p(req.params.id)
    const target = await prisma.professor.findUnique({ where: { id } })
    if (!target) throw new AppError('Professor not found', 404)

    const updated = await prisma.professor.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.email !== undefined ? { email: body.email } : {}),
      },
    })
    const { passwordHash: _, ...safe } = updated
    res.json({ success: true, data: { professor: safe } })
  } catch (err) {
    next(err)
  }
})

router.post('/professors/:id/set-password', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { newPassword } = setPasswordSchema.parse(req.body)
    const target = await prisma.professor.findUnique({ where: { id: p(req.params.id) } })
    if (!target) throw new AppError('Professor not found', 404)

    const passwordHash = await bcrypt.hash(newPassword, 12)
    await prisma.professor.update({ where: { id: target.id }, data: { passwordHash } })
    // Professor login throttles on the email; a professor being reset is as
    // likely to be locked out as a student being reset.
    await clearLoginThrottle(target.email)

    res.json({ success: true, data: null })
  } catch (err) {
    next(err)
  }
})

export default router
