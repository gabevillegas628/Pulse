import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { customAlphabet } from 'nanoid'
import QRCode from 'qrcode'
import Anthropic from '@anthropic-ai/sdk'
import { prisma } from '../db/index.js'
import { config } from '../config/index.js'
import { AppError } from '../middleware/error.middleware.js'
import { requireProfessor, ProfessorRequest } from '../middleware/auth.middleware.js'
import { getIo } from '../socket.js'
import { SessionStatus } from 'shared'

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey })

const nanoidDigits = customAlphabet('0123456789', 4)

const router = Router()
const p = (v: string | string[]): string => (Array.isArray(v) ? v[0] : v)

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
  questions: z.array(questionInputSchema).min(1),
})

async function generateUniqueQuestionCode(): Promise<string> {
  let code: string
  let attempts = 0
  do {
    code = nanoidDigits()
    attempts++
    if (attempts > 20) throw new AppError('Failed to generate unique question code', 500)
  } while (await prisma.question.findUnique({ where: { accessCode: code } }))
  return code
}

async function generateQr(url: string): Promise<string> {
  return QRCode.toDataURL(url, { width: 400, margin: 2 })
}

async function attachQuestionQrs(questions: { id: string; accessCode: string; [key: string]: unknown }[]) {
  return Promise.all(
    questions.map(async (q) => ({
      ...q,
      qrDataUrl: await generateQr(`${config.baseUrl}/q/code/${q.accessCode}`),
    }))
  )
}

// --- Professor-owned session routes ---

router.post('/classes/:classId/sessions', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const body = createSessionSchema.parse(req.body)

    const cls = await prisma.class.findFirst({
      where: { id: p(req.params.classId), professorId: professor.id },
    })
    if (!cls) throw new AppError('Class not found', 404)

    let accessCode: string
    let attempts = 0
    do {
      accessCode = nanoidDigits()
      attempts++
      if (attempts > 20) throw new AppError('Failed to generate unique access code', 500)
    } while (await prisma.session.findUnique({ where: { accessCode } }))

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

router.get('/classes/:classId/sessions', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const cls = await prisma.class.findFirst({
      where: { id: p(req.params.classId), professorId: professor.id },
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
      },
    })
    res.json({ success: true, data: { sessions } })
  } catch (err) {
    next(err)
  }
})

router.get('/sessions/:id', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const session = await prisma.session.findFirst({
      where: { id: p(req.params.id), class: { professorId: professor.id } },
      include: {
        class: { select: { id: true, name: true } },
        targetSection: { select: { id: true, name: true } },
        groups: { orderBy: [{ order: 'asc' }, { createdAt: 'asc' }] },
        questions: {
          orderBy: { order: 'asc' },
          include: {
            responses: {
              include: { student: { select: { id: true, netId: true, name: true } } },
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
    res.json({ success: true, data: { session: { ...session, questions: questionsWithQr } } })
  } catch (err) {
    next(err)
  }
})

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

    // Validate targetSectionId change — only allowed when DRAFT or CLOSED
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
          openedAt: status === SessionStatus.OPEN && !existing.openedAt ? new Date() : existing.openedAt,
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

router.post('/sessions/:id/questions', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const { text, type, options, groupId, correctAnswer, tolerance, unit } = z.object({
      text: z.string().min(1),
      type: z.enum(['FREE_TEXT', 'MULTIPLE_CHOICE', 'RATING', 'YES_NO', 'NUMERIC', 'MULTI_SELECT', 'ORDERING', 'STRUCTURE']),
      options: z.array(z.string()).optional(),
      groupId: z.string().optional(),
      correctAnswer: z.string().optional(),
      tolerance: z.number().optional(),
      unit: z.string().optional(),
    }).parse(req.body)

    const session = await prisma.session.findFirst({
      where: { id: p(req.params.id), class: { professorId: professor.id } },
      include: { questions: { orderBy: { order: 'desc' }, take: 1 } },
    })
    if (!session) throw new AppError('Session not found', 404)

    if (groupId) {
      const group = await prisma.questionGroup.findFirst({ where: { id: groupId, sessionId: session.id } })
      if (!group) throw new AppError('Group not found in this session', 404)
    }

    const nextOrder = (session.questions[0]?.order ?? -1) + 1
    const accessCode = await generateUniqueQuestionCode()

    const question = await prisma.question.create({
      data: {
        sessionId: session.id,
        groupId: groupId ?? null,
        text,
        type: type as import('@prisma/client').QuestionType,
        options: options && options.length > 0 ? options : undefined,
        order: nextOrder,
        accessCode,
        correctAnswer: type === 'NUMERIC' ? (correctAnswer ?? null)
          : type === 'ORDERING' && options && options.length > 0 ? JSON.stringify(options)
          : type === 'MULTI_SELECT' ? (correctAnswer ?? null)
          : undefined,
        tolerance: type === 'NUMERIC' ? (tolerance ?? null) : undefined,
        unit: type === 'NUMERIC' ? (unit ?? null) : undefined,
      },
    })

    const qrDataUrl = await generateQr(`${config.baseUrl}/q/${question.id}`)
    res.status(201).json({ success: true, data: { question: { ...question, qrDataUrl } } })
  } catch (err) {
    next(err)
  }
})

// --- Question group endpoints ---

router.post('/sessions/:id/groups', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const { title, text } = z.object({
      title: z.string().min(1),
      text: z.string().optional(),
    }).parse(req.body)

    const session = await prisma.session.findFirst({
      where: { id: p(req.params.id), class: { professorId: professor.id } },
      include: { groups: { orderBy: { order: 'desc' }, take: 1 } },
    })
    if (!session) throw new AppError('Session not found', 404)

    const nextOrder = (session.groups[0]?.order ?? -1) + 1
    const group = await prisma.questionGroup.create({
      data: { sessionId: session.id, title, text: text ?? null, order: nextOrder },
    })
    res.status(201).json({ success: true, data: { group } })
  } catch (err) {
    next(err)
  }
})

