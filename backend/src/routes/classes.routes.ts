import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import bcrypt from 'bcryptjs'
import { customAlphabet } from 'nanoid'
import { prisma } from '../db/index.js'
import { AppError } from '../middleware/error.middleware.js'
import { requireProfessor, ProfessorRequest } from '../middleware/auth.middleware.js'

const nanoid = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6)

const router = Router()

// Express v5 types params as string | string[] — helper to normalize
const p = (v: string | string[]): string => (Array.isArray(v) ? v[0] : v)
router.use(requireProfessor)

const createClassSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
})

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = createClassSchema.parse(req.body)
    const professor = (req as ProfessorRequest).professor

    let joinCode: string
    let attempts = 0
    do {
      joinCode = nanoid()
      attempts++
      if (attempts > 10) throw new AppError('Failed to generate unique join code', 500)
    } while (await prisma.class.findUnique({ where: { joinCode } }))

    const cls = await prisma.class.create({
      data: {
        name: body.name,
        description: body.description ?? null,
        joinCode,
        professorId: professor.id,
      },
      include: { _count: { select: { sessions: true, enrollments: true } } },
    })

    res.status(201).json({ success: true, data: { class: cls } })
  } catch (err) {
    next(err)
  }
})

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const classes = await prisma.class.findMany({
      where: { professorId: professor.id },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { sessions: true, enrollments: true } } },
    })
    res.json({ success: true, data: { classes } })
  } catch (err) {
    next(err)
  }
})

router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const cls = await prisma.class.findFirst({
      where: { id: p(req.params.id), professorId: professor.id },
      include: {
        _count: { select: { sessions: true, enrollments: true } },
        sessions: {
          orderBy: { createdAt: 'desc' },
          include: { _count: { select: { questions: true } }, questions: { orderBy: { order: 'asc' } } },
        },
      },
    })
    if (!cls) throw new AppError('Class not found', 404)
    res.json({ success: true, data: { class: cls } })
  } catch (err) {
    next(err)
  }
})

router.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const body = createClassSchema.partial().parse(req.body)
    const existing = await prisma.class.findFirst({
      where: { id: p(req.params.id), professorId: professor.id },
    })
    if (!existing) throw new AppError('Class not found', 404)

    const updated = await prisma.class.update({
      where: { id: p(req.params.id) },
      data: body,
    })
    res.json({ success: true, data: { class: updated } })
  } catch (err) {
    next(err)
  }
})

router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const existing = await prisma.class.findFirst({
      where: { id: p(req.params.id), professorId: professor.id },
    })
    if (!existing) throw new AppError('Class not found', 404)
    await prisma.class.delete({ where: { id: p(req.params.id) } })
    res.json({ success: true, data: null })
  } catch (err) {
    next(err)
  }
})

router.get('/:id/enrollments', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const classId = p(req.params.id)

    const cls = await prisma.class.findFirst({ where: { id: classId, professorId: professor.id } })
    if (!cls) throw new AppError('Class not found', 404)

    const [enrollments, allResponses, totalClosedSessions] = await Promise.all([
      prisma.enrollment.findMany({
        where: { classId },
        include: { student: { select: { id: true, netId: true, name: true, email: true } } },
        orderBy: { enrolledAt: 'desc' },
      }),
      prisma.response.findMany({
        where: { question: { session: { classId } } },
        select: {
          studentId: true,
          wordCount: true,
          question: { select: { sessionId: true, type: true } },
        },
      }),
      prisma.session.count({ where: { classId, status: { in: ['CLOSED', 'ARCHIVED'] } } }),
    ])

    type StatsAgg = { totalResponses: number; sessionIds: Set<string>; totalWordCount: number; freeTextCount: number }
    const byStudent = new Map<string, StatsAgg>()
    for (const r of allResponses) {
      const s = byStudent.get(r.studentId) ?? { totalResponses: 0, sessionIds: new Set<string>(), totalWordCount: 0, freeTextCount: 0 }
      s.totalResponses++
      s.sessionIds.add(r.question.sessionId)
      if (r.question.type === 'FREE_TEXT') { s.totalWordCount += r.wordCount; s.freeTextCount++ }
      byStudent.set(r.studentId, s)
    }

    const enriched = enrollments.map((e) => {
      const s = byStudent.get(e.student.id)
      return {
        ...e,
        stats: {
          totalResponses: s?.totalResponses ?? 0,
          sessionsParticipated: s?.sessionIds.size ?? 0,
          totalClosedSessions,
          averageWordCount: s && s.freeTextCount > 0 ? Math.round(s.totalWordCount / s.freeTextCount) : 0,
        },
      }
    })

    res.json({ success: true, data: { enrollments: enriched } })
  } catch (err) {
    next(err)
  }
})

