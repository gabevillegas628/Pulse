import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { prisma } from '../db/index.js'
import { AppError } from '../middleware/error.middleware.js'
import { requireStudent, StudentRequest } from '../middleware/auth.middleware.js'
import { getIo } from '../socket.js'

const router = Router()
const p = (v: string | string[]): string => (Array.isArray(v) ? v[0] : v)

// Student: look up a question by its 4-digit access code
router.get('/questions/by-code/:code', requireStudent, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const question = await prisma.question.findUnique({
      where: { accessCode: p(req.params.code) },
      include: { session: { select: { id: true, status: true } } },
    })
    if (!question) throw new AppError('Code not found — check and try again', 404)
    if (question.session.status !== 'OPEN') throw new AppError('This session is not open', 409)
    res.json({ success: true, data: { questionId: question.id } })
  } catch (err) {
    next(err)
  }
})

// Student: get full question detail for the answer page
router.get('/student/questions/:id', requireStudent, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const student = (req as StudentRequest).student

    const question = await prisma.question.findUnique({
      where: { id: p(req.params.id) },
      include: {
        session: {
          select: {
            id: true,
            title: true,
            status: true,
            classId: true,
            class: { select: { name: true } },
          },
        },
      },
    })
    if (!question) throw new AppError('Question not found', 404)
    if (question.session.status === 'ARCHIVED' || question.session.status === 'DRAFT') {
      throw new AppError('Question not found', 404)
    }

    // Auto-enroll student in the class if not already enrolled
    await prisma.enrollment.upsert({
      where: { studentId_classId: { studentId: student.id, classId: question.session.classId } },
      create: { studentId: student.id, classId: question.session.classId },
      update: {},
    })

    const alreadyAnswered = !!(await prisma.response.findUnique({
      where: { questionId_studentId: { questionId: question.id, studentId: student.id } },
    }))

    res.json({
      success: true,
      data: {
        question: {
          id: question.id,
          sessionId: question.sessionId,
          text: question.text,
          type: question.type,
          options: question.options,
          order: question.order,
          accessCode: question.accessCode,
          session: {
            id: question.session.id,
            title: question.session.title,
            status: question.session.status,
            class: { name: question.session.class.name },
          },
          alreadyAnswered,
        },
      },
    })
  } catch (err) {
    next(err)
  }
})

// Student: submit a single question response
router.post('/responses', requireStudent, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { questionId, responseText } = z.object({
      questionId: z.string().min(1),
      responseText: z.string(),
    }).parse(req.body)

    const student = (req as StudentRequest).student

    const question = await prisma.question.findUnique({
      where: { id: questionId },
      include: { session: true },
    })
    if (!question) throw new AppError('Question not found', 404)
    if (question.session.status !== 'OPEN') throw new AppError('Session is not open', 409)

    const wordCount = question.type === 'FREE_TEXT'
      ? responseText.trim().split(/\s+/).filter(Boolean).length
      : 0

    const response = await prisma.response.create({
      data: {
        questionId,
        studentId: student.id,
        responseText,
        wordCount,
        isFlagged: question.type === 'FREE_TEXT' && wordCount < 10,
      },
    })

    // Auto-enroll in the class if not already enrolled
    await prisma.enrollment.upsert({
      where: { studentId_classId: { studentId: student.id, classId: question.session.classId } },
      create: { studentId: student.id, classId: question.session.classId },
      update: {},
    })

    getIo().to(question.session.id).emit('new_response', {
      student: { id: student.id, netId: student.netId, name: student.name },
      response,
      questionId,
      sessionId: question.session.id,
    })

    res.status(201).json({ success: true, data: { response } })
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

// Student: grades for all closed sessions in a class
router.get('/student/classes/:classId/grades', requireStudent, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const student = (req as StudentRequest).student
    const classId = p(req.params.classId)

    const enrollment = await prisma.enrollment.findUnique({
      where: { studentId_classId: { studentId: student.id, classId } },
    })
    if (!enrollment) throw new AppError('Not enrolled in this class', 403)

    const sessions = await prisma.session.findMany({
      where: { classId, status: { in: ['CLOSED', 'ARCHIVED'] } },
      orderBy: { closedAt: 'desc' },
      include: {
        questions: {
          orderBy: { order: 'asc' },
          include: {
            responses: {
              where: { studentId: student.id },
              select: { responseText: true, aiScore: true },
            },
          },
        },
      },
    })

    const result = sessions.map((session) => {
      let earned = 0
      const max = session.questions.length
      for (const q of session.questions) {
        const resp = q.responses[0] ?? null
        earned += calcScore(q.type, q.correctAnswer, resp)
      }
      return {
        id: session.id,
        title: session.title,
        closedAt: session.closedAt,
        earned: Math.round(earned * 10) / 10,
        max,
      }
    })

    const totalEarned = Math.round(result.reduce((a, b) => a + b.earned, 0) * 10) / 10
    const totalMax = result.reduce((a, b) => a + b.max, 0)

    res.json({ success: true, data: { sessions: result, totalEarned, totalMax } })
  } catch (err) {
    next(err)
  }
})

// Student: list enrolled classes
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
              select: { id: true, title: true, status: true },
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

export default router
