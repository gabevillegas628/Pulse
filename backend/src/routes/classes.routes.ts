import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import bcrypt from 'bcryptjs'
import { customAlphabet } from 'nanoid'
import { prisma } from '../db/index.js'
import { AppError } from '../middleware/error.middleware.js'
import { requireProfessor, ProfessorRequest } from '../middleware/auth.middleware.js'

const nanoid = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6)
const nanoidDigits = customAlphabet('0123456789', 4)

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
        sections: { orderBy: { createdAt: 'asc' } },
        sessions: {
          orderBy: { createdAt: 'desc' },
          include: {
            _count: { select: { questions: true } },
            questions: { orderBy: { order: 'asc' } },
            targetSection: { select: { id: true, name: true } },
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

    // Pre-generate all codes needed before the transaction.
    // Session and question codes go into separate tables so we track uniqueness separately.

    let joinCode: string
    let jAttempts = 0
    do {
      joinCode = nanoid()
      jAttempts++
      if (jAttempts > 10) throw new AppError('Failed to generate unique join code', 500)
    } while (await prisma.class.findUnique({ where: { joinCode } }))

    const usedSessionCodes = new Set<string>()
    async function uniqueSessionCode(): Promise<string> {
      let code: string
      let att = 0
      do {
        code = nanoidDigits()
        att++
        if (att > 20) throw new AppError('Failed to generate unique session code', 500)
      } while (usedSessionCodes.has(code) || await prisma.session.findUnique({ where: { accessCode: code } }))
      usedSessionCodes.add(code)
      return code
    }

    const usedQuestionCodes = new Set<string>()
    async function uniqueQuestionCode(): Promise<string> {
      let code: string
      let att = 0
      do {
        code = nanoidDigits()
        att++
        if (att > 20) throw new AppError('Failed to generate unique question code', 500)
      } while (usedQuestionCodes.has(code) || await prisma.question.findUnique({ where: { accessCode: code } }))
      usedQuestionCodes.add(code)
      return code
    }

    const newSessionCodes: string[] = []
    for (const _ of source.sessions) newSessionCodes.push(await uniqueSessionCode())

    // newQuestionCodes[i][j] = fresh code for session i, question j
    // tempQuestionCodes[i][j] = temp placeholder used during the 3-step swap
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
            // 3-step swap to satisfy the unique constraint at each statement
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

// --- Section routes ---

router.post('/:id/sections', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const classId = p(req.params.id)
    const { name } = z.object({ name: z.string().min(1) }).parse(req.body)

    const cls = await prisma.class.findFirst({ where: { id: classId, professorId: professor.id } })
    if (!cls) throw new AppError('Class not found', 404)

    let joinCode: string
    let attempts = 0
    do {
      joinCode = nanoid()
      attempts++
      if (attempts > 10) throw new AppError('Failed to generate unique join code', 500)
    } while (await prisma.section.findUnique({ where: { joinCode } }))

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

    const [enrollments, allResponses, totalClosedSessions] = await Promise.all([
      prisma.enrollment.findMany({
        where: { classId },
        include: {
          student: { select: { id: true, netId: true, name: true, email: true } },
          section: { select: { id: true, name: true } },
        },
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

type GradeQuestion = {
  type: string
  correctAnswer: string | null
  responses: { studentId: string; responseText: string; aiScore: number | null }[]
}
type GradeSession = {
  id: string
  title: string
  type: string
  questions: GradeQuestion[]
}
type GradeEnrollment = {
  student: { id: string; netId: string; name: string }
  section: { name: string } | null
}

// Class-wide grades export — participation columns + homework columns, one row per student
router.get('/:id/grades', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const classId = p(req.params.id)

    const cls = await prisma.class.findFirst({
      where: { id: classId, professorId: professor.id },
      include: {
        enrollments: {
          include: {
            student: { select: { id: true, netId: true, name: true } },
            section: { select: { name: true } },
          },
        },
        sessions: {
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

    const allSessions = cls.sessions as unknown as GradeSession[]
    const enrollments = cls.enrollments as unknown as GradeEnrollment[]

    const participationSessions = allSessions.filter((s) => s.type !== 'HOMEWORK')
    const homeworkSessions = allSessions.filter((s) => s.type === 'HOMEWORK')

    const participationMax = participationSessions.reduce((sum, s) => sum + s.questions.length, 0)
    const homeworkMax = homeworkSessions.reduce((sum, s) => sum + s.questions.length, 0)

    const participationHeaders = participationSessions.map((s) => s.title.replace(/,/g, ' '))
    const homeworkHeaders = homeworkSessions.map((s) => `HW: ${s.title.replace(/,/g, ' ')}`)

    const header = [
      'NetID', 'Name', 'Section',
      ...participationHeaders,
      'Participation Total', `Participation Max (${participationMax})`,
      ...homeworkHeaders,
      'HW Total', `HW Max (${homeworkMax})`,
    ].join(',')

    const csvRows = enrollments.map((enrollment) => {
      const student = enrollment.student
      const sectionName = enrollment.section?.name ?? ''

      const pTotals = participationSessions.map((session) =>
        session.questions.reduce((sum: number, q: GradeQuestion) => {
          const resp = q.responses.find((r) => r.studentId === student.id) ?? null
          return sum + calcScore(q.type, q.correctAnswer, resp)
        }, 0)
      )
      const hwTotals = homeworkSessions.map((session) =>
        session.questions.reduce((sum: number, q: GradeQuestion) => {
          const resp = q.responses.find((r) => r.studentId === student.id) ?? null
          return sum + calcScore(q.type, q.correctAnswer, resp)
        }, 0)
      )

      const pTotal = pTotals.reduce((a, b) => a + b, 0)
      const hwTotal = hwTotals.reduce((a, b) => a + b, 0)

      return [
        student.netId,
        `"${student.name}"`,
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

export default router
