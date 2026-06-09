import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { prisma } from '../db/index.js'
import { AppError } from '../middleware/error.middleware.js'
import { requireStudent, StudentRequest } from '../middleware/auth.middleware.js'
import { getIo } from '../socket.js'

import { gradeSession } from '../utils/scoring.js'
import { upsertEnrollment } from '../utils/enrollment.js'
import { p } from '../utils/params.js'
import { toInchi } from '../utils/indigo.js'

const router = Router()

// ─── Question lookup by access code ──────────────────────────────────────────

// Student: look up a question by its 4-digit access code
router.get('/questions/by-code/:code', requireStudent, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const student = (req as StudentRequest).student

    const question = await prisma.question.findUnique({
      where: { accessCode: p(req.params.code) },
      include: {
        session: {
          select: {
            id: true,
            status: true,
            classId: true,
            runs: { where: { status: 'OPEN' }, select: { id: true, sectionId: true } },
          },
        },
        assignment: { select: { id: true, status: true } },
      },
    })
    if (!question) throw new AppError('Code not found — check and try again', 404)

    if (question.sessionId && question.session) {
      // Session question: need an OPEN run that includes this student's section
      const enrollment = await prisma.enrollment.findUnique({
        where: { studentId_classId: { studentId: student.id, classId: question.session.classId } },
        select: { sectionId: true },
      })
      const studentSectionId = enrollment?.sectionId ?? null
      const openRun = question.session.runs.find(
        (r) => r.sectionId === null || r.sectionId === studentSectionId
      )
      if (!openRun) throw new AppError('This session is not open', 409)
      return res.json({ success: true, data: { questionId: question.id } })
    }

    if (question.assignmentId && question.assignment) {
      if (question.assignment.status !== 'OPEN') throw new AppError('This assignment is not open', 409)
      return res.json({ success: true, data: { questionId: question.id } })
    }

    throw new AppError('Code not found — check and try again', 404)
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
            runs: { where: { status: 'OPEN' }, select: { id: true, sectionId: true } },
            class: { select: { name: true } },
          },
        },
        assignment: {
          select: {
            id: true,
            title: true,
            status: true,
            deadline: true,
            classId: true,
            class: { select: { name: true } },
          },
        },
      },
    })
    if (!question) throw new AppError('Question not found', 404)

    if (question.sessionId && question.session) {
      const sess = question.session
      if (sess.status === 'ARCHIVED' || sess.status === 'DRAFT') {
        throw new AppError('Question not found', 404)
      }

      // Get student's enrollment to check section
      const enrollment = await prisma.enrollment.findUnique({
        where: { studentId_classId: { studentId: student.id, classId: sess.classId } },
        select: { sectionId: true },
      })
      const studentSectionId = enrollment?.sectionId ?? null

      // Check there's an OPEN run for this student's section
      const openRun = sess.runs.find(
        (r) => r.sectionId === null || r.sectionId === studentSectionId
      )
      if (!openRun) throw new AppError('Question not found', 404)

      // Auto-enroll
      await upsertEnrollment(student.id, sess.classId, null)

      const alreadyAnswered = !!(await prisma.response.findUnique({
        where: { questionId_studentId: { questionId: question.id, studentId: student.id } },
      }))

      return res.json({
        success: true,
        data: {
          question: {
            id: question.id,
            sessionId: question.sessionId,
            assignmentId: null,
            text: question.text,
            type: question.type,
            options: question.options,
            order: question.order,
            accessCode: question.accessCode,
            session: {
              id: sess.id,
              title: sess.title,
              status: sess.status,
              class: { name: sess.class.name },
            },
            alreadyAnswered,
          },
        },
      })
    }

    if (question.assignmentId && question.assignment) {
      const asgn = question.assignment
      if (asgn.status === 'ARCHIVED') throw new AppError('Question not found', 404)
      if (asgn.status !== 'OPEN') throw new AppError('This assignment is not open', 409)

      // Check deadline (with per-student extension)
      if (asgn.deadline) {
        const extension = await prisma.deadlineExtension.findUnique({
          where: { assignmentId_studentId: { assignmentId: asgn.id, studentId: student.id } },
        })
        const effectiveDeadline = extension ? extension.deadline : asgn.deadline
        if (effectiveDeadline < new Date()) throw new AppError('This assignment is past due', 403)
      }

      // Auto-enroll
      await upsertEnrollment(student.id, asgn.classId, null)

      const alreadyAnswered = !!(await prisma.response.findUnique({
        where: { questionId_studentId: { questionId: question.id, studentId: student.id } },
      }))

      return res.json({
        success: true,
        data: {
          question: {
            id: question.id,
            sessionId: null,
            assignmentId: question.assignmentId,
            text: question.text,
            type: question.type,
            options: question.options,
            order: question.order,
            accessCode: question.accessCode,
            assignment: {
              id: asgn.id,
              title: asgn.title,
              status: asgn.status,
              deadline: asgn.deadline,
              class: { name: asgn.class.name },
            },
            alreadyAnswered,
          },
        },
      })
    }

    throw new AppError('Question not found', 404)
  } catch (err) {
    next(err)
  }
})