router.get('/:id/students/:studentId/activity', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const classId = p(req.params.id)
    const studentId = p(req.params.studentId)

    const cls = await prisma.class.findFirst({ where: { id: classId, professorId: professor.id } })
    if (!cls) throw new AppError('Class not found', 404)

    const sessions = await prisma.session.findMany({
      where: { classId, NOT: { status: 'DRAFT' } },
      orderBy: { createdAt: 'desc' },
      include: {
        questions: {
          orderBy: { order: 'asc' },
          include: {
            responses: {
              where: { studentId },
              select: { responseText: true, wordCount: true, isFlagged: true, submittedAt: true },
            },
          },
        },
      },
    })

    const result = sessions.map((session) => ({
      id: session.id,
      title: session.title,
      status: session.status,
      createdAt: session.createdAt,
      questions: session.questions.map((q, i) => ({
        id: q.id,
        text: q.text,
        type: q.type,
        number: i + 1,
        response: q.responses[0] ?? null,
      })),
    }))

    res.json({ success: true, data: { sessions: result } })
  } catch (err) {
    next(err)
  }
})

router.post('/:id/students/:studentId/reset-password', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const { newPassword } = z.object({ newPassword: z.string().min(8) }).parse(req.body)

    const cls = await prisma.class.findFirst({
      where: { id: p(req.params.id), professorId: professor.id },
    })
    if (!cls) throw new AppError('Class not found', 404)

    const enrollment = await prisma.enrollment.findUnique({
      where: { studentId_classId: { studentId: p(req.params.studentId), classId: cls.id } },
    })
    if (!enrollment) throw new AppError('Student not in this class', 404)

    const passwordHash = await bcrypt.hash(newPassword, 12)
    await prisma.student.update({
      where: { id: p(req.params.studentId) },
      data: { passwordHash },
    })

    res.json({ success: true, data: null })
  } catch (err) {
    next(err)
  }
})

function calcScore(
  qType: string,
  correctAnswer: string | null,
  response: { responseText: string; aiScore: number | null } | null
): number {
  if (!response) return 0
  if (qType === 'MULTIPLE_CHOICE' || qType === 'YES_NO') {
    if (!correctAnswer) return 1.0
    return response.responseText === correctAnswer ? 1.0 : 0.5
  }
  if (qType === 'FREE_TEXT') {
    return response.aiScore !== null && response.aiScore !== undefined ? response.aiScore : 1.0
  }
  return 1.0 // RATING
}

// Class-wide grades export — one row per student, one column per closed session
router.get('/:id/grades', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const classId = p(req.params.id)

    const cls = await prisma.class.findFirst({
      where: { id: classId, professorId: professor.id },
      include: {
        enrollments: { include: { student: { select: { id: true, netId: true, name: true } } } },
        sessions: {
          where: { status: { in: ['CLOSED', 'ARCHIVED'] } },
          orderBy: { createdAt: 'asc' },
          include: {
            questions: {
              orderBy: { order: 'asc' },
              include: {
                responses: { select: { studentId: true, responseText: true, aiScore: true } },
              },
            },
          },
        },
      },
    })
    if (!cls) throw new AppError('Class not found', 404)

    const students = cls.enrollments.map((e) => e.student)
    const sessions = cls.sessions

    const sessionMaxes = sessions.map((s) => s.questions.length)
    const grandMax = sessionMaxes.reduce((a, b) => a + b, 0)

    const sessionHeaders = sessions.map((s) => s.title.replace(/,/g, ' '))
    const header = ['NetID', 'Name', ...sessionHeaders, 'Grand Total', `Grand Max (${grandMax})`].join(',')

    const csvRows = students.map((student) => {
      const sessionTotals = sessions.map((session) => {
        return session.questions.reduce((sum, q) => {
          const resp = q.responses.find((r) => r.studentId === student.id) ?? null
          return sum + calcScore(q.type, q.correctAnswer, resp)
        }, 0)
      })
      const grandTotal = sessionTotals.reduce((a, b) => a + b, 0)
      return [
        student.netId,
        `"${student.name}"`,
        ...sessionTotals.map((t) => t.toFixed(1)),
        grandTotal.toFixed(1),
        grandMax.toFixed(1),
      ].join(',')
    })

    const csv = [header, ...csvRows].join('\n')
    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', `attachment; filename="class-${classId}-grades.csv"`)
    res.send(csv)
  } catch (err) {
    next(err)
  }
})

export default router
