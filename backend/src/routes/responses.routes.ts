import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { prisma } from '../db/index.js'
import { AppError } from '../middleware/error.middleware.js'
import { requireStudent, StudentRequest } from '../middleware/auth.middleware.js'
import { getIo } from '../socket.js'

const router = Router()
const p = (v: string | string[]): string => (Array.isArray(v) ? v[0] : v)

const submitSchema = z.object({
  sessionId: z.string().min(1),
  responses: z.array(
    z.object({
      questionId: z.string().min(1),
      responseText: z.string(),
    })
  ).min(1),
})

// Submit responses (student, JWT required)
router.post('/', requireStudent, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = submitSchema.parse(req.body)
    const student = (req as StudentRequest).student

    const session = await prisma.session.findUnique({
      where: { id: body.sessionId },
      include: { questions: true, class: true },
    })
    if (!session) throw new AppError('Session not found', 404)
    if (session.status !== 'OPEN') throw new AppError('Session is not open', 409)

    // Validate all submitted questionIds belong to this session
    const validIds = new Set(session.questions.map((q) => q.id))
    for (const r of body.responses) {
      if (!validIds.has(r.questionId)) throw new AppError(`Question ${r.questionId} not found in session`, 400)
    }

    // Check if student already submitted any answer in this session
    const existingResponse = await prisma.response.findFirst({
      where: {
        studentId: student.id,
        question: { sessionId: body.sessionId },
      },
    })
    if (existingResponse) throw new AppError('You have already submitted a response for this session', 409)

    // Auto-enroll student in the class if not already enrolled
    await prisma.enrollment.upsert({
      where: { studentId_classId: { studentId: student.id, classId: session.classId } },
      create: { studentId: student.id, classId: session.classId },
      update: {},
    })

    // Create all responses atomically
    const questionMap = new Map(session.questions.map((q) => [q.id, q]))
    const responseData = body.responses.map((r) => {
      const question = questionMap.get(r.questionId)!
      const wordCount = question.type === 'FREE_TEXT'
        ? r.responseText.trim().split(/\s+/).filter(Boolean).length
        : 0
      return {
        questionId: r.questionId,
        studentId: student.id,
        responseText: r.responseText,
        wordCount,
        isFlagged: question.type === 'FREE_TEXT' && wordCount < 10,
      }
    })

    const created = await prisma.$transaction(
      responseData.map((d) => prisma.response.create({ data: d }))
    )

    // Emit to professor dashboard
    getIo().to(body.sessionId).emit('new_response', {
      student: { id: student.id, netId: student.netId, name: student.name },
      responses: created,
      sessionId: body.sessionId,
    })

    res.status(201).json({ success: true, data: { responses: created } })
  } catch (err) {
    next(err)
  }
})

// Student: list enrolled classes with open sessions
router.get('/student/classes', requireStudent, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const student = (req as StudentRequest).student
    const enrollments = await prisma.enrollment.findMany({
      where: { studentId: student.id },
      include: {
        class: {
          include: {
            professor: { select: { name: true } },
            sessions: {
              where: { status: 'OPEN' },
              orderBy: { createdAt: 'desc' },
              include: { questions: { orderBy: { order: 'asc' } } },
            },
          },
        },
      },
      orderBy: { enrolledAt: 'desc' },
    })
    res.json({ success: true, data: { enrollments } })
  } catch (err) {
    next(err)
  }
})

// Student: enroll in a class by joinCode
router.post('/student/enroll', requireStudent, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { joinCode } = z.object({ joinCode: z.string().min(1) }).parse(req.body)
    const student = (req as StudentRequest).student

    const cls = await prisma.class.findUnique({ where: { joinCode } })
    if (!cls) throw new AppError('Class not found — check the join code', 404)

    const enrollment = await prisma.enrollment.upsert({
      where: { studentId_classId: { studentId: student.id, classId: cls.id } },
      create: { studentId: student.id, classId: cls.id },
      update: {},
      include: { class: { include: { professor: { select: { name: true } } } } },
    })

    res.json({ success: true, data: { enrollment } })
  } catch (err) {
    next(err)
  }
})

// Student: get session info (with questions) by sessionId
router.get('/student/sessions/:id', requireStudent, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const student = (req as StudentRequest).student

    const session = await prisma.session.findUnique({
      where: { id: p(req.params.id) },
      include: {
        questions: { orderBy: { order: 'asc' } },
        class: { select: { id: true, name: true, professorId: true } },
      },
    })
    if (!session) throw new AppError('Session not found', 404)
    if (session.status === 'ARCHIVED') throw new AppError('Session not found', 404)

    // Auto-enroll if not enrolled
    await prisma.enrollment.upsert({
      where: { studentId_classId: { studentId: student.id, classId: session.classId } },
      create: { studentId: student.id, classId: session.classId },
      update: {},
    })

    // Check if already submitted
    const alreadySubmitted = await prisma.response.findFirst({
      where: { studentId: student.id, question: { sessionId: session.id } },
    })

    res.json({ success: true, data: { session, alreadySubmitted: !!alreadySubmitted } })
  } catch (err) {
    next(err)
  }
})

export default router
