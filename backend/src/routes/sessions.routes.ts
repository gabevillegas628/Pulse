import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { customAlphabet } from 'nanoid'
import { Prisma } from '@prisma/client'
import { prisma } from '../db/index.js'
import { AppError } from '../middleware/error.middleware.js'
import { requireProfessor, ProfessorRequest } from '../middleware/auth.middleware.js'
import { getIo } from '../socket.js'
import { SessionStatus } from 'shared'
import { calcScore } from '../utils/scoring.js'
import { generateUniqueCode } from '../utils/codes.js'
import { attachQuestionQrs } from '../utils/qr.js'
import { p } from '../utils/params.js'

const nanoidDigits = customAlphabet('0123456789', 4)

const generateUniqueQuestionCode = () =>
  generateUniqueCode(
    nanoidDigits,
    (code) => prisma.question.findUnique({ where: { accessCode: code } }).then(Boolean),
    20
  )

const questionInputSchema = z.object({
  text: z.string().min(1),
  type: z.enum(['FREE_TEXT', 'MULTIPLE_CHOICE', 'RATING', 'YES_NO', 'NUMERIC', 'MULTI_SELECT', 'ORDERING', 'STRUCTURE']),
  options: z.array(z.string()).optional(),
  order: z.number().int().min(0),
})

const createSessionSchema = z.object({
  title: z.string().min(1),
  type: z.enum(['IN_CLASS', 'HOMEWORK']).optional().default('IN_CLASS'),
  deadline: z.string().datetime().optional(),
  questions: z.array(questionInputSchema).default([]),
})

const router = Router()

// Create a session (with optional initial questions)
router.post('/classes/:classId/sessions', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const body = createSessionSchema.parse(req.body)

    const cls = await prisma.class.findFirst({
      where: { id: p(req.params.classId), professorId: professor.id },
    })
    if (!cls) throw new AppError('Class not found', 404)

    const accessCode = await generateUniqueCode(
      nanoidDigits,
      (code) => prisma.session.findUnique({ where: { accessCode: code } }).then(Boolean),
      20
    )

    const questionCodes = await Promise.all(body.questions.map(() => generateUniqueQuestionCode()))

    const session = await prisma.session.create({
      data: {
        classId: cls.id,
        title: body.title,
        type: body.type,
        deadline: body.deadline ? new Date(body.deadline) : undefined,
        accessCode,
        questions: {
          create: body.questions.map((q, i) => ({
            text: q.text,
            type: q.type as import('@prisma/client').QuestionType,
            options: q.options && q.options.length > 0 ? q.options : undefined,
            order: q.order,
            accessCode: questionCodes[i],
          })),
        },
      },
      include: { questions: { orderBy: { order: 'asc' } } },
    })

    const questionsWithQr = await attachQuestionQrs(session.questions as { id: string; accessCode: string; [key: string]: unknown }[])
    res.status(201).json({ success: true, data: { session: { ...session, questions: questionsWithQr } } })
  } catch (err) {
    next(err)
  }
})

// List sessions for a class
router.get('/classes/:classId/sessions', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const cls = await prisma.class.findFirst({
      where: { id: p(req.params.classId), professorId: professor.id },
      include: { _count: { select: { enrollments: true } } },
    })
    if (!cls) throw new AppError('Class not found', 404)

    const typeFilter = req.query.type as string | undefined
    const sessions = await prisma.session.findMany({
      where: {
        classId: cls.id,
        ...(typeFilter === 'IN_CLASS' || typeFilter === 'HOMEWORK' ? { type: typeFilter } : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: {
        questions: { orderBy: { order: 'asc' } },
        _count: { select: { questions: true } },
        targetSection: { select: { id: true, name: true } },
      },
    })

    // Distinct responder count per session via raw SQL
    const sessionIds = sessions.map((s) => s.id)
    let respondentMap: Record<string, number> = {}
    if (sessionIds.length > 0) {
      const rows = await prisma.$queryRaw<Array<{ sessionId: string; respondentCount: bigint }>>(
        Prisma.sql`
          SELECT s.id AS "sessionId", COUNT(DISTINCT r."studentId") AS "respondentCount"
          FROM "Session" s
          LEFT JOIN "Question" q ON q."sessionId" = s.id
          LEFT JOIN "Response" r ON r."questionId" = q.id
          WHERE s.id IN (${Prisma.join(sessionIds)})
          GROUP BY s.id
        `
      )
      for (const row of rows) {
        respondentMap[row.sessionId] = Number(row.respondentCount)
      }
    }

    const result = sessions.map((s) => ({
      ...s,
      respondentCount: respondentMap[s.id] ?? 0,
    }))

    res.json({ success: true, data: { sessions: result, enrolledCount: cls._count.enrollments } })
  } catch (err) {
    next(err)
  }
})

