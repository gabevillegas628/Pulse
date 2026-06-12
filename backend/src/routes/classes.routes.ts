import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import bcrypt from 'bcryptjs'
import { customAlphabet } from 'nanoid'
import { Prisma } from '@prisma/client'
import { prisma } from '../db/index.js'
import { AppError } from '../middleware/error.middleware.js'
import { requireProfessor, ProfessorRequest } from '../middleware/auth.middleware.js'
import { gradeSession } from '../utils/scoring.js'
import { generateUniqueCode } from '../utils/codes.js'
import { p } from '../utils/params.js'

const nanoid = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6)
const nanoidDigits = customAlphabet('0123456789', 4)

const router = Router()
router.use(requireProfessor)

const createClassSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  textbookRepo: z.string().optional().nullable(),
  textbookPath: z.string().optional().nullable(),
  textbookBranch: z.string().optional().nullable(),
})

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = createClassSchema.parse(req.body)
    const professor = (req as ProfessorRequest).professor

    const joinCode = await generateUniqueCode(
      nanoid,
      (code) => prisma.class.findUnique({ where: { joinCode: code } }).then(Boolean)
    )

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
      include: {
        _count: { select: { sessions: true, enrollments: true } },
        sessions: {
          orderBy: { createdAt: 'desc' }, take: 1,
          select: {
            id: true, title: true, status: true, createdAt: true,
            runs: { where: { status: 'OPEN' }, select: { id: true }, take: 1 },
          },
        },
      },
    })

    // Participation rate: avg of (distinct responders / enrolled) per session with closed runs
    const classIds = classes.map((c) => c.id)
    let participationMap: Record<string, number | null> = {}
    if (classIds.length > 0) {
      const rows = await prisma.$queryRaw<Array<{ classId: string; participationRate: number | null }>>(
        Prisma.sql`
          SELECT sub."classId",
            AVG(sub.respondents::float / NULLIF(sub.enrolled, 0)) AS "participationRate"
          FROM (
            SELECT s.id, s."classId",
              COUNT(DISTINCT r."studentId") AS respondents,
              (SELECT COUNT(*) FROM "Enrollment" e WHERE e."classId" = s."classId") AS enrolled
            FROM "Session" s
            JOIN "SessionRun" sr ON sr."sessionId" = s.id AND sr.status IN ('CLOSED', 'ARCHIVED')
            LEFT JOIN "Response" r ON r."runId" = sr.id
            WHERE s."classId" IN (${Prisma.join(classIds)})
            GROUP BY s.id, s."classId"
          ) sub
          GROUP BY sub."classId"
        `
      )
      for (const row of rows) {
        participationMap[row.classId] = row.participationRate != null ? Number(row.participationRate) : null
      }
    }

    const result = classes.map((c) => ({
      ...c,
      participationRate: participationMap[c.id] ?? null,
      sessions: c.sessions.map(({ runs, ...s }) => ({ ...s, isLive: runs.length > 0 })),
    }))

    res.json({ success: true, data: { classes: result } })
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
        sections: { orderBy: { createdAt: 'asc' } },
        sessions: {
          orderBy: { createdAt: 'desc' },
          include: {
            _count: { select: { questions: true } },
            questions: { orderBy: { order: 'asc' } },
            runs: {
              orderBy: { openedAt: 'desc' },
              select: { id: true, sectionId: true, status: true, openedAt: true, closedAt: true },
            },
          },
        },
        assignments: {
          orderBy: { createdAt: 'desc' },
          include: {
            _count: { select: { questions: true } },
          },
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

const duplicateSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  transferQrCodes: z.boolean().default(false),
})

