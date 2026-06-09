import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../db/index.js'
import { AppError } from '../middleware/error.middleware.js'
import { requireProfessor, ProfessorRequest } from '../middleware/auth.middleware.js'
import { gradeSession } from '../utils/scoring.js'
import { p } from '../utils/params.js'

const router = Router()

// ─── Assignment CRUD ──────────────────────────────────────────────────────────

// Create an Assignment
router.post('/classes/:classId/assignments', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const body = z.object({
      title: z.string().min(1),
      deadline: z.string().datetime().optional(),
    }).parse(req.body)

    const cls = await prisma.class.findFirst({
      where: { id: p(req.params.classId), professorId: professor.id },
    })
    if (!cls) throw new AppError('Class not found', 404)

    const assignment = await prisma.assignment.create({
      data: {
        classId: cls.id,
        title: body.title,
        status: 'DRAFT',
        deadline: body.deadline ? new Date(body.deadline) : null,
      },
      include: { questions: { orderBy: { order: 'asc' } } },
    })

    res.status(201).json({ success: true, data: { assignment } })
  } catch (err) {
    next(err)
  }
})

// List Assignments for a class
router.get('/classes/:classId/assignments', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const cls = await prisma.class.findFirst({
      where: { id: p(req.params.classId), professorId: professor.id },
      include: { _count: { select: { enrollments: true } } },
    })
    if (!cls) throw new AppError('Class not found', 404)

    const assignments = await prisma.assignment.findMany({
      where: { classId: cls.id },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { questions: true } },
      },
    })

    // Distinct respondent count per assignment
    const assignmentIds = assignments.map((a) => a.id)
    let respondentMap: Record<string, number> = {}
    if (assignmentIds.length > 0) {
      const rows = await prisma.$queryRaw<Array<{ assignmentId: string; respondentCount: bigint }>>(
        Prisma.sql`
          SELECT a.id AS "assignmentId", COUNT(DISTINCT r."studentId") AS "respondentCount"
          FROM "Assignment" a
          LEFT JOIN "Question" q ON q."assignmentId" = a.id
          LEFT JOIN "Response" r ON r."questionId" = q.id
          WHERE a.id IN (${Prisma.join(assignmentIds)})
          GROUP BY a.id
        `
      )
      for (const row of rows) {
        respondentMap[row.assignmentId] = Number(row.respondentCount)
      }
    }

    const result = assignments.map((a) => ({
      ...a,
      respondentCount: respondentMap[a.id] ?? 0,
    }))

    res.json({ success: true, data: { assignments: result, enrolledCount: cls._count.enrollments } })
  } catch (err) {
    next(err)
  }
})

// Get a single assignment with questions and groups
router.get('/assignments/:id', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const assignment = await prisma.assignment.findFirst({
      where: { id: p(req.params.id), class: { professorId: professor.id } },
      include: {
        class: { select: { id: true, name: true, _count: { select: { enrollments: true } } } },
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
    if (!assignment) throw new AppError('Assignment not found', 404)

    const enrolledCount = (assignment.class as typeof assignment.class & { _count: { enrollments: number } })._count.enrollments
    res.json({ success: true, data: { assignment: { ...assignment, enrolledCount } } })
  } catch (err) {
    next(err)
  }
})

// Update an assignment
router.patch('/assignments/:id', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const body = z.object({
      title: z.string().min(1).optional(),
      deadline: z.string().datetime().nullable().optional(),
      status: z.enum(['DRAFT', 'OPEN', 'CLOSED', 'ARCHIVED']).optional(),
    }).parse(req.body)

    const existing = await prisma.assignment.findFirst({
      where: { id: p(req.params.id), class: { professorId: professor.id } },
    })
    if (!existing) throw new AppError('Assignment not found', 404)

    const updated = await prisma.assignment.update({
      where: { id: p(req.params.id) },
      data: {
        ...(body.title !== undefined && { title: body.title }),
        ...(body.deadline !== undefined && { deadline: body.deadline ? new Date(body.deadline) : null }),
        ...(body.status !== undefined && { status: body.status }),
      },
    })

    res.json({ success: true, data: { assignment: updated } })
  } catch (err) {
    next(err)
  }
})