router.patch('/sessions/:id/groups/:groupId', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const { title, text } = z.object({
      title: z.string().min(1).optional(),
      text: z.string().nullable().optional(),
    }).parse(req.body)

    const group = await prisma.questionGroup.findFirst({
      where: { id: p(req.params.groupId), sessionId: p(req.params.id), session: { class: { professorId: professor.id } } },
    })
    if (!group) throw new AppError('Group not found', 404)

    const updated = await prisma.questionGroup.update({
      where: { id: group.id },
      data: {
        ...(title !== undefined && { title }),
        ...(text !== undefined && { text }),
      },
    })
    res.json({ success: true, data: { group: updated } })
  } catch (err) {
    next(err)
  }
})

router.delete('/sessions/:id/groups/:groupId', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor

    const group = await prisma.questionGroup.findFirst({
      where: { id: p(req.params.groupId), sessionId: p(req.params.id), session: { class: { professorId: professor.id } } },
    })
    if (!group) throw new AppError('Group not found', 404)

    await prisma.question.updateMany({ where: { groupId: group.id }, data: { groupId: null } })
    await prisma.questionGroup.delete({ where: { id: group.id } })
    res.json({ success: true, data: null })
  } catch (err) {
    next(err)
  }
})

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

// ─── Deadline extensions ──────────────────────────────────────────────────────

router.get('/sessions/:id/extensions', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const session = await prisma.session.findFirst({
      where: { id: p(req.params.id), class: { professorId: professor.id } },
    })
    if (!session) throw new AppError('Session not found', 404)

    const extensions = await prisma.deadlineExtension.findMany({
      where: { sessionId: session.id },
      include: { student: { select: { id: true, name: true, netId: true } } },
      orderBy: { createdAt: 'asc' },
    })
    res.json({ success: true, data: { extensions } })
  } catch (err) {
    next(err)
  }
})

router.post('/sessions/:id/extensions', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const { studentId, deadline } = z.object({
      studentId: z.string().min(1),
      deadline: z.string().datetime(),
    }).parse(req.body)

    const session = await prisma.session.findFirst({
      where: { id: p(req.params.id), class: { professorId: professor.id } },
    })
    if (!session) throw new AppError('Session not found', 404)

    const enrollment = await prisma.enrollment.findUnique({
      where: { studentId_classId: { studentId, classId: session.classId } },
    })
    if (!enrollment) throw new AppError('Student is not enrolled in this class', 400)

    const extension = await prisma.deadlineExtension.upsert({
      where: { sessionId_studentId: { sessionId: session.id, studentId } },
      create: { sessionId: session.id, studentId, deadline: new Date(deadline) },
      update: { deadline: new Date(deadline) },
      include: { student: { select: { id: true, name: true, netId: true } } },
    })
    res.status(201).json({ success: true, data: { extension } })
  } catch (err) {
    next(err)
  }
})

