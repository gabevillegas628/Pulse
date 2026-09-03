import { Router, Request, Response, NextFunction } from 'express'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { prisma } from '../db/index.js'
import { AppError } from '../middleware/error.middleware.js'
import { requireAdmin, ProfessorRequest } from '../middleware/auth.middleware.js'
import { rutgersEmail } from '../utils/validation.js'
import { p } from '../utils/params.js'

/**
 * The admin surface: a system view, account creation, transfer, deactivate.
 *
 * Deliberately not built by widening the ownership predicates. `ownedClass`
 * still means "the class you created" for everyone, admins included — an admin
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
 * a delete is a semester of education records — see the schema comment.
 */

const router = Router()

router.use(requireAdmin)

const createProfessorSchema = z.object({
  name: z.string().min(1),
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
    const existing = await prisma.professor.findUnique({ where: { email: body.email } })
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

    // Idempotent, and a repeat keeps the original timestamp — when access
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

export default router
