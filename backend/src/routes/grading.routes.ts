import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import Anthropic from '@anthropic-ai/sdk'
import { prisma } from '../db/index.js'
import { config } from '../config/index.js'
import { AppError } from '../middleware/error.middleware.js'
import { requireProfessor, ProfessorRequest } from '../middleware/auth.middleware.js'
import { getIo } from '../socket.js'
import { logger } from '../utils/logger.js'
import { p } from '../utils/params.js'

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey })
const BATCH_SIZE = 25

const router = Router()

// ─── Types ────────────────────────────────────────────────────────────────────

type GradeResult = { id: string; studentId: string; aiScore: number; reason: string }
type ResponseRow = { id: string; studentId: string; responseText: string; aiScore?: number | null }

// ─── Core grading helpers ─────────────────────────────────────────────────────

async function gradeBatch(
  questionText: string,
  correctAnswer: string | null,
  responses: ResponseRow[]
): Promise<GradeResult[]> {
  const responseList = responses.map((r, i) => `[${i}] ${r.responseText}`).join('\n')
  const n = responses.length
  const rubricLine = correctAnswer
    ? `\nReference answer (what the professor was looking for): "${correctAnswer}"\n`
    : ''

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: `You are grading student responses to a classroom question for participation credit. Judge whether each student engaged with the right concept — not whether they stated it perfectly.
${rubricLine}
Question: "${questionText}"

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

  const gradeMap = new Map(parsed.map((g) => [g.index, g]))

  return Promise.all(
    responses.map(async (resp, index) => {
      const g = gradeMap.get(index)
      const score = g?.score ?? 'full_credit'
      const reason = g?.reason ?? 'Not individually graded'
      const aiScore = score === 'no_credit' ? 0 : score === 'partial_credit' ? 0.5 : 1.0
      await prisma.response.update({ where: { id: resp.id }, data: { aiScore } })
      return { id: resp.id, studentId: resp.studentId, aiScore, reason }
    })
  )
}

// Async batched grading — emits grade_progress and grade_complete via socket
async function runAiGradingAsync(
  questionId: string,
  questionText: string,
  correctAnswer: string | null,
  responses: ResponseRow[],
  socketRoom: string
) {
  const total = responses.length
  let processed = 0
  let failedCount = 0

  for (let i = 0; i < total; i += BATCH_SIZE) {
    const batch = responses.slice(i, i + BATCH_SIZE)
    try {
      const batchGrades = await gradeBatch(questionText, correctAnswer, batch)
      processed += batch.length
      getIo().to(socketRoom).emit('grade_progress', { questionId, graded: processed, total, batchGrades })
    } catch (err) {
      failedCount += batch.length
      processed += batch.length
      logger.error('Grade batch failed', { questionId, batchStart: i, error: err instanceof Error ? err.message : String(err) })
      getIo().to(socketRoom).emit('grade_progress', { questionId, graded: processed, total, batchGrades: [] })
    }
  }

  getIo().to(socketRoom).emit('grade_complete', { questionId, failedCount })
}

// Sync batched grading — returns all results at once (used for assignments)
async function runAiGradingSync(
  questionText: string,
  correctAnswer: string | null,
  responses: ResponseRow[]
): Promise<{ grades: GradeResult[]; failedCount: number }> {
  const grades: GradeResult[] = []
  let failedCount = 0

  for (let i = 0; i < responses.length; i += BATCH_SIZE) {
    const batch = responses.slice(i, i + BATCH_SIZE)
    try {
      grades.push(...await gradeBatch(questionText, correctAnswer, batch))
    } catch {
      failedCount += batch.length
    }
  }

  return { grades, failedCount }
}

// ─── AI summarize ─────────────────────────────────────────────────────────────

async function runAiSummarize(question: { text: string; responses: Array<{ responseText: string }> }) {
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
  return categories
}

// ─── Session grading routes ───────────────────────────────────────────────────

// Async: responds 202 immediately, grades in background via socket progress events
router.post('/sessions/:sessionId/questions/:questionId/grade', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const { mode } = z.object({
      mode: z.enum(['all', 'ungraded']).default('all'),
    }).parse(req.body)

    const question = await prisma.question.findFirst({
      where: {
        id: p(req.params.questionId),
        sessionId: p(req.params.sessionId),
        session: { class: { professorId: professor.id } },
      },
      include: {
        session: { include: { runs: { where: { status: { in: ['CLOSED', 'ARCHIVED'] } } } } },
        responses: { include: { student: { select: { id: true, netId: true } } } },
      },
    })
    if (!question) throw new AppError('Question not found', 404)
    if (question.type !== 'FREE_TEXT') throw new AppError('AI grading only applies to FREE_TEXT questions', 400)
    if (question.session!.runs.length === 0)
      throw new AppError('Session must have at least one closed run before grading', 400)

    const responses = mode === 'ungraded'
      ? question.responses.filter((r) => r.aiScore === null)
      : question.responses

    if (responses.length === 0) throw new AppError('No responses to grade', 400)

    const socketRoom = `${question.sessionId}:professor`
    res.status(202).json({ success: true, data: { total: responses.length } })

    runAiGradingAsync(question.id, question.text, question.correctAnswer, responses, socketRoom)
      .catch(() => {
        getIo().to(socketRoom).emit('grade_complete', { questionId: question.id, failedCount: responses.length })
      })
  } catch (err) {
    next(err)
  }
})

// Professor manual override of a single response's aiScore (session)
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

// AI summarize responses for a FREE_TEXT question in a session
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

    const categories = await runAiSummarize(question)
    res.json({ success: true, data: { categories } })
  } catch (err) {
    next(err)
  }
})

// ─── Assignment grading routes ─────────────────────────────────────────────────

// Sync batched grading for assignments (no socket connection on that page)
router.post('/assignments/:assignmentId/questions/:questionId/grade', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor

    const question = await prisma.question.findFirst({
      where: {
        id: p(req.params.questionId),
        assignmentId: p(req.params.assignmentId),
        assignment: { class: { professorId: professor.id } },
      },
      include: {
        assignment: true,
        responses: { include: { student: { select: { id: true, netId: true } } } },
      },
    })
    if (!question) throw new AppError('Question not found', 404)
    if (question.type !== 'FREE_TEXT') throw new AppError('AI grading only applies to FREE_TEXT questions', 400)
    if (!['CLOSED', 'ARCHIVED'].includes(question.assignment!.status))
      throw new AppError('Assignment must be closed before grading', 400)
    if (question.responses.length === 0) throw new AppError('No responses to grade', 400)

    const { grades, failedCount } = await runAiGradingSync(question.text, question.correctAnswer, question.responses)
    res.json({ success: true, data: { grades, failedCount } })
  } catch (err) {
    next(err)
  }
})

// Professor manual override of a single response's aiScore (assignment)
router.patch('/assignments/:assignmentId/questions/:questionId/responses/:responseId', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const { aiScore } = z.object({ aiScore: z.number().min(0).max(1) }).parse(req.body)

    const question = await prisma.question.findFirst({
      where: {
        id: p(req.params.questionId),
        assignmentId: p(req.params.assignmentId),
        assignment: { class: { professorId: professor.id } },
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

// AI summarize responses for a FREE_TEXT question in an assignment
router.post('/assignments/:assignmentId/questions/:questionId/summarize', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const { assignmentId, questionId } = req.params

    const question = await prisma.question.findFirst({
      where: {
        id: p(questionId),
        assignmentId: p(assignmentId),
        assignment: { class: { professorId: professor.id } },
      },
      include: { responses: true },
    })
    if (!question) throw new AppError('Question not found', 404)
    if (question.type !== 'FREE_TEXT') throw new AppError('Only free text questions can be summarized', 400)
    if (question.responses.length === 0) throw new AppError('No responses to summarize', 400)

    const categories = await runAiSummarize(question)
    res.json({ success: true, data: { categories } })
  } catch (err) {
    next(err)
  }
})

export default router