router.delete('/sessions/:id/extensions/:studentId', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const session = await prisma.session.findFirst({
      where: { id: p(req.params.id), class: { professorId: professor.id } },
    })
    if (!session) throw new AppError('Session not found', 404)

    await prisma.deadlineExtension.deleteMany({
      where: { sessionId: session.id, studentId: p(req.params.studentId) },
    })
    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

// CSV export — includes scores for all enrolled students
router.get('/sessions/:id/export', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const session = await prisma.session.findFirst({
      where: { id: p(req.params.id), class: { professorId: professor.id } },
      include: {
        class: { include: { enrollments: { include: { student: { select: { id: true, netId: true, name: true } } } } } },
        questions: {
          orderBy: { order: 'asc' },
          include: {
            responses: { select: { studentId: true, responseText: true, wordCount: true, aiScore: true } },
          },
        },
      },
    })
    if (!session) throw new AppError('Session not found', 404)

    // All enrolled students as the row set
    const students = session.class.enrollments.map((e) => e.student)

    type Row = { netId: string; name: string; scores: number[] }
    const rows: Row[] = students.map((s) => {
      const scores = session.questions.map((q) => {
        const resp = q.responses.find((r) => r.studentId === s.id) ?? null
        return calcScore(q.type, q.correctAnswer, resp, q.tolerance)
      })
      return { netId: s.netId, name: s.name, scores }
    })

    const maxPerQ = session.questions.map(() => 1.0)
    const grandMax = maxPerQ.reduce((a, b) => a + b, 0)

    const qHeaders = session.questions.map((_q, i) => `Q${i + 1} Score`)
    const header = ['NetID', 'Name', ...qHeaders, 'Total', `Max (${grandMax})`].join(',')
    const csvRows = rows.map((r) => {
      const total = r.scores.reduce((a, b) => a + b, 0)
      return [r.netId, `"${r.name}"`, ...r.scores.map(String), total.toFixed(1), grandMax.toFixed(1)].join(',')
    })

    const csv = [header, ...csvRows].join('\n')
    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', `attachment; filename="session-${session.id}-grades.csv"`)
    res.send(csv)
  } catch (err) {
    next(err)
  }
})

// --- Grading helpers ---

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

// Update question — correctAnswer (grading) and/or groupId (authoring)
router.patch('/sessions/:sessionId/questions/:questionId', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const body = z.object({
      correctAnswer: z.string().nullable().optional(),
      groupId: z.string().nullable().optional(),
      tolerance: z.number().nullable().optional(),
      unit: z.string().nullable().optional(),
    }).parse(req.body)

    const question = await prisma.question.findFirst({
      where: {
        id: p(req.params.questionId),
        sessionId: p(req.params.sessionId),
        session: { class: { professorId: professor.id } },
      },
      include: { session: true },
    })
    if (!question) throw new AppError('Question not found', 404)

    const updateData: Record<string, unknown> = {}

    if (body.correctAnswer !== undefined) {
      const bypassClosedCheck = ['NUMERIC', 'ORDERING', 'STRUCTURE'].includes(question.type as string)
      if (!bypassClosedCheck && !['DRAFT', 'CLOSED', 'ARCHIVED'].includes(question.session.status))
        throw new AppError('Cannot set answer key while session is open', 400)
      const ca = body.correctAnswer
      if (ca !== null) {
        if (question.type === 'YES_NO' && !['Yes', 'No'].includes(ca))
          throw new AppError('YES_NO correctAnswer must be "Yes" or "No"', 400)
        if (question.type === 'MULTIPLE_CHOICE') {
          const opts = (question.options as string[] | null) ?? []
          if (!opts.includes(ca))
            throw new AppError('correctAnswer must be one of the question options', 400)
        }
        if (question.type === 'RATING')
          throw new AppError('Cannot set correct answer for rating questions', 400)
        if ((question.type as string) === 'NUMERIC' && isNaN(parseFloat(ca)))
          throw new AppError('NUMERIC correctAnswer must be a valid number', 400)
        if ((question.type as string) === 'MULTI_SELECT') {
          let arr: unknown
          try { arr = JSON.parse(ca) } catch { throw new AppError('MULTI_SELECT correctAnswer must be a JSON array', 400) }
          if (!Array.isArray(arr)) throw new AppError('MULTI_SELECT correctAnswer must be a JSON array', 400)
          const opts = (question.options as string[] | null) ?? []
          if (!(arr as string[]).every(v => opts.includes(v)))
            throw new AppError('MULTI_SELECT correctAnswer values must be among the question options', 400)
        }
        if ((question.type as string) === 'ORDERING') {
          let arr: unknown
          try { arr = JSON.parse(ca) } catch { throw new AppError('ORDERING correctAnswer must be a JSON array', 400) }
          if (!Array.isArray(arr)) throw new AppError('ORDERING correctAnswer must be a JSON array', 400)
          const opts = new Set((question.options as string[] | null) ?? [])
          if ((arr as string[]).length !== opts.size || !(arr as string[]).every(v => opts.has(v)))
            throw new AppError('ORDERING correctAnswer must contain exactly the question options', 400)
        }
      }
      updateData.correctAnswer = ca
    }

    if (body.tolerance !== undefined) updateData.tolerance = body.tolerance
    if (body.unit !== undefined) updateData.unit = body.unit

    if (body.groupId !== undefined) {
      if (body.groupId !== null) {
        const group = await prisma.questionGroup.findFirst({
          where: { id: body.groupId, sessionId: question.sessionId },
        })
        if (!group) throw new AppError('Group not found in this session', 404)
      }
      updateData.groupId = body.groupId
    }

    const updated = await prisma.question.update({
      where: { id: question.id },
      data: updateData,
    })
    res.json({ success: true, data: { question: updated } })
  } catch (err) {
    next(err)
  }
})

