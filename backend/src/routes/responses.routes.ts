import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { prisma } from '../db/index.js'
import { AppError } from '../middleware/error.middleware.js'
import { requireStudent, StudentRequest } from '../middleware/auth.middleware.js'
import { getIo } from '../socket.js'

import { calcScore, calcSessionMax } from '../utils/scoring.js'
import { upsertEnrollment } from '../utils/enrollment.js'
import { p } from '../utils/params.js'
import { toInchi } from '../utils/indigo.js'

const router = Router()

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
    await upsertEnrollment(student.id, question.session.classId, question.session.targetSectionId)

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

// Student: submit or auto-save a question response
// - IN_CLASS sessions: create only (locked after first submission)
// - HOMEWORK sessions: upsert (auto-save until deadline or explicit submit)
router.post('/responses', requireStudent, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { questionId, responseText } = z.object({
      questionId: z.string().min(1),
      responseText: z.string().max(10_000),
    }).parse(req.body)

    const student = (req as StudentRequest).student

    const question = await prisma.question.findUnique({
      where: { id: questionId },
      include: { session: true },
    })
    if (!question) throw new AppError('Question not found', 404)
    if (question.session.status !== 'OPEN') throw new AppError('Session is not open', 409)

    const sess = question.session as typeof question.session & { type: string; deadline: Date | null }

    // Deadline enforcement for homework
    if (sess.type === 'HOMEWORK' && sess.deadline) {
      const extension = await prisma.deadlineExtension.findUnique({
        where: { sessionId_studentId: { sessionId: sess.id, studentId: student.id } },
      })
      const effectiveDeadline = extension ? extension.deadline : sess.deadline
      if (effectiveDeadline < new Date()) {
        throw new AppError('This assignment is past due', 403)
      }
    }

    // IN_CLASS: reject if already answered (clicker answers are final)
    if (sess.type === 'IN_CLASS') {
      const existing = await prisma.response.findUnique({
        where: { questionId_studentId: { questionId, studentId: student.id } },
      })
      if (existing) throw new AppError('Already answered', 409)
    }

    const storedText = (question.type as string) === 'STRUCTURE'
      ? await toInchi(responseText)
      : responseText

    const wordCount = question.type === 'FREE_TEXT'
      ? responseText.trim().split(/\s+/).filter(Boolean).length
      : 0

    const response = await prisma.response.upsert({
      where: { questionId_studentId: { questionId, studentId: student.id } },
      create: {
        questionId,
        studentId: student.id,
        responseText: storedText,
        wordCount,
        isFlagged: question.type === 'FREE_TEXT' && wordCount < 10,
        isDraft: sess.type === 'HOMEWORK',
      },
      update: {
        responseText: storedText,
        wordCount,
        isFlagged: question.type === 'FREE_TEXT' && wordCount < 10,
        submittedAt: new Date(),
      },
    })

    // Auto-enroll
    await upsertEnrollment(student.id, question.session.classId, question.session.targetSectionId)

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

// Student: explicitly submit a homework assignment (locks all draft responses)
router.post('/student/assignments/:id/submit', requireStudent, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const student = (req as StudentRequest).student
    const assignmentId = p(req.params.id)

    const session = await prisma.session.findUnique({
      where: { id: assignmentId },
      select: { id: true, type: true, status: true, deadline: true, classId: true },
    })
    if (!session) throw new AppError('Assignment not found', 404)
    if ((session as typeof session & { type: string }).type !== 'HOMEWORK') throw new AppError('Not a homework assignment', 400)
    if (session.status !== 'OPEN') throw new AppError('Assignment is not open', 409)

    // Check deadline (with per-student extension)
    const sess = session as typeof session & { deadline: Date | null }
    if (sess.deadline) {
      const extension = await prisma.deadlineExtension.findUnique({
        where: { sessionId_studentId: { sessionId: session.id, studentId: student.id } },
      })
      const effectiveDeadline = extension ? extension.deadline : sess.deadline
      if (effectiveDeadline < new Date()) throw new AppError('Assignment is past due', 403)
    }

    // Lock all draft responses for this student on this assignment
    const questionIds = (await prisma.question.findMany({
      where: { sessionId: assignmentId },
      select: { id: true },
    })).map((q) => q.id)

    const result = await prisma.response.updateMany({
      where: {
        studentId: student.id,
        questionId: { in: questionIds },
        isDraft: true,
      },
      data: { isDraft: false, submittedAt: new Date() },
    })

    res.json({ success: true, data: { submitted: result.count } })
  } catch (err) {
    next(err)
  }
})


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
      orderBy: { createdAt: 'desc' },
      include: {
        questions: {
          orderBy: { order: 'asc' },
          include: {
            responses: {
              where: { studentId: student.id },
              select: { responseText: true, aiScore: true },
            },
            _count: { select: { responses: true } },
          },
        },
      },
    })

    const result = sessions.map((session) => {
      let earned = 0
      const qs = session.questions as Array<typeof session.questions[number] & { _count: { responses: number } }>
      const max = calcSessionMax(session.type as string, qs.map((q) => q._count.responses))
      for (const q of session.questions) {
        const resp = q.responses[0] ?? null
        earned += calcScore(q.type, q.correctAnswer, resp, q.tolerance)
      }
      return {
        id: session.id,
        title: session.title,
        type: session.type as 'IN_CLASS' | 'HOMEWORK',
        date: session.type === 'IN_CLASS'
          ? session.closedAt?.toISOString() ?? null
          : (session as unknown as { deadline: Date | null }).deadline?.toISOString() ?? null,
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

// Student: question-level grades for a single closed session (IN_CLASS or HOMEWORK)
router.get('/student/sessions/:sessionId/grades', requireStudent, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const student = (req as StudentRequest).student

    const session = await prisma.session.findFirst({
      where: { id: p(req.params.sessionId), status: { in: ['CLOSED', 'ARCHIVED'] } },
      include: {
        questions: {
          orderBy: { order: 'asc' },
          include: {
            responses: {
              where: { studentId: student.id },
              select: { responseText: true, aiScore: true, submittedAt: true },
            },
            _count: { select: { responses: true } },
          },
        },
      },
    })
    if (!session) throw new AppError('Session not found or not yet closed', 404)

    const enrollment = await prisma.enrollment.findUnique({
      where: { studentId_classId: { studentId: student.id, classId: session.classId } },
    })
    if (!enrollment) throw new AppError('Not enrolled in this class', 403)

    let earned = 0
    const qs = session.questions as Array<typeof session.questions[number] & { _count: { responses: number } }>
    const max = calcSessionMax(session.type as string, qs.map((q) => q._count.responses))

    const presentedQs = session.type === 'IN_CLASS'
      ? qs.filter((q) => q._count.responses > 0)
      : qs

    const questions = presentedQs.map((q) => {
      const resp = q.responses[0] ?? null
      const score = calcScore(q.type, q.correctAnswer, resp, q.tolerance)
      earned += score
      return {
        id: q.id,
        text: q.text,
        type: q.type,
        options: q.options,
        order: q.order,
        correctAnswer: q.correctAnswer,
        response: resp ? { responseText: resp.responseText, aiScore: resp.aiScore, submittedAt: resp.submittedAt } : null,
        score,
      }
    })

    res.json({
      success: true,
      data: {
        session: {
          id: session.id,
          title: session.title,
          type: session.type as 'IN_CLASS' | 'HOMEWORK',
          questions,
          earned: Math.round(earned * 10) / 10,
          max,
        },
      },
    })
  } catch (err) {
    next(err)
  }
})

// Student: get textbook config for a single enrolled class
router.get('/student/classes/:classId/textbook', requireStudent, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const student = (req as StudentRequest).student
    const classId = p(req.params.classId)
    const enrollment = await prisma.enrollment.findUnique({
      where: { studentId_classId: { studentId: student.id, classId } },
      include: {
        class: {
          select: { id: true, name: true, textbookRepo: true, textbookPath: true, textbookBranch: true },
        },
      },
    })
    if (!enrollment) throw new AppError('Not enrolled in this class', 403)
    res.json({ success: true, data: { class: enrollment.class } })
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

// Student: upcoming open assignments (with deadlines) across all enrolled classes
router.get('/student/upcoming-assignments', requireStudent, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const student = (req as StudentRequest).student

    const enrollments = await prisma.enrollment.findMany({
      where: { studentId: student.id },
      select: { classId: true },
    })
    const classIds = enrollments.map((e) => e.classId)

    if (classIds.length === 0) {
      return res.json({ success: true, data: { assignments: [] } })
    }

    const sessions = await prisma.session.findMany({
      where: {
        classId: { in: classIds },
        type: 'HOMEWORK',
        status: 'OPEN',
        deadline: { gte: new Date() },
      } as object,
      orderBy: { deadline: 'asc' } as object,
      take: 5,
      include: {
        class: { select: { id: true, name: true } },
        questions: {
          include: {
            responses: {
              where: { studentId: student.id },
              select: { id: true },
            },
          },
        },
      },
    })

    const assignments = sessions.map((s) => ({
      id: s.id,
      title: s.title,
      classId: s.classId,
      className: s.class.name,
      deadline: s.deadline,
      questionCount: s.questions.length,
      submittedCount: s.questions.filter((q) => q.responses.length > 0).length,
    }))

    res.json({ success: true, data: { assignments } })
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
          max: calcSessionMax('HOMEWORK', new Array(assignment.questions.length).fill(1)),
        },
      },
    })
  } catch (err) {
    next(err)
  }
})

export default router