// ─── Response submission ──────────────────────────────────────────────────────

// Student: submit or auto-save a question response
router.post('/responses', requireStudent, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { questionId, responseText } = z.object({
      questionId: z.string().min(1),
      responseText: z.string().max(10_000),
    }).parse(req.body)

    const student = (req as StudentRequest).student

    const question = await prisma.question.findUnique({
      where: { id: questionId },
      include: {
        session: {
          select: {
            id: true,
            classId: true,
            runs: { where: { status: 'OPEN' }, select: { id: true, sectionId: true } },
          },
        },
        assignment: {
          select: {
            id: true,
            classId: true,
            status: true,
            deadline: true,
          },
        },
      },
    })
    if (!question) throw new AppError('Question not found', 404)

    const storedText = (question.type as string) === 'STRUCTURE'
      ? await toInchi(responseText)
      : responseText

    const wordCount = question.type === 'FREE_TEXT'
      ? responseText.trim().split(/\s+/).filter(Boolean).length
      : 0

    // ── Session question (IN_CLASS) ───────────────────────────────────────────
    if (question.sessionId && question.session) {
      const sess = question.session

      // Get student's section for run matching
      const enrollment = await prisma.enrollment.findUnique({
        where: { studentId_classId: { studentId: student.id, classId: sess.classId } },
        select: { sectionId: true },
      })
      const studentSectionId = enrollment?.sectionId ?? null

      const openRun = sess.runs.find(
        (r) => r.sectionId === null || r.sectionId === studentSectionId
      )
      if (!openRun) throw new AppError('Session is not open', 409)

      // IN_CLASS: reject if already answered (clicker answers are final)
      const existing = await prisma.response.findUnique({
        where: { questionId_studentId: { questionId, studentId: student.id } },
      })
      if (existing) throw new AppError('Already answered', 409)

      const response = await prisma.response.create({
        data: {
          questionId,
          studentId: student.id,
          runId: openRun.id,
          responseText: storedText,
          wordCount,
          isFlagged: question.type === 'FREE_TEXT' && wordCount < 10,
          isDraft: false,
        },
      })

      // Auto-enroll
      await upsertEnrollment(student.id, sess.classId, null)

      getIo().to(sess.id).emit('new_response', {
        student: { id: student.id, netId: student.netId },
        response,
        questionId,
        sessionId: sess.id,
      })

      return res.status(201).json({ success: true, data: { response } })
    }

    // ── Assignment question (HOMEWORK) ────────────────────────────────────────
    if (question.assignmentId && question.assignment) {
      const asgn = question.assignment
      if (asgn.status !== 'OPEN') throw new AppError('Assignment is not open', 409)

      // Deadline enforcement for homework
      if (asgn.deadline) {
        const extension = await prisma.deadlineExtension.findUnique({
          where: { assignmentId_studentId: { assignmentId: asgn.id, studentId: student.id } },
        })
        const effectiveDeadline = extension ? extension.deadline : asgn.deadline
        if (effectiveDeadline < new Date()) throw new AppError('This assignment is past due', 403)
      }

      const response = await prisma.response.upsert({
        where: { questionId_studentId: { questionId, studentId: student.id } },
        create: {
          questionId,
          studentId: student.id,
          runId: null,
          responseText: storedText,
          wordCount,
          isFlagged: question.type === 'FREE_TEXT' && wordCount < 10,
          isDraft: true,
        },
        update: {
          responseText: storedText,
          wordCount,
          isFlagged: question.type === 'FREE_TEXT' && wordCount < 10,
          submittedAt: new Date(),
        },
      })

      // Auto-enroll
      await upsertEnrollment(student.id, asgn.classId, null)

      return res.status(201).json({ success: true, data: { response } })
    }

    throw new AppError('Question not found', 404)
  } catch (err) {
    next(err)
  }
})

