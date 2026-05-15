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
  type: z.enum(['FREE_TEXT', 'MULTIPLE_CHOICE', 'RATING', 'YES_NO']),
  options: z.array(z.string()).optional(),
  order: z.number().int().min(0),
})

const createSessionSchema = z.object({
  title: z.string().min(1),
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
      qrDataUrl: await generateQr(`${config.baseUrl}/q/${q.id}`),
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
        accessCode,
        questions: {
          create: body.questions.map((q, i) => ({
            text: q.text,
            type: q.type,
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

    const sessions = await prisma.session.findMany({
      where: { classId: cls.id },
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
    const { status } = z.object({ status: z.nativeEnum(SessionStatus) }).parse(req.body)

    const existing = await prisma.session.findFirst({
      where: { id: p(req.params.id), class: { professorId: professor.id } },
    })
    if (!existing) throw new AppError('Session not found', 404)

    const updated = await prisma.session.update({
      where: { id: p(req.params.id) },
      data: {
        status,
        closedAt: status === SessionStatus.CLOSED && !existing.closedAt ? new Date() : existing.closedAt,
      },
    })

    getIo().to(p(req.params.id)).emit('session_status', { status })
    res.json({ success: true, data: { session: updated } })
  } catch (err) {
    next(err)
  }
})

router.post('/sessions/:id/questions', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const { text, type, options } = z.object({
      text: z.string().min(1),
      type: z.enum(['FREE_TEXT', 'MULTIPLE_CHOICE', 'RATING', 'YES_NO']),
      options: z.array(z.string()).optional(),
    }).parse(req.body)

    const session = await prisma.session.findFirst({
      where: { id: p(req.params.id), class: { professorId: professor.id } },
      include: { questions: { orderBy: { order: 'desc' }, take: 1 } },
    })
    if (!session) throw new AppError('Session not found', 404)

    const nextOrder = (session.questions[0]?.order ?? -1) + 1
    const accessCode = await generateUniqueQuestionCode()

    const question = await prisma.question.create({
      data: {
        sessionId: session.id,
        text,
        type,
        options: options && options.length > 0 ? options : undefined,
        order: nextOrder,
        accessCode,
      },
    })

    const qrDataUrl = await generateQr(`${config.baseUrl}/q/${question.id}`)
    res.status(201).json({ success: true, data: { question: { ...question, qrDataUrl } } })
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
        return calcScore(q.type, q.correctAnswer, resp)
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

// Set / clear correct answer for MCQ or YES_NO
router.patch('/sessions/:sessionId/questions/:questionId', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const { correctAnswer } = z.object({ correctAnswer: z.string().nullable() }).parse(req.body)

    const question = await prisma.question.findFirst({
      where: {
        id: p(req.params.questionId),
        sessionId: p(req.params.sessionId),
        session: { class: { professorId: professor.id } },
      },
      include: { session: true },
    })
    if (!question) throw new AppError('Question not found', 404)
    if (!['CLOSED', 'ARCHIVED'].includes(question.session.status))
      throw new AppError('Session must be closed before grading', 400)
    if (correctAnswer !== null) {
      if (question.type === 'YES_NO' && !['Yes', 'No'].includes(correctAnswer))
        throw new AppError('YES_NO correctAnswer must be "Yes" or "No"', 400)
      if (question.type === 'MULTIPLE_CHOICE') {
        const opts = (question.options as string[] | null) ?? []
        if (!opts.includes(correctAnswer))
          throw new AppError('correctAnswer must be one of the question options', 400)
      }
      if (question.type === 'FREE_TEXT' || question.type === 'RATING')
        throw new AppError('Cannot set correct answer for this question type', 400)
    }

    const updated = await prisma.question.update({
      where: { id: question.id },
      data: { correctAnswer },
    })
    res.json({ success: true, data: { question: updated } })
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

    const graded = await Promise.all(
      question.responses.map(async (resp) => {
        const msg = await anthropic.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 256,
          messages: [
            {
              role: 'user',
              content: `You are grading a student's free-text response to a classroom question. Be strict but fair.

Question: "${question.text}"
Student response: "${resp.responseText}"

Assess whether the response demonstrates genuine understanding of the concept.
- full_credit: correct and shows understanding
- partial_credit: partially correct, vague, or on the right track but incomplete
- no_credit: wrong, irrelevant, or no real effort (e.g. "idk", "bad", very short with no substance)

Return JSON only, no other text: {"score": "full_credit" | "partial_credit" | "no_credit", "reason": "one short sentence"}`,
            },
          ],
        })
        const text = msg.content.find((b) => b.type === 'text')?.text ?? '{}'
        let parsed: { score: string; reason: string }
        try { parsed = JSON.parse(text) } catch { parsed = { score: 'full_credit', reason: 'Parse error' } }
        const aiScore = parsed.score === 'no_credit' ? 0 : parsed.score === 'partial_credit' ? 0.5 : 1.0
        await prisma.response.update({ where: { id: resp.id }, data: { aiScore } })
        return { id: resp.id, studentId: resp.studentId, aiScore, reason: parsed.reason }
      })
    )

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
      max_tokens: 1024,
      thinking: { type: 'adaptive' },
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

    const text = message.content.find((b) => b.type === 'text')?.text ?? '[]'
    let categories: { label: string; description: string; count: number }[]
    try {
      categories = JSON.parse(text)
    } catch {
      throw new AppError('Failed to parse summary from AI', 500)
    }

    res.json({ success: true, data: { categories } })
  } catch (err) {
    next(err)
  }
})

export default router
