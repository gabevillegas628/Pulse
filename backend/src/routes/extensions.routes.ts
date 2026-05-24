import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { prisma } from '../db/index.js'
import { AppError } from '../middleware/error.middleware.js'
import { requireProfessor, ProfessorRequest } from '../middleware/auth.middleware.js'
import { p } from '../utils/params.js'

const router = Router()

// List deadline extensions for a session
router.get('/sessions/:id/extensions', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const session = await prisma.session.findFirst({
      where: { id: p(req.params.id), class: { professorId: professor.id } },
    })
    if (!session) throw new AppError('Session not found', 404)

    const extensions = await prisma.deadlineExtension.findMany({
      where: { sessionId: session.id },
      include: { student: { select: { id: true, netId: true } } },
      orderBy: { createdAt: 'asc' },
    })
    res.json({ success: true, data: { extensions } })
  } catch (err) {
    next(err)
  }
})

// Grant or update a deadline extension for a student
router.post('/sessions/:id/extensions', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const { studentId, deadline } = z.object({
      studentId: z.string().min(1),
      deadline: z.string().datetime(),
    }).parse(req.body)

    const session = await prisma.session.findFirst({
      where: { id: p(req.params.id), class: { professorId: professor.id } },
    })
    if (!session) throw new AppError('Session not found', 404)

    const enrollment = await prisma.enrollment.findUnique({
      where: { studentId_classId: { studentId, classId: session.classId } },
    })
    if (!enrollment) throw new AppError('Student is not enrolled in this class', 400)

    const extension = await prisma.deadlineExtension.upsert({
      where: { sessionId_studentId: { sessionId: session.id, studentId } },
      create: { sessionId: session.id, studentId, deadline: new Date(deadline) },
      update: { deadline: new Date(deadline) },
      include: { student: { select: { id: true, netId: true } } },
    })
    res.status(201).json({ success: true, data: { extension } })
  } catch (err) {
    next(err)
  }
})

// Remove a deadline extension
router.delete('/sessions/:id/extensions/:studentId', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const session = await prisma.session.findFirst({
      where: { id: p(req.params.id), class: { professorId: professor.id } },
    })
    if (!session) throw new AppError('Session not found', 404)

    await prisma.deadlineExtension.deleteMany({
      where: { sessionId: session.id, studentId: p(req.params.studentId) },
    })
    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

export default router