// Delete a question (DRAFT only)
router.delete('/sessions/:sessionId/questions/:questionId', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const question = await prisma.question.findFirst({
      where: {
        id: p(req.params.questionId),
        sessionId: p(req.params.sessionId),
        session: { class: { professorId: professor.id } },
      },
      include: { session: { select: { status: true } } },
    })
    if (!question) throw new AppError('Question not found', 404)
    if (question.session.status !== 'DRAFT') throw new AppError('Can only delete questions while session is in DRAFT', 400)
    await prisma.question.delete({ where: { id: question.id } })
    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

// Bulk reorder questions
router.put('/sessions/:id/questions/reorder', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const items = z.array(z.object({ id: z.string(), order: z.number().int() })).parse(req.body)

    const session = await prisma.session.findFirst({
      where: { id: p(req.params.id), class: { professorId: professor.id } },
    })
    if (!session) throw new AppError('Session not found', 404)

    await prisma.$transaction(
      items.map(({ id, order }) =>
        prisma.question.updateMany({ where: { id, sessionId: session.id }, data: { order } })
      )
    )
    res.json({ success: true, data: null })
  } catch (err) {
    next(err)
  }
})

// Bulk reorder groups
router.put('/sessions/:id/groups/reorder', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const items = z.array(z.object({ id: z.string(), order: z.number().int() })).parse(req.body)

    const session = await prisma.session.findFirst({
      where: { id: p(req.params.id), class: { professorId: professor.id } },
    })
    if (!session) throw new AppError('Session not found', 404)

    await prisma.$transaction(
      items.map(({ id, order }) =>
        prisma.questionGroup.updateMany({ where: { id, sessionId: session.id }, data: { order } })
      )
    )
    res.json({ success: true, data: null })
  } catch (err) {
    next(err)
  }
})

// AI-grade all responses for a FREE_TEXT question
router.post('/sessions/:sessionId/questions/:questionId/grade', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor

    const question = await prisma.question.findFirst({
      where: {
        id: p(req.params.questionId),
        sessionId: p(req.params.sessionId),
        session: { class: { professorId: professor.id } },
      },
      include: {
        session: true,
        responses: { include: { student: { select: { id: true, netId: true, name: true } } } },
      },
    })
    if (!question) throw new AppError('Question not found', 404)
    if (question.type !== 'FREE_TEXT') throw new AppError('AI grading only applies to FREE_TEXT questions', 400)
    if (!['CLOSED', 'ARCHIVED'].includes(question.session.status))
      throw new AppError('Session must be closed before grading', 400)
    if (question.responses.length === 0) throw new AppError('No responses to grade', 400)

    const responseList = question.responses
      .map((r, i) => `[${i}] ${r.responseText}`)
      .join('\n')

    const n = question.responses.length
    const rubricLine = question.correctAnswer
      ? `\nReference answer (what the professor was looking for): "${question.correctAnswer}"\n`
      : ''

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: `You are grading student responses to a classroom question for participation credit. Judge whether each student engaged with the right concept — not whether they stated it perfectly.
${rubricLine}
Question: "${question.text}"

Student responses (${n} total, indexed 0 to ${n - 1}):
${responseList}

Grade each response:
- full_credit: makes sense — the student engaged with the relevant concept, even if their wording or details aren't perfect
- partial_credit: almost there — clearly trying but vague, confused, or only partly on the right track
- no_credit: didn't engage — off-topic, trivial (e.g. "it's bad for you"), restating the question, "idk", single word, or no real thought

IMPORTANT: You MUST return exactly ${n} objects — one for every index from 0 to ${n - 1}. Do not skip any.
Return a JSON array only, no other text:
[{"index": 0, "score": "full_credit" | "partial_credit" | "no_credit", "reason": "one short sentence"}, ...]`,
        },
      ],
    })

    const raw = msg.content.find((b) => b.type === 'text')?.text ?? '[]'
    const cleanText = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
    let parsed: { index: number; score: string; reason: string }[]
    try { parsed = JSON.parse(cleanText) } catch { parsed = [] }

    // Build a map so we can detect any indices Claude skipped
    const gradeMap = new Map(parsed.map((g) => [g.index, g]))

    const graded = (
      await Promise.all(
        question.responses.map(async (resp, index) => {
          const g = gradeMap.get(index)
          const score = g?.score ?? 'full_credit' // default to full credit if Claude skipped
          const reason = g?.reason ?? 'Not individually graded'
          const aiScore = score === 'no_credit' ? 0 : score === 'partial_credit' ? 0.5 : 1.0
          await prisma.response.update({ where: { id: resp.id }, data: { aiScore } })
          return { id: resp.id, studentId: resp.studentId, aiScore, reason }
        })
      )
    ).filter((r): r is NonNullable<typeof r> => r !== null)

    res.json({ success: true, data: { grades: graded } })
  } catch (err) {
    next(err)
  }
})