router.post('/:id/duplicate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const sourceId = p(req.params.id)
    const { name, description, transferQrCodes } = duplicateSchema.parse(req.body)

    const source = await prisma.class.findFirst({
      where: { id: sourceId, professorId: professor.id },
      include: {
        sessions: {
          orderBy: { createdAt: 'asc' },
          include: { questions: { orderBy: { order: 'asc' } } },
        },
      },
    })
    if (!source) throw new AppError('Class not found', 404)

    const joinCode = await generateUniqueCode(
      nanoid,
      (code) => prisma.class.findUnique({ where: { joinCode: code } }).then(Boolean)
    )

    const usedSessionCodes = new Set<string>()
    const uniqueSessionCode = () => generateUniqueCode(
      nanoidDigits,
      (code) => prisma.session.findUnique({ where: { accessCode: code } }).then(Boolean),
      20,
      usedSessionCodes
    )

    const usedQuestionCodes = new Set<string>()
    const uniqueQuestionCode = () => generateUniqueCode(
      nanoidDigits,
      (code) => prisma.question.findUnique({ where: { accessCode: code } }).then(Boolean),
      20,
      usedQuestionCodes
    )

    const newSessionCodes: string[] = []
    for (const _ of source.sessions) newSessionCodes.push(await uniqueSessionCode())

    const newQuestionCodes: string[][] = []
    const tempQuestionCodes: string[][] = []
    for (const session of source.sessions) {
      const qCodes: string[] = []
      const tCodes: string[] = []
      for (const _ of session.questions) {
        qCodes.push(await uniqueQuestionCode())
        if (transferQrCodes) tCodes.push(await uniqueQuestionCode())
      }
      newQuestionCodes.push(qCodes)
      tempQuestionCodes.push(tCodes)
    }

    const newClass = await prisma.$transaction(async (tx) => {
      const cls = await tx.class.create({
        data: { name, description: description ?? null, joinCode, professorId: professor.id },
      })

      type NewSession = { id: string; questions: { id: string; accessCode: string }[] }
      const newSessions: NewSession[] = []
      for (let i = 0; i < source.sessions.length; i++) {
        const src = source.sessions[i]
        const session = await tx.session.create({
          data: {
            classId: cls.id,
            title: src.title,
            accessCode: newSessionCodes[i],
            status: 'DRAFT',
            questions: {
              create: src.questions.map((q, j) => ({
                text: q.text,
                type: q.type,
                options: q.options ?? undefined,
                order: q.order,
                accessCode: newQuestionCodes[i][j],
                correctAnswer: q.correctAnswer,
              })),
            },
          },
          include: { questions: { orderBy: { order: 'asc' } } },
        })
        newSessions.push(session as NewSession)
      }

      if (transferQrCodes) {
        for (let i = 0; i < source.sessions.length; i++) {
          const srcQuestions = source.sessions[i].questions
          const newQuestions = newSessions[i].questions
          for (let j = 0; j < srcQuestions.length; j++) {
            const oldCode = srcQuestions[j].accessCode
            const newCode = newQuestionCodes[i][j]
            const tempCode = tempQuestionCodes[i][j]
            await tx.question.update({ where: { id: srcQuestions[j].id }, data: { accessCode: tempCode } })
            await tx.question.update({ where: { id: newQuestions[j].id }, data: { accessCode: oldCode } })
            await tx.question.update({ where: { id: srcQuestions[j].id }, data: { accessCode: newCode } })
          }
        }
      }

      return tx.class.findUnique({
        where: { id: cls.id },
        include: { _count: { select: { sessions: true, enrollments: true } } },
      })
    })

    res.status(201).json({ success: true, data: { class: newClass } })
  } catch (err) {
    next(err)
  }
})

// ─── Section routes ───────────────────────────────────────────────────────────

router.post('/:id/sections', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const classId = p(req.params.id)
    const { name } = z.object({ name: z.string().min(1) }).parse(req.body)

    const cls = await prisma.class.findFirst({ where: { id: classId, professorId: professor.id } })
    if (!cls) throw new AppError('Class not found', 404)

    const joinCode = await generateUniqueCode(
      nanoid,
      (code) => prisma.section.findUnique({ where: { joinCode: code } }).then(Boolean)
    )

    const section = await prisma.section.create({ data: { classId, name, joinCode } })
    res.status(201).json({ success: true, data: { section } })
  } catch (err) {
    next(err)
  }
})

router.get('/:id/sections', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const classId = p(req.params.id)
    const cls = await prisma.class.findFirst({ where: { id: classId, professorId: professor.id } })
    if (!cls) throw new AppError('Class not found', 404)
    const sections = await prisma.section.findMany({ where: { classId }, orderBy: { createdAt: 'asc' } })
    res.json({ success: true, data: { sections } })
  } catch (err) {
    next(err)
  }
})