// Delete an assignment
router.delete('/assignments/:id', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const existing = await prisma.assignment.findFirst({
      where: { id: p(req.params.id), class: { professorId: professor.id } },
    })
    if (!existing) throw new AppError('Assignment not found', 404)
    await prisma.assignment.delete({ where: { id: p(req.params.id) } })
    res.json({ success: true, data: null })
  } catch (err) {
    next(err)
  }
})

// CSV grade export for assignment
router.get('/assignments/:id/export', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const assignment = await prisma.assignment.findFirst({
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
    if (!assignment) throw new AppError('Assignment not found', 404)

    const students = assignment.class.enrollments.map((e) => e.student)

    const rows = students.map((s) => {
      const gradeResult = gradeSession('HOMEWORK', assignment.questions.map((q) => ({
        id: q.id,
        type: q.type,
        correctAnswer: q.correctAnswer,
        tolerance: q.tolerance,
        totalResponseCount: 1, // HOMEWORK: all questions count
        hasAnyAiScore: q.responses.some((r) => r.aiScore !== null),
        studentResponse: q.responses.find((r) => r.studentId === s.id) ?? null,
      })))
      return { netId: s.netId, gradeResult }
    })

    const sampleResult = rows[0]?.gradeResult ?? gradeSession('HOMEWORK', [])
    const grandMax = sampleResult.max

    const qHeaders = assignment.questions.map((q, i) => {
      const qr = sampleResult.questions.find((r) => r.id === q.id)
      return qr?.counted ? `Q${i + 1}` : `Q${i + 1} (ungraded)`
    })
    const header = ['NetID', ...qHeaders, 'Total', `Max (${grandMax})`].join(',')
    const csvRows = rows.map(({ netId, gradeResult: gr }) => {
      const scores = assignment.questions.map((q) => {
        const qr = gr.questions.find((r) => r.id === q.id)!
        return qr.counted ? qr.score.toFixed(1) : '—'
      })
      return [netId, ...scores, gr.earned.toFixed(1), grandMax.toFixed(1)].join(',')
    })

    const csv = [header, ...csvRows].join('\n')
    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', `attachment; filename="assignment-${assignment.id}-grades.csv"`)
    res.send(csv)
  } catch (err) {
    next(err)
  }
})

// Submission status — who has/hasn't submitted
router.get('/assignments/:id/submission-status', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const assignment = await prisma.assignment.findFirst({
      where: { id: p(req.params.id), class: { professorId: professor.id } },
      include: { questions: { select: { id: true } } },
    })
    if (!assignment) throw new AppError('Assignment not found', 404)

    const questionIds = assignment.questions.map((q) => q.id)
    const totalQuestions = questionIds.length

    const enrollments = await prisma.enrollment.findMany({
      where: { classId: assignment.classId },
      include: {
        student: { select: { id: true, netId: true } },
        section: { select: { id: true, name: true } },
      },
      orderBy: [{ section: { name: 'asc' } }],
    })

    const responses = totalQuestions > 0
      ? await prisma.response.groupBy({
          by: ['studentId'],
          where: { questionId: { in: questionIds } },
          _count: { id: true },
        })
      : []

    const responseMap = new Map(responses.map((r) => [r.studentId, r._count.id]))

    const students = enrollments.map((e) => {
      const submittedCount = responseMap.get(e.student.id) ?? 0
      return {
        student: e.student,
        section: e.section,
        submittedCount,
        totalQuestions,
        isComplete: submittedCount >= totalQuestions,
      }
    })

    students.sort((a, b) => {
      if (a.isComplete !== b.isComplete) return a.isComplete ? 1 : -1
      return a.student.netId.localeCompare(b.student.netId)
    })

    res.json({ success: true, data: { students, totalQuestions } })
  } catch (err) {
    next(err)
  }
})

export default router
