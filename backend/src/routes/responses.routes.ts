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
            targetSectionId: true,
            class: { select: { name: true } },
          },
        },
      },
    })
    if (!question) throw new AppError('Question not found', 404)
    if (question.session.status === 'ARCHIVED' || question.session.status === 'DRAFT') {
      throw new AppError('Question not found', 404)
    }

    // Auto-enroll; set sectionId from session target if student has no section yet
    const classId = question.session.classId
    const sectionId = question.session.targetSectionId
    const existingEnrollment = await prisma.enrollment.findUnique({
      where: { studentId_classId: { studentId: student.id, classId } },
    })
    await prisma.enrollment.upsert({
      where: { studentId_classId: { studentId: student.id, classId } },
      create: { studentId: student.id, classId, sectionId },
      update: sectionId && !existingEnrollment?.sectionId ? { sectionId } : {},
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

    // Deadline enforcement for homework assignments (check per-student extension first)
    const sess = question.session as typeof question.session & { type: string; deadline: Date | null }
    if (sess.type === 'HOMEWORK' && sess.deadline) {
      const extension = await prisma.deadlineExtension.findUnique({
        where: { sessionId_studentId: { sessionId: sess.id, studentId: student.id } },
      })
      const effectiveDeadline = extension ? extension.deadline : sess.deadline
      if (effectiveDeadline < new Date()) {
        throw new AppError('This assignment is past due', 403)
      }
    }

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

    // Auto-enroll; set sectionId from session target if student has no section yet
    const classId = question.session.classId
    const sectionId = question.session.targetSectionId
    const existingEnrollment = await prisma.enrollment.findUnique({
      where: { studentId_classId: { studentId: student.id, classId } },
    })
    await prisma.enrollment.upsert({
      where: { studentId_classId: { studentId: student.id, classId } },
      create: { studentId: student.id, classId, sectionId },
      update: sectionId && !existingEnrollment?.sectionId ? { sectionId } : {},
    })

    getIo().to(question.session.id).emit('new_response', {
      student: { id: student.id, netId: student.netId },
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
  response: { responseText: string; aiScore: number | null } | null,
  tolerance?: number | null
): number {
  if (!response) return 0
  if (qType === 'MULTIPLE_CHOICE' || qType === 'YES_NO') {
    if (!correctAnswer) return 1.0
    return response.responseText === correctAnswer ? 1.0 : 0.5
  }
  if (qType === 'FREE_TEXT') {
    return response.aiScore !== null && response.aiScore !== undefined ? response.aiScore : 1.0
  }
  if (qType === 'NUMERIC') {
    if (!correctAnswer) return 1.0
    const correct = parseFloat(correctAnswer)
    const student = parseFloat(response.responseText)
    if (isNaN(student)) return 0
    const tol = tolerance ?? 0
    return Math.abs(student - correct) <= tol ? 1.0 : 0.0
  }
  if (qType === 'MULTI_SELECT') {
    if (!correctAnswer) return 1.0
    let studentArr: string[] = []
    try { studentArr = JSON.parse(response.responseText) } catch { return 0 }
    if (!Array.isArray(studentArr) || studentArr.length === 0) return 0
    const correctArr: string[] = JSON.parse(correctAnswer)
    const sSet = new Set(studentArr)
    const cSet = new Set(correctArr)
    return sSet.size === cSet.size && [...cSet].every(v => sSet.has(v)) ? 1.0 : 0.5
  }
  if (qType === 'ORDERING') {
    if (!correctAnswer) return 1.0
    let studentArr: string[] = []
    try { studentArr = JSON.parse(response.responseText) } catch { return 0 }
    if (!Array.isArray(studentArr) || studentArr.length === 0) return 0
    const correctArr: string[] = JSON.parse(correctAnswer)
    return correctArr.length === studentArr.length && correctArr.every((v, i) => v === studentArr[i]) ? 1.0 : 0.5
  }
  if (qType === 'STRUCTURE') {
    if (response.aiScore !== null && response.aiScore !== undefined) return response.aiScore
    if (!correctAnswer) return 1.0
    if (!response.responseText) return 0
    return response.responseText === correctAnswer ? 1.0 : 0.5
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
      where: { classId, status: { in: ['CLOSED', 'ARCHIVED'] }, type: 'IN_CLASS' } as object,
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
        earned += calcScore(q.type, q.correctAnswer, resp, q.tolerance)
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
        section: { select: { id: true, name: true } },
        class: {
          include: {
            professor: { select: { name: true } },
            sessions: {
              where: { status: 'OPEN', type: 'IN_CLASS' } as object,
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

// Student: enroll in a class (or section) by joinCode
router.post('/student/enroll', requireStudent, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { joinCode } = z.object({ joinCode: z.string().min(1) }).parse(req.body)
    const student = (req as StudentRequest).student

    // Try class join code first, then section join code
    const cls = await prisma.class.findUnique({ where: { joinCode } })
    if (cls) {
      const enrollment = await prisma.enrollment.upsert({
        where: { studentId_classId: { studentId: student.id, classId: cls.id } },
        create: { studentId: student.id, classId: cls.id },
        update: {},
        include: { class: { include: { professor: { select: { name: true } } } } },
      })
      return res.json({ success: true, data: { enrollment } })
    }

    const section = await prisma.section.findUnique({
      where: { joinCode },
      include: { class: { include: { professor: { select: { name: true } } } } },
    })
    if (!section) throw new AppError('Join code not found — check and try again', 404)

    const enrollment = await prisma.enrollment.upsert({
      where: { studentId_classId: { studentId: student.id, classId: section.classId } },
      create: { studentId: student.id, classId: section.classId, sectionId: section.id },
      update: { sectionId: section.id },
      include: { class: { include: { professor: { select: { name: true } } } } },
    })
    res.json({ success: true, data: { enrollment } })
  } catch (err) {
    next(err)
  }
})

// Student: list homework assignments for an enrolled class (open + closed/archived)
router.get('/student/classes/:classId/assignments', requireStudent, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const student = (req as StudentRequest).student
    const classId = p(req.params.classId)

    const enrollment = await prisma.enrollment.findUnique({
      where: { studentId_classId: { studentId: student.id, classId } },
    })
    if (!enrollment) throw new AppError('Not enrolled in this class', 403)

    const assignments = await prisma.session.findMany({
      where: { classId, status: { in: ['OPEN', 'CLOSED', 'ARCHIVED'] }, type: 'HOMEWORK' } as object,
      orderBy: { deadline: 'asc' } as object,
      include: {
        questions: {
          select: { id: true, type: true, correctAnswer: true, tolerance: true },
          include: {
            responses: {
              where: { studentId: student.id },
              select: { id: true, responseText: true, aiScore: true },
            },
          },
        },
      },
    })

    type AssignmentRow = {
      id: string
      title: string
      status: string
      deadline: Date | null
      questionCount: number
      submittedCount: number
      earnedScore: number | null
      maxScore: number | null
    }

    const result: AssignmentRow[] = assignments.map((a) => {
      const qs = a.questions as Array<{ id: string; type: string; correctAnswer: string | null; tolerance: number | null; responses: Array<{ id: string; responseText: string; aiScore: number | null }> }>
      const isClosed = a.status === 'CLOSED' || a.status === 'ARCHIVED'
      const submittedCount = qs.filter((q) => q.responses.length > 0).length
      let earnedScore: number | null = null
      let maxScore: number | null = null
      if (isClosed && qs.length > 0) {
        earnedScore = qs.reduce((sum, q) => sum + calcScore(q.type, q.correctAnswer, q.responses[0] ?? null, q.tolerance), 0)
        maxScore = qs.length
      }
      return {
        id: a.id,
        title: a.title,
        status: a.status,
        deadline: (a as typeof a & { deadline: Date | null }).deadline,
        questionCount: qs.length,
        submittedCount,
        earnedScore,
        maxScore,
      }
    })

    res.json({ success: true, data: { assignments: result } })
  } catch (err) {
    next(err)
  }
})

// Student: get a homework assignment with all questions
router.get('/student/assignments/:id', requireStudent, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const student = (req as StudentRequest).student

    const assignment = await prisma.session.findFirst({
      where: { id: p(req.params.id), status: { in: ['OPEN', 'CLOSED', 'ARCHIVED'] }, type: 'HOMEWORK' } as object,
      include: {
        class: { select: { id: true, name: true } },
        groups: { orderBy: [{ order: 'asc' }, { createdAt: 'asc' }] },
        questions: {
          orderBy: { order: 'asc' },
          include: {
            responses: {
              where: { studentId: student.id },
              select: { id: true, responseText: true, submittedAt: true },
            },
          },
        },
      },
    })
    if (!assignment) throw new AppError('Assignment not found', 404)

    const enrollment = await prisma.enrollment.findUnique({
      where: { studentId_classId: { studentId: student.id, classId: assignment.classId } },
    })
    if (!enrollment) throw new AppError('Not enrolled in this class', 403)

    const sessionDeadline = (assignment as typeof assignment & { deadline: Date | null }).deadline
    const extension = sessionDeadline
      ? await prisma.deadlineExtension.findUnique({
          where: { sessionId_studentId: { sessionId: assignment.id, studentId: student.id } },
        })
      : null
    const deadline = extension ? extension.deadline : sessionDeadline
    const isPastDue = deadline !== null && deadline < new Date()

    const groups = (assignment as typeof assignment & { groups: { id: string; title: string; text: string | null; order: number }[] }).groups
      .map((g) => ({ id: g.id, title: g.title, text: g.text, order: g.order }))

    const questions = assignment.questions.map((q) => ({
      id: q.id,
      text: q.text,
      type: q.type,
      options: q.options,
      order: q.order,
      groupId: (q as typeof q & { groupId: string | null }).groupId,
      unit: (q as typeof q & { unit: string | null }).unit,
      existingResponse: q.responses[0] ?? null,
    }))

    res.json({
      success: true,
      data: {
        assignment: {
          id: assignment.id,
          title: assignment.title,
          status: assignment.status,
          deadline,
          isPastDue,
          class: assignment.class,
          groups,
          questions,
        },
      },
    })
  } catch (err) {
    next(err)
  }
})

// Student: grades for a specific homework assignment (after it closes)
router.get('/student/assignments/:id/grades', requireStudent, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const student = (req as StudentRequest).student

    const assignment = await prisma.session.findFirst({
      where: { id: p(req.params.id), type: 'HOMEWORK', status: { in: ['CLOSED', 'ARCHIVED'] } } as object,
      include: {
        class: { select: { id: true, name: true } },
        groups: { orderBy: [{ order: 'asc' }, { createdAt: 'asc' }] },
        questions: {
          orderBy: { order: 'asc' },
          include: {
            responses: {
              where: { studentId: student.id },
              select: { id: true, responseText: true, aiScore: true, submittedAt: true },
            },
          },
        },
      },
    })
    if (!assignment) throw new AppError('Assignment not found or not yet closed', 404)

    const enrollment = await prisma.enrollment.findUnique({
      where: { studentId_classId: { studentId: student.id, classId: assignment.classId } },
    })
    if (!enrollment) throw new AppError('Not enrolled in this class', 403)

    let earned = 0
    const questions = assignment.questions.map((q) => {
      const resp = q.responses[0] ?? null
      const score = calcScore(q.type, q.correctAnswer, resp, q.tolerance)
      earned += score
      return {
        id: q.id,
        text: q.text,
        type: q.type,
        options: q.options,
        order: q.order,
        groupId: (q as typeof q & { groupId: string | null }).groupId,
        response: resp ? { responseText: resp.responseText, aiScore: resp.aiScore, submittedAt: resp.submittedAt } : null,
        score,
      }
    })

    const groups = (assignment as typeof assignment & { groups: { id: string; title: string; text: string | null; order: number }[] }).groups
      .map((g) => ({ id: g.id, title: g.title, text: g.text, order: g.order }))

    res.json({
      success: true,
      data: {
        assignment: {
          id: assignment.id,
          title: assignment.title,
          class: assignment.class,
          groups,
          questions,
          earned: Math.round(earned * 10) / 10,
          max: assignment.questions.length,
        },
      },
    })
  } catch (err) {
    next(err)
  }
})

export default router
