import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import Anthropic from '@anthropic-ai/sdk'
import { prisma } from '../db/index.js'
import { config } from '../config/index.js'
import { AppError } from '../middleware/error.middleware.js'
import { requireProfessor, ProfessorRequest } from '../middleware/auth.middleware.js'
import { p } from '../utils/params.js'

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey })

const router = Router()

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
        responses: { include: { student: { select: { id: true, netId: true } } } },
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

    const gradeMap = new Map(parsed.map((g) => [g.index, g]))

    const graded = (
      await Promise.all(
        question.responses.map(async (resp, index) => {
          const g = gradeMap.get(index)
          const score = g?.score ?? 'full_credit'
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

// AI summarize all responses for a FREE_TEXT question into themes
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