// Student: explicitly submit a homework assignment (locks all draft responses)
router.post('/student/assignments/:id/submit', requireStudent, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const student = (req as StudentRequest).student
    const assignmentId = p(req.params.id)

    const assignment = await prisma.assignment.findUnique({
      where: { id: assignmentId },
      select: { id: true, status: true, deadline: true, classId: true },
    })
    if (!assignment) throw new AppError('Assignment not found', 404)
    if (assignment.status !== 'OPEN') throw new AppError('Assignment is not open', 409)

    // Check deadline (with per-student extension)
    if (assignment.deadline) {
      const extension = await prisma.deadlineExtension.findUnique({
        where: { assignmentId_studentId: { assignmentId: assignment.id, studentId: student.id } },
      })
      const effectiveDeadline = extension ? extension.deadline : assignment.deadline
      if (effectiveDeadline < new Date()) throw new AppError('Assignment is past due', 403)
    }

    // Lock all draft responses for this student on this assignment
    const questionIds = (await prisma.question.findMany({
      where: { assignmentId },
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

// ─── Student grade routes ─────────────────────────────────────────────────────

// Student: grades for all sessions and assignments in a class
router.get('/student/classes/:classId/grades', requireStudent, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const student = (req as StudentRequest).student
    const classId = p(req.params.classId)

    const enrollment = await prisma.enrollment.findUnique({
      where: { studentId_classId: { studentId: student.id, classId } },
      select: { sectionId: true },
    })
    if (!enrollment) throw new AppError('Not enrolled in this class', 403)

    const studentSectionId = enrollment.sectionId

    // ── IN_CLASS sessions (with runs) ─────────────────────────────────────────
    const sessions = await prisma.session.findMany({
      where: { classId, status: { in: ['OPEN', 'CLOSED', 'ARCHIVED'] } },
      orderBy: { createdAt: 'desc' },
      include: {
        runs: {
          where: { status: { in: ['CLOSED', 'ARCHIVED'] } },
          select: { id: true, sectionId: true, closedAt: true },
        },
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

    const allSessionQuestionIds = sessions.flatMap((s) => s.questions.map((q) => q.id))
    const aiGradedSessionQIds = new Set(
      (await prisma.response.groupBy({
        by: ['questionId'],
        where: { questionId: { in: allSessionQuestionIds }, aiScore: { not: null } },
      })).map((r) => r.questionId)
    )

    const sessionResults = sessions.map((session) => {
      // Runs relevant to this student's section
      const relevantRunIds = session.runs
        .filter((r) => r.sectionId === null || r.sectionId === studentSectionId)
        .map((r) => r.id)

      // Build section response count map
      // We need to query this per-question — but for the grade list, use total count approach
      // with sectionResponseCount being the number of responses in relevant runs
      const qs = session.questions as Array<typeof session.questions[number] & { _count: { responses: number } }>
      const gradeResult = gradeSession('IN_CLASS', qs.map((q) => ({
        id: q.id,
        type: q.type,
        correctAnswer: q.correctAnswer,
        tolerance: q.tolerance,
        totalResponseCount: q._count.responses,
        sectionResponseCount: relevantRunIds.length > 0 ? undefined : 0, // will be refined below
        hasAnyAiScore: aiGradedSessionQIds.has(q.id),
        studentResponse: q.responses[0] ?? null,
      })))

      // Date: closedAt of the most recent relevant run
      const latestRun = session.runs
        .filter((r) => r.sectionId === null || r.sectionId === studentSectionId)
        .sort((a, b) => (b.closedAt?.getTime() ?? 0) - (a.closedAt?.getTime() ?? 0))[0]

      return {
        id: session.id,
        title: session.title,
        type: 'IN_CLASS' as const,
        date: latestRun?.closedAt?.toISOString() ?? null,
        earned: gradeResult.earned,
        max: gradeResult.max,
      }
    })

    // ── Assignments (HOMEWORK) ────────────────────────────────────────────────
    const assignments = await prisma.assignment.findMany({
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

    const allAssignmentQuestionIds = assignments.flatMap((a) => a.questions.map((q) => q.id))
    const aiGradedAssignmentQIds = new Set(
      (await prisma.response.groupBy({
        by: ['questionId'],
        where: { questionId: { in: allAssignmentQuestionIds }, aiScore: { not: null } },
      })).map((r) => r.questionId)
    )

    const assignmentResults = assignments.map((assignment) => {
      const qs = assignment.questions as Array<typeof assignment.questions[number] & { _count: { responses: number } }>
      const gradeResult = gradeSession('HOMEWORK', qs.map((q) => ({
        id: q.id,
        type: q.type,
        correctAnswer: q.correctAnswer,
        tolerance: q.tolerance,
        totalResponseCount: 1, // HOMEWORK: all questions count
        hasAnyAiScore: aiGradedAssignmentQIds.has(q.id),
        studentResponse: q.responses[0] ?? null,
      })))
      return {
        id: assignment.id,
        title: assignment.title,
        type: 'HOMEWORK' as const,
        date: assignment.deadline?.toISOString() ?? null,
        earned: gradeResult.earned,
        max: gradeResult.max,
      }
    })

    const result = [...sessionResults, ...assignmentResults]
    const totalEarned = Math.round(result.reduce((a, b) => a + b.earned, 0) * 10) / 10
    const totalMax = result.reduce((a, b) => a + b.max, 0)

    res.json({ success: true, data: { sessions: result, totalEarned, totalMax } })
  } catch (err) {
    next(err)
  }
})

// Student: question-level grades for a single closed session (IN_CLASS)
router.get('/student/sessions/:sessionId/grades', requireStudent, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const student = (req as StudentRequest).student

    const session = await prisma.session.findFirst({
      where: { id: p(req.params.sessionId), status: { in: ['OPEN', 'CLOSED', 'ARCHIVED'] } },
      include: {
        runs: {
          where: { status: { in: ['CLOSED', 'ARCHIVED'] } },
          select: { id: true, sectionId: true },
        },
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
      select: { sectionId: true },
    })
    if (!enrollment) throw new AppError('Not enrolled in this class', 403)

    const studentSectionId = enrollment.sectionId
    const relevantRunIds = session.runs
      .filter((r) => r.sectionId === null || r.sectionId === studentSectionId)
      .map((r) => r.id)

    // Build section-aware response counts
    let sectionResponseCounts: Map<string, number> = new Map()
    if (relevantRunIds.length > 0) {
      const counts = await prisma.response.groupBy({
        by: ['questionId'],
        where: { questionId: { in: session.questions.map((q) => q.id) }, runId: { in: relevantRunIds } },
        _count: { id: true },
      })
      for (const c of counts) {
        sectionResponseCounts.set(c.questionId, c._count.id)
      }
    }

    const aiGradedQuestionIds = new Set(
      (await prisma.response.groupBy({
        by: ['questionId'],
        where: { questionId: { in: session.questions.map((q) => q.id) }, aiScore: { not: null } },
      })).map((r) => r.questionId)
    )

    const qs = session.questions as Array<typeof session.questions[number] & { _count: { responses: number } }>
    const gradeResult = gradeSession('IN_CLASS', qs.map((q) => ({
      id: q.id,
      type: q.type,
      correctAnswer: q.correctAnswer,
      tolerance: q.tolerance,
      totalResponseCount: q._count.responses,
      sectionResponseCount: sectionResponseCounts.get(q.id) ?? 0,
      hasAnyAiScore: aiGradedQuestionIds.has(q.id),
      studentResponse: q.responses[0] ?? null,
    })))

    const questions = qs
      .filter((q) => (sectionResponseCounts.get(q.id) ?? 0) > 0)
      .map((q) => {
        const qResult = gradeResult.questions.find((r) => r.id === q.id)!
        return {
          id: q.id,
          text: q.text,
          type: q.type,
          options: q.options,
          order: q.order,
          correctAnswer: q.correctAnswer,
          response: q.responses[0]
            ? { responseText: q.responses[0].responseText, aiScore: q.responses[0].aiScore, submittedAt: q.responses[0].submittedAt }
            : null,
          score: qResult.score,
          counted: qResult.counted,
        }
      })

    res.json({
      success: true,
      data: {
        session: {
          id: session.id,
          title: session.title,
          type: 'IN_CLASS' as const,
          questions,
          earned: gradeResult.earned,
          max: gradeResult.max,
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

    const assignment = await prisma.assignment.findFirst({
      where: { id: p(req.params.id), status: { in: ['CLOSED', 'ARCHIVED'] } },
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

    const aiGradedQIds = new Set(
      (await prisma.response.groupBy({
        by: ['questionId'],
        where: { questionId: { in: assignment.questions.map((q) => q.id) }, aiScore: { not: null } },
      })).map((r) => r.questionId)
    )

    const gradeResult = gradeSession('HOMEWORK', assignment.questions.map((q) => ({
      id: q.id,
      type: q.type,
      correctAnswer: q.correctAnswer,
      tolerance: q.tolerance,
      totalResponseCount: 1,
      hasAnyAiScore: aiGradedQIds.has(q.id),
      studentResponse: q.responses[0] ?? null,
    })))

    const questions = assignment.questions.map((q) => {
      const qResult = gradeResult.questions.find((r) => r.id === q.id)!
      return {
        id: q.id,
        text: q.text,
        type: q.type,
        options: q.options,
        order: q.order,
        groupId: (q as typeof q & { groupId: string | null }).groupId,
        response: q.responses[0]
          ? { responseText: q.responses[0].responseText, aiScore: q.responses[0].aiScore, submittedAt: q.responses[0].submittedAt }
          : null,
        score: qResult.score,
      }
    })

    const groups = assignment.groups.map((g) => ({ id: g.id, title: g.title, text: g.text, order: g.order }))

    res.json({
      success: true,
      data: {
        assignment: {
          id: assignment.id,
          title: assignment.title,
          class: assignment.class,
          groups,
          questions,
          earned: gradeResult.earned,
          max: gradeResult.max,
        },
      },
    })
  } catch (err) {
    next(err)
  }
})

// ─── Student class/assignment views ──────────────────────────────────────────

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

// Student: list enrolled classes (include only sessions with OPEN runs)
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
              where: { status: { in: ['OPEN', 'CLOSED'] } },
              orderBy: { createdAt: 'desc' },
              select: {
                id: true,
                title: true,
                status: true,
                runs: {
                  where: { status: 'OPEN' },
                  select: { id: true, sectionId: true, openedAt: true },
                },
              },
            },
          },
        },
      },
      orderBy: { enrolledAt: 'desc' },
    })

    // Filter sessions to only those with OPEN runs
    const result = enrollments.map((e) => ({
      ...e,
      class: {
        ...e.class,
        sessions: e.class.sessions.filter((s) => s.runs.length > 0),
      },
    }))

    res.json({ success: true, data: { enrollments: result } })
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

    const assignments = await prisma.assignment.findMany({
      where: {
        classId: { in: classIds },
        status: 'OPEN',
        deadline: { gte: new Date() },
      },
      orderBy: { deadline: 'asc' },
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

    const result = assignments.map((a) => ({
      id: a.id,
      title: a.title,
      classId: a.classId,
      className: a.class.name,
      deadline: a.deadline,
      questionCount: a.questions.length,
      submittedCount: a.questions.filter((q) => q.responses.length > 0).length,
    }))

    res.json({ success: true, data: { assignments: result } })
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

// Student: list homework assignments for an enrolled class
router.get('/student/classes/:classId/assignments', requireStudent, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const student = (req as StudentRequest).student
    const classId = p(req.params.classId)

    const enrollment = await prisma.enrollment.findUnique({
      where: { studentId_classId: { studentId: student.id, classId } },
    })
    if (!enrollment) throw new AppError('Not enrolled in this class', 403)

    const assignments = await prisma.assignment.findMany({
      where: { classId, status: { in: ['OPEN', 'CLOSED', 'ARCHIVED'] } },
      orderBy: { deadline: 'asc' },
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

    const allAssignmentQuestionIds = assignments.flatMap((a) => a.questions.map((q) => q.id))
    const aiGradedQIds = new Set(
      (await prisma.response.groupBy({
        by: ['questionId'],
        where: { questionId: { in: allAssignmentQuestionIds }, aiScore: { not: null } },
      })).map((r) => r.questionId)
    )

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
        const gradeResult = gradeSession('HOMEWORK', qs.map((q) => ({
          id: q.id,
          type: q.type,
          correctAnswer: q.correctAnswer,
          tolerance: q.tolerance,
          totalResponseCount: 1,
          hasAnyAiScore: aiGradedQIds.has(q.id),
          studentResponse: q.responses[0] ?? null,
        })))
        earnedScore = gradeResult.earned
        maxScore = gradeResult.max
      }
      return {
        id: a.id,
        title: a.title,
        status: a.status,
        deadline: a.deadline,
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

    const assignment = await prisma.assignment.findFirst({
      where: { id: p(req.params.id), status: { in: ['OPEN', 'CLOSED', 'ARCHIVED'] } },
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

    const extension = assignment.deadline
      ? await prisma.deadlineExtension.findUnique({
          where: { assignmentId_studentId: { assignmentId: assignment.id, studentId: student.id } },
        })
      : null
    const deadline = extension ? extension.deadline : assignment.deadline
    const isPastDue = deadline !== null && deadline < new Date()

    const groups = assignment.groups.map((g) => ({ id: g.id, title: g.title, text: g.text, order: g.order }))

    const questions = assignment.questions.map((q) => ({
      id: q.id,
      text: q.text,
      type: q.type,
      options: q.options,
      order: q.order,
      groupId: (q as typeof q & { groupId: string | null }).groupId,
      unit: (q as typeof q & { unit: string | null }).unit,
      correctAnswer: (q as typeof q & { correctAnswer: string | null }).correctAnswer,
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

export default router