router.patch('/:id/enrollments/:studentId/section', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const classId = p(req.params.id)
    const studentId = p(req.params.studentId)
    const { sectionId } = z.object({ sectionId: z.string().nullable() }).parse(req.body)

    const cls = await prisma.class.findFirst({ where: { id: classId, professorId: professor.id } })
    if (!cls) throw new AppError('Class not found', 404)

    if (sectionId !== null) {
      const section = await prisma.section.findFirst({ where: { id: sectionId, classId } })
      if (!section) throw new AppError('Section not found in this class', 404)
    }

    const enrollment = await prisma.enrollment.update({
      where: { studentId_classId: { studentId, classId } },
      data: { sectionId },
    })
    res.json({ success: true, data: { enrollment } })
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

    const [enrollments, allSessionResponses, allAssignmentResponses, totalClosedSessionRuns] = await Promise.all([
      prisma.enrollment.findMany({
        where: { classId },
        include: {
          student: { select: { id: true, netId: true, email: true } },
          section: { select: { id: true, name: true } },
        },
        orderBy: { enrolledAt: 'desc' },
      }),
      // Responses via session runs
      prisma.response.findMany({
        where: { question: { session: { classId } } },
        select: {
          studentId: true,
          wordCount: true,
          question: { select: { sessionId: true, type: true } },
        },
      }),
      // Responses via assignments
      prisma.response.findMany({
        where: { question: { assignment: { classId } } },
        select: {
          studentId: true,
          wordCount: true,
          question: { select: { assignmentId: true, type: true } },
        },
      }),
      // Count sessions that have at least one closed run
      prisma.session.count({
        where: { classId, runs: { some: { status: { in: ['CLOSED', 'ARCHIVED'] } } } },
      }),
    ])

    type StatsAgg = { totalResponses: number; sessionIds: Set<string>; totalWordCount: number; freeTextCount: number }
    const byStudent = new Map<string, StatsAgg>()

    for (const r of allSessionResponses) {
      const s = byStudent.get(r.studentId) ?? { totalResponses: 0, sessionIds: new Set<string>(), totalWordCount: 0, freeTextCount: 0 }
      s.totalResponses++
      if (r.question.sessionId) s.sessionIds.add(r.question.sessionId)
      if (r.question.type === 'FREE_TEXT') { s.totalWordCount += r.wordCount; s.freeTextCount++ }
      byStudent.set(r.studentId, s)
    }

    for (const r of allAssignmentResponses) {
      const s = byStudent.get(r.studentId) ?? { totalResponses: 0, sessionIds: new Set<string>(), totalWordCount: 0, freeTextCount: 0 }
      s.totalResponses++
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
          totalClosedSessions: totalClosedSessionRuns,
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

    // Get student's section for run filtering
    const enrollment = await prisma.enrollment.findUnique({
      where: { studentId_classId: { studentId, classId } },
      select: { sectionId: true },
    })
    const studentSectionId = enrollment?.sectionId ?? null

    const [sessions, assignments] = await Promise.all([
      prisma.session.findMany({
        where: { classId, status: { not: 'DRAFT' } },
        orderBy: { createdAt: 'desc' },
        include: {
          runs: {
            where: { status: { in: ['CLOSED', 'ARCHIVED'] } },
            select: { id: true, sectionId: true },
          },
          questions: {
            orderBy: { order: 'asc' },
            include: {
              responses: {
                where: { studentId },
                select: { responseText: true, wordCount: true, isFlagged: true, submittedAt: true, aiScore: true },
              },
              _count: { select: { responses: true } },
            },
          },
        },
      }),
      prisma.assignment.findMany({
        where: { classId, status: { not: 'DRAFT' } },
        orderBy: { createdAt: 'desc' },
        include: {
          questions: {
            orderBy: { order: 'asc' },
            include: {
              responses: {
                where: { studentId },
                select: { responseText: true, wordCount: true, isFlagged: true, submittedAt: true, aiScore: true },
              },
              _count: { select: { responses: true } },
            },
          },
        },
      }),
    ])

    const allSessionQuestionIds = sessions.flatMap((s) => s.questions.map((q) => q.id))
    const allAssignmentQuestionIds = assignments.flatMap((a) => a.questions.map((q) => q.id))
    const allQuestionIds = [...allSessionQuestionIds, ...allAssignmentQuestionIds]

    const aiGradedQuestionIds = new Set(
      (await prisma.response.groupBy({
        by: ['questionId'],
        where: { questionId: { in: allQuestionIds }, aiScore: { not: null } },
      })).map((r) => r.questionId)
    )

    const isClosed = (status: string) => status === 'CLOSED' || status === 'ARCHIVED'

    const sessionResults = sessions.map((session) => {
      const qs = session.questions as Array<typeof session.questions[number] & { _count: { responses: number } }>

      // Section-aware: only count responses in relevant runs for this student's section
      const relevantRunIds = session.runs
        .filter((r) => r.sectionId === null || r.sectionId === studentSectionId)
        .map((r) => r.id)

      const gradeResult = (isClosed(session.status) || relevantRunIds.length > 0)
        ? gradeSession('IN_CLASS', qs.map((q) => ({
            id: q.id,
            type: q.type,
            correctAnswer: q.correctAnswer,
            tolerance: q.tolerance,
            unit: q.unit,
            totalResponseCount: q._count.responses,
            sectionResponseCount: relevantRunIds.length > 0 ? q._count.responses : 0,
            hasAnyAiScore: aiGradedQuestionIds.has(q.id),
            studentResponse: q.responses[0] ?? null,
          })))
        : null

      return {
        id: session.id,
        title: session.title,
        type: 'IN_CLASS' as const,
        status: session.status,
        createdAt: session.createdAt,
        questions: qs.map((q, i) => {
          const qResult = gradeResult?.questions.find((r) => r.id === q.id)
          return {
            id: q.id,
            text: q.text,
            type: q.type,
            number: i + 1,
            correctAnswer: q.correctAnswer,
            response: q.responses[0] ?? null,
            score: qResult?.counted ? qResult.score : null,
            counted: qResult?.counted ?? false,
          }
        }),
      }
    })

    const assignmentResults = assignments.map((assignment) => {
      const qs = assignment.questions as Array<typeof assignment.questions[number] & { _count: { responses: number } }>

      const gradeResult = isClosed(assignment.status)
        ? gradeSession('HOMEWORK', qs.map((q) => ({
            id: q.id,
            type: q.type,
            correctAnswer: q.correctAnswer,
            tolerance: q.tolerance,
            unit: q.unit,
            totalResponseCount: 1,
            hasAnyAiScore: aiGradedQuestionIds.has(q.id),
            studentResponse: q.responses[0] ?? null,
          })))
        : null

      return {
        id: assignment.id,
        title: assignment.title,
        type: 'HOMEWORK' as const,
        status: assignment.status,
        createdAt: assignment.createdAt,
        questions: qs.map((q, i) => {
          const qResult = gradeResult?.questions.find((r) => r.id === q.id)
          return {
            id: q.id,
            text: q.text,
            type: q.type,
            number: i + 1,
            correctAnswer: q.correctAnswer,
            response: q.responses[0] ?? null,
            score: qResult?.counted ? qResult.score : null,
            counted: qResult?.counted ?? false,
          }
        }),
      }
    })

    const result = [...sessionResults, ...assignmentResults].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )

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

// ─── Gradebook types ──────────────────────────────────────────────────────────

type GradeQuestion = {
  id: string
  type: string
  correctAnswer: string | null
  tolerance: number | null
  unit: string | null
  responses: { studentId: string; responseText: string; aiScore: number | null }[]
}

type GradebookItem = {
  id: string
  title: string
  type: 'IN_CLASS' | 'HOMEWORK'
  questions: GradeQuestion[]
  // For sessions: runs for section-aware grading
  runs?: Array<{ id: string; sectionId: string | null }>
}

type GradeEnrollment = {
  student: { id: string; netId: string; name: string }
  section: { id: string; name: string } | null
}

// Class-wide grades JSON
router.get('/:id/grades/json', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const classId = p(req.params.id)

    const cls = await prisma.class.findFirst({
      where: { id: classId, professorId: professor.id },
      include: {
        enrollments: {
          include: {
            student: { select: { id: true, netId: true } },
            section: { select: { id: true, name: true } },
          },
        },
        sessions: {
          where: { status: { in: ['OPEN' as const, 'CLOSED' as const, 'ARCHIVED' as const] } },
          orderBy: { createdAt: 'asc' },
          include: {
            runs: {
              where: { status: { in: ['CLOSED' as const, 'ARCHIVED' as const] } },
              select: { id: true, sectionId: true },
            },
            questions: {
              orderBy: { order: 'asc' },
              include: {
                responses: { select: { studentId: true, responseText: true, aiScore: true } },
              },
            },
          },
        },
        assignments: {
          where: { status: { in: ['CLOSED' as const, 'ARCHIVED' as const] } },
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

    const sessions = cls.sessions as unknown as Array<GradebookItem & { runs: Array<{ id: string; sectionId: string | null }> }>
    const assignments = cls.assignments as unknown as GradebookItem[]
    const enrollments = cls.enrollments as unknown as GradeEnrollment[]

    const allSessions: GradebookItem[] = [
      ...sessions.map((s) => ({ ...s, type: 'IN_CLASS' as const })),
      ...assignments.map((a) => ({ ...a, type: 'HOMEWORK' as const })),
    ]

    const participationSessions = sessions
    const homeworkSessions = assignments

    const participationMax = participationSessions.reduce((sum, s) => {
      return sum + gradeSession('IN_CLASS', s.questions.map((q) => ({
        id: q.id, type: q.type, correctAnswer: q.correctAnswer, tolerance: q.tolerance, unit: q.unit,
        totalResponseCount: q.responses.length,
        hasAnyAiScore: q.responses.some((r) => r.aiScore !== null),
        studentResponse: null,
      }))).max
    }, 0)

    const hwMax = homeworkSessions.reduce((sum, a) => {
      return sum + gradeSession('HOMEWORK', a.questions.map((q) => ({
        id: q.id, type: q.type, correctAnswer: q.correctAnswer, tolerance: q.tolerance, unit: q.unit,
        totalResponseCount: a.questions.length,
        hasAnyAiScore: q.responses.some((r) => r.aiScore !== null),
        studentResponse: null,
      }))).max
    }, 0)

    const gradebookSessions = allSessions.map((s) => ({
      id: s.id,
      title: s.title,
      type: s.type,
      questionCount: s.questions.length,
    }))

    const students = enrollments.map((enrollment) => {
      const student = enrollment.student
      const studentSectionId = (enrollment.section as { id: string; name: string } | null)?.id ?? null

      const scores = allSessions.map((item) => {
        if (item.type === 'IN_CLASS') {
          const sess = item as GradebookItem & { runs: Array<{ id: string; sectionId: string | null }> }
          const relevantRunIds = new Set(
            (sess.runs ?? [])
              .filter((r) => r.sectionId === null || r.sectionId === studentSectionId)
              .map((r) => r.id)
          )
          const result = gradeSession('IN_CLASS', sess.questions.map((q) => ({
            id: q.id, type: q.type, correctAnswer: q.correctAnswer, tolerance: q.tolerance, unit: q.unit,
            totalResponseCount: q.responses.length,
            sectionResponseCount: relevantRunIds.size > 0 ? q.responses.length : 0,
            hasAnyAiScore: q.responses.some((r) => r.aiScore !== null),
            studentResponse: q.responses.find((r) => r.studentId === student.id) ?? null,
          })))
          return { sessionId: item.id, earned: result.earned, max: result.max }
        } else {
          const result = gradeSession('HOMEWORK', item.questions.map((q) => ({
            id: q.id, type: q.type, correctAnswer: q.correctAnswer, tolerance: q.tolerance, unit: q.unit,
            totalResponseCount: 1,
            hasAnyAiScore: q.responses.some((r) => r.aiScore !== null),
            studentResponse: q.responses.find((r) => r.studentId === student.id) ?? null,
          })))
          return { sessionId: item.id, earned: result.earned, max: result.max }
        }
      })

      const participationTotal = participationSessions.reduce((sum, s) => {
        const score = scores.find((sc) => sc.sessionId === s.id)
        return sum + (score?.earned ?? 0)
      }, 0)
      const hwTotal = homeworkSessions.reduce((sum, a) => {
        const score = scores.find((sc) => sc.sessionId === a.id)
        return sum + (score?.earned ?? 0)
      }, 0)

      return {
        studentId: student.id,
        netId: student.netId,
        section: enrollment.section?.name ?? null,
        scores,
        participationTotal: Math.round(participationTotal * 10) / 10,
        participationMax,
        hwTotal: Math.round(hwTotal * 10) / 10,
        hwMax,
      }
    })

    res.json({ success: true, data: { sessions: gradebookSessions, students } })
  } catch (err) {
    next(err)
  }
})

// Class-wide grades CSV export
router.get('/:id/grades', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const classId = p(req.params.id)

    const cls = await prisma.class.findFirst({
      where: { id: classId, professorId: professor.id },
      include: {
        enrollments: {
          include: {
            student: { select: { id: true, netId: true } },
            section: { select: { id: true, name: true } },
          },
        },
        sessions: {
          where: { status: { in: ['OPEN' as const, 'CLOSED' as const, 'ARCHIVED' as const] } },
          orderBy: { createdAt: 'asc' },
          include: {
            runs: {
              where: { status: { in: ['CLOSED' as const, 'ARCHIVED' as const] } },
              select: { id: true, sectionId: true },
            },
            questions: {
              orderBy: { order: 'asc' },
              include: {
                responses: { select: { studentId: true, responseText: true, aiScore: true } },
              },
            },
          },
        },
        assignments: {
          where: { status: { in: ['CLOSED' as const, 'ARCHIVED' as const] } },
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

    const sessions = cls.sessions as unknown as Array<GradebookItem & { runs: Array<{ id: string; sectionId: string | null }> }>
    const assignments = cls.assignments as unknown as GradebookItem[]
    const enrollments = cls.enrollments as unknown as Array<GradeEnrollment & { section: { id: string; name: string } | null }>

    const participationMax = sessions.reduce((sum, s) => {
      return sum + gradeSession('IN_CLASS', s.questions.map((q) => ({
        id: q.id, type: q.type, correctAnswer: q.correctAnswer, tolerance: q.tolerance, unit: q.unit,
        totalResponseCount: q.responses.length,
        hasAnyAiScore: q.responses.some((r) => r.aiScore !== null),
        studentResponse: null,
      }))).max
    }, 0)

    const homeworkMax = assignments.reduce((sum, a) => {
      return sum + gradeSession('HOMEWORK', a.questions.map((q) => ({
        id: q.id, type: q.type, correctAnswer: q.correctAnswer, tolerance: q.tolerance, unit: q.unit,
        totalResponseCount: 1,
        hasAnyAiScore: q.responses.some((r) => r.aiScore !== null),
        studentResponse: null,
      }))).max
    }, 0)

    const participationHeaders = sessions.map((s) => s.title.replace(/,/g, ' '))
    const homeworkHeaders = assignments.map((a) => `HW: ${a.title.replace(/,/g, ' ')}`)

    const header = [
      'NetID', 'Section',
      ...participationHeaders,
      'Participation Total', `Participation Max (${participationMax})`,
      ...homeworkHeaders,
      'HW Total', `HW Max (${homeworkMax})`,
    ].join(',')

    const csvRows = enrollments.map((enrollment) => {
      const student = enrollment.student
      const sectionName = enrollment.section?.name ?? ''
      const studentSectionId = enrollment.section?.id ?? null

      const pTotals = sessions.map((sess) => {
        const relevantRunIds = new Set(
          (sess.runs ?? [])
            .filter((r) => r.sectionId === null || r.sectionId === studentSectionId)
            .map((r) => r.id)
        )
        return gradeSession('IN_CLASS', sess.questions.map((q) => ({
          id: q.id, type: q.type, correctAnswer: q.correctAnswer, tolerance: q.tolerance, unit: q.unit,
          totalResponseCount: q.responses.length,
          sectionResponseCount: relevantRunIds.size > 0 ? q.responses.length : 0,
          hasAnyAiScore: q.responses.some((r) => r.aiScore !== null),
          studentResponse: q.responses.find((r) => r.studentId === student.id) ?? null,
        }))).earned
      })

      const hwTotals = assignments.map((asgn) =>
        gradeSession('HOMEWORK', asgn.questions.map((q) => ({
          id: q.id, type: q.type, correctAnswer: q.correctAnswer, tolerance: q.tolerance, unit: q.unit,
          totalResponseCount: 1,
          hasAnyAiScore: q.responses.some((r) => r.aiScore !== null),
          studentResponse: q.responses.find((r) => r.studentId === student.id) ?? null,
        }))).earned
      )

      const pTotal = pTotals.reduce((a, b) => a + b, 0)
      const hwTotal = hwTotals.reduce((a, b) => a + b, 0)

      return [
        student.netId,
        sectionName,
        ...pTotals.map((t) => t.toFixed(1)),
        pTotal.toFixed(1),
        participationMax.toFixed(1),
        ...hwTotals.map((t) => t.toFixed(1)),
        hwTotal.toFixed(1),
        homeworkMax.toFixed(1),
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

// ─── Textbook view counts ─────────────────────────────────────────────────────

router.get('/:id/textbook-views', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const classId = p(req.params.id)
    const views = await prisma.textbookView.groupBy({
      by: ['chapterFilename'],
      where: { classId },
      _count: { id: true },
    })
    res.json({
      data: {
        views: views.map((v) => ({ chapterFilename: v.chapterFilename, count: v._count.id })),
      },
    })
  } catch (err) {
    next(err)
  }
})

export default router