// Get a single session with questions and responses
router.get('/sessions/:id', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const session = await prisma.session.findFirst({
      where: { id: p(req.params.id), class: { professorId: professor.id } },
      include: {
        class: { select: { id: true, name: true, _count: { select: { enrollments: true } } } },
        targetSection: { select: { id: true, name: true } },
        groups: { orderBy: [{ order: 'asc' }, { createdAt: 'asc' }] },
        questions: {
          orderBy: { order: 'asc' },
          include: {
            responses: {
              include: { student: { select: { id: true, netId: true } } },
              orderBy: { submittedAt: 'desc' },
            },
          },
        },
      },
    })
    if (!session) throw new AppError('Session not found', 404)

    const questionsWithQr = await attachQuestionQrs(
      session.questions as { id: string; accessCode: string; [key: string]: unknown }[]
    )
    const enrolledCount = (session.class as typeof session.class & { _count: { enrollments: number } })._count.enrollments
    res.json({ success: true, data: { session: { ...session, enrolledCount, questions: questionsWithQr } } })
  } catch (err) {
    next(err)
  }
})

// Update session status, section targeting, or deadline
router.patch('/sessions/:id', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const body = z.object({
      status: z.nativeEnum(SessionStatus).optional(),
      targetSectionId: z.string().nullable().optional(),
      deadline: z.string().datetime().nullable().optional(),
    }).parse(req.body)

    const existing = await prisma.session.findFirst({
      where: { id: p(req.params.id), class: { professorId: professor.id } },
      include: { class: { select: { id: true } } },
    })
    if (!existing) throw new AppError('Session not found', 404)

    if (body.targetSectionId !== undefined && existing.status === SessionStatus.OPEN) {
      throw new AppError('Cannot change target section while session is open', 400)
    }
    if (body.targetSectionId) {
      const section = await prisma.section.findFirst({
        where: { id: body.targetSectionId, classId: existing.class.id },
      })
      if (!section) throw new AppError('Section not found in this class', 404)
    }

    const { status } = body
    const updated = await prisma.session.update({
      where: { id: p(req.params.id) },
      data: {
        ...(status !== undefined && {
          status,
          openedAt: status === SessionStatus.OPEN ? new Date() : existing.openedAt,
          closedAt: status === SessionStatus.CLOSED && !existing.closedAt ? new Date() : existing.closedAt,
        }),
        ...(body.targetSectionId !== undefined && { targetSectionId: body.targetSectionId }),
        ...(body.deadline !== undefined && { deadline: body.deadline ? new Date(body.deadline) : null }),
      },
      include: { targetSection: { select: { id: true, name: true } } },
    })

    if (status !== undefined) {
      getIo().to(p(req.params.id)).emit('session_status', { status })
    }
    res.json({ success: true, data: { session: updated } })
  } catch (err) {
    next(err)
  }
})

// Delete a session
router.delete('/sessions/:id', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const existing = await prisma.session.findFirst({
      where: { id: p(req.params.id), class: { professorId: professor.id } },
    })
    if (!existing) throw new AppError('Session not found', 404)
    await prisma.session.delete({ where: { id: p(req.params.id) } })
    res.json({ success: true, data: null })
  } catch (err) {
    next(err)
  }
})

// CSV grade export — all enrolled students with per-question scores
router.get('/sessions/:id/export', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const session = await prisma.session.findFirst({
      where: { id: p(req.params.id), class: { professorId: professor.id } },
      include: {
        class: { include: { enrollments: { include: { student: { select: { id: true, netId: true } } } } } },
        questions: {
          orderBy: { order: 'asc' },
          include: {
            responses: { select: { studentId: true, responseText: true, wordCount: true, aiScore: true } },
          },
        },
      },
    })
    if (!session) throw new AppError('Session not found', 404)

    const students = session.class.enrollments.map((e) => e.student)

    type Row = { netId: string; scores: number[] }
    const rows: Row[] = students.map((s) => {
      const scores = session.questions.map((q) => {
        const resp = q.responses.find((r) => r.studentId === s.id) ?? null
        return calcScore(q.type, q.correctAnswer, resp, q.tolerance)
      })
      return { netId: s.netId, scores }
    })

    const maxPerQ = session.questions.map(() => 1.0)
    const grandMax = maxPerQ.reduce((a, b) => a + b, 0)

    const qHeaders = session.questions.map((_q, i) => `Q${i + 1} Score`)
    const header = ['NetID', ...qHeaders, 'Total', `Max (${grandMax})`].join(',')
    const csvRows = rows.map((r) => {
      const total = r.scores.reduce((a, b) => a + b, 0)
      return [r.netId, ...r.scores.map(String), total.toFixed(1), grandMax.toFixed(1)].join(',')
    })

    const csv = [header, ...csvRows].join('\n')
    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', `attachment; filename="session-${session.id}-grades.csv"`)
    res.send(csv)
  } catch (err) {
    next(err)
  }
})

export default router