// Professor manual override of a single response's aiScore
router.patch('/sessions/:sessionId/questions/:questionId/responses/:responseId', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const { aiScore } = z.object({ aiScore: z.number().min(0).max(1) }).parse(req.body)

    const question = await prisma.question.findFirst({
      where: {
        id: p(req.params.questionId),
        sessionId: p(req.params.sessionId),
        session: { class: { professorId: professor.id } },
      },
    })
    if (!question) throw new AppError('Question not found', 404)

    const response = await prisma.response.update({
      where: { id: p(req.params.responseId) },
      data: { aiScore },
    })
    res.json({ success: true, data: { response } })
  } catch (err) {
    next(err)
  }
})

router.post('/sessions/:sessionId/questions/:questionId/summarize', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const { sessionId, questionId } = req.params

    const question = await prisma.question.findFirst({
      where: {
        id: p(questionId),
        sessionId: p(sessionId),
        session: { class: { professorId: professor.id } },
      },
      include: { responses: true },
    })
    if (!question) throw new AppError('Question not found', 404)
    if (question.type !== 'FREE_TEXT') throw new AppError('Only free text questions can be summarized', 400)
    if (question.responses.length === 0) throw new AppError('No responses to summarize', 400)

    const responseTexts = question.responses.map((r, i) => `${i + 1}. ${r.responseText}`).join('\n')

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      messages: [
        {
          role: 'user',
          content: `You are analyzing student responses to a classroom question. Group the responses into 3-4 distinct themes or categories. For each category, give it a short label and a one-sentence description of what students in that group said. Be concise and objective.

Question asked: "${question.text}"

Student responses:
${responseTexts}

Return your answer as a JSON array with this exact shape:
[
  { "label": "Category name", "description": "What students in this group said", "count": number },
  ...
]

Only return the JSON array, no other text.`,
        },
      ],
    })

    const raw = message.content.find((b) => b.type === 'text')?.text ?? '[]'
    const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
    let categories: { label: string; description: string; count: number }[]
    try {
      categories = JSON.parse(text)
      if (!Array.isArray(categories)) throw new Error('not an array')
    } catch {
      throw new AppError('Failed to parse summary from AI', 500)
    }

    res.json({ success: true, data: { categories } })
  } catch (err) {
    next(err)
  }
})

// Submission status — who has/hasn't submitted (homework assignments)
router.get('/sessions/:id/submission-status', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const session = await prisma.session.findFirst({
      where: { id: p(req.params.id), class: { professorId: professor.id } },
      include: {
        questions: { select: { id: true } },
      },
    })
    if (!session) throw new AppError('Session not found', 404)

    const questionIds = session.questions.map((q) => q.id)
    const totalQuestions = questionIds.length

    const enrollments = await prisma.enrollment.findMany({
      where: { classId: session.classId },
      include: {
        student: { select: { id: true, name: true, netId: true } },
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

    // Sort: incomplete first, then by name
    students.sort((a, b) => {
      if (a.isComplete !== b.isComplete) return a.isComplete ? 1 : -1
      return a.student.name.localeCompare(b.student.name)
    })

    res.json({ success: true, data: { students, totalQuestions } })
  } catch (err) {
    next(err)
  }
})

export default router
