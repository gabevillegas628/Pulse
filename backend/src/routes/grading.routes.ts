import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import Anthropic from '@anthropic-ai/sdk'
import { prisma } from '../db/index.js'
import { config } from '../config/index.js'
import { AppError } from '../middleware/error.middleware.js'
import { requireProfessor, ProfessorRequest } from '../middleware/auth.middleware.js'
import { Viewer, ownedAssignmentQuestion, ownedSessionQuestion } from '../utils/ownership.js'
import { getIo } from '../socket.js'
import { logger } from '../utils/logger.js'
import { p } from '../utils/params.js'
import { bootstrapThemeSet, readThemeSet, latestRunId, scheduleThemeWork } from '../services/themes.service.js'

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey })
const BATCH_SIZE = 25

const router = Router()

// ─── Types ────────────────────────────────────────────────────────────────────

type GradeResult = { id: string; studentId: string; aiScore: number; reason: string }
type ResponseRow = { id: string; studentId: string; responseText: string; aiScore?: number | null }

// ─── Core grading helpers ─────────────────────────────────────────────────────

/**
 * The two stances a professor can grade free text with.
 *
 * `understanding` is the original behaviour: did the answer engage with the right
 * concept. `effort` asks a different question entirely — did the student actually
 * attempt this, in which case being wrong costs nothing. The distinction exists
 * because professors were writing "give credit for trying" into the reference-answer
 * field, where the grader read it as content to match against rather than as policy.
 */
export function buildGradingPrompt(
  mode: 'understanding' | 'effort',
  questionText: string,
  correctAnswer: string | null,
  responseList: string,
  n: number
): string {
  const tail = `
IMPORTANT: You MUST return exactly ${n} objects — one for every index from 0 to ${n - 1}. Do not skip any.
Return a JSON array only, no other text:
[{"index": 0, "score": "full_credit" | "partial_credit" | "no_credit", "reason": "one short sentence"}, ...]`

  if (mode === 'effort') {
    // The reference answer still earns its place here: it is how the grader tells a
    // real attempt at THIS question from a fluent paragraph about something else.
    const topicLine = correctAnswer
      ? `\nWhat the question is about (context only — students are NOT graded on matching this): "${correctAnswer}"\n`
      : ''

    return `You are grading student responses to a classroom question ON EFFORT. The professor is not assessing whether students got it right. You are judging one thing: did this student genuinely attempt the question?

A wrong answer, a confused answer, and a misconception all earn FULL credit as long as the student really tried. Do not deduct for incorrectness, poor grammar, or brevity that still carries a real thought.
${topicLine}
Question: "${questionText}"

Student responses (${n} total, indexed 0 to ${n - 1}):
${responseList}

Grade each response:
- full_credit: a real attempt at this question. The student engaged with what was asked and put a genuine thought down, however wrong, incomplete, or clumsily worded. Confidently incorrect answers belong here.
- partial_credit: token effort. Something was typed, but it carries almost no thought: "idk" / "not sure" / "I don't know" (honest, but not an attempt), a bare word or two with no reasoning, or pure hedging with no content of its own.
- no_credit: not an attempt at all. Keyboard mashing ("abcde", "asdf", "aaaa"), gibberish, punctuation or filler alone, the question restated back with nothing added, text copied from the prompt, or an on-topic-sounding answer to a completely different question.

Judge effort by whether the text responds to THIS question. A fluent, well-written paragraph that does not actually address what was asked is no_credit, not full_credit. Length is not effort: one sincere sentence beats a padded paragraph.
${tail}`
  }

  const rubricLine = correctAnswer
    ? `\nReference answer (what the professor was looking for): "${correctAnswer}"\n`
    : ''

  return `You are grading student responses to a classroom question for participation credit. Judge whether each student engaged with the right concept — not whether they stated it perfectly.
${rubricLine}
Question: "${questionText}"

Student responses (${n} total, indexed 0 to ${n - 1}):
${responseList}

Grade each response:
- full_credit: makes sense — the student engaged with the relevant concept, even if their wording or details aren't perfect
- partial_credit: almost there — clearly trying but vague, confused, or only partly on the right track
- no_credit: didn't engage — off-topic, trivial (e.g. "it's bad for you"), restating the question, "idk", single word, or no real thought
${tail}`
}

async function gradeBatch(
  questionText: string,
  correctAnswer: string | null,
  responses: ResponseRow[],
  mode: 'understanding' | 'effort'
): Promise<GradeResult[]> {
  const responseList = responses.map((r, i) => `[${i}] ${r.responseText}`).join('\n')
  const n = responses.length

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: buildGradingPrompt(mode, questionText, correctAnswer, responseList, n),
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
      // Store the reason alongside the score: anything short of full credit gets
      // questioned eventually, and the socket event that used to carry it does not
      // survive a page reload.
      await prisma.response.update({ where: { id: resp.id }, data: { aiScore, aiReason: reason } })
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
  socketRoom: string,
  mode: 'understanding' | 'effort'
) {
  const total = responses.length
  let processed = 0
  let failedCount = 0

  for (let i = 0; i < total; i += BATCH_SIZE) {
    const batch = responses.slice(i, i + BATCH_SIZE)
    try {
      const batchGrades = await gradeBatch(questionText, correctAnswer, batch, mode)
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
  responses: ResponseRow[],
  mode: 'understanding' | 'effort'
): Promise<{ grades: GradeResult[]; failedCount: number }> {
  const grades: GradeResult[] = []
  let failedCount = 0

  for (let i = 0; i < responses.length; i += BATCH_SIZE) {
    const batch = responses.slice(i, i + BATCH_SIZE)
    try {
      grades.push(...await gradeBatch(questionText, correctAnswer, batch, mode))
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
        ...ownedSessionQuestion(professor),
      },
      include: {
        session: {
          include: {
            runs: { where: { status: { in: ['CLOSED', 'ARCHIVED'] } } },
            class: { select: { effortGradingDefault: true } },
          },
        },
        responses: { include: { student: { select: { id: true, netId: true } } } },
      },
    })
    if (!question) throw new AppError('Question not found', 404)
    if (question.type !== 'FREE_TEXT') throw new AppError('AI grading only applies to FREE_TEXT questions', 400)
    if (question.session!.runs.length === 0)
      throw new AppError('Session must have at least one closed run before grading', 400)

    const gradingMode = (question.effortGrading ?? question.session!.class.effortGradingDefault)
      ? 'effort' as const
      : 'understanding' as const

    const responses = mode === 'ungraded'
      ? question.responses.filter((r) => r.aiScore === null)
      : question.responses

    if (responses.length === 0) throw new AppError('No responses to grade', 400)

    const socketRoom = `${question.sessionId}:professor`
    res.status(202).json({ success: true, data: { total: responses.length } })

    runAiGradingAsync(question.id, question.text, question.correctAnswer, responses, socketRoom, gradingMode)
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
        ...ownedSessionQuestion(professor),
      },
    })
    if (!question) throw new AppError('Question not found', 404)

    const response = await prisma.response.update({
      where: { id: p(req.params.responseId) },
      // Clear the AI reason: it justified the grader's score, not the one just set by hand.
      data: { aiScore, aiReason: null },
    })
    res.json({ success: true, data: { response } })
  } catch (err) {
    next(err)
  }
})

// ─── Session themes (live AI categorisation) ──────────────────────────────────

/** Load a session question the professor owns, for the theme routes. */
async function findOwnedSessionQuestion(sessionId: string, questionId: string, viewer: Viewer) {
  const question = await prisma.question.findFirst({
    where: {
      id: p(questionId),
      sessionId: p(sessionId),
      ...ownedSessionQuestion(viewer),
    },
    select: { id: true, text: true, type: true, sessionId: true },
  })
  if (!question) throw new AppError('Question not found', 404)
  if (question.type !== 'FREE_TEXT') throw new AppError('Only free text questions can be summarized', 400)
  return question
}

/**
 * Derive and persist categories for a question. This is the professor's explicit
 * "summarize" action, so it runs whether or not automatic theming is enabled for the
 * question — the `liveThemes` toggle governs the unattended path, not this one.
 *
 * Themes are keyed to the session's most recent run: a re-run of the same session
 * starts from a clean set rather than blending two lectures' answers.
 */
router.post('/sessions/:sessionId/questions/:questionId/summarize', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const question = await findOwnedSessionQuestion(p(req.params.sessionId), p(req.params.questionId), professor)

    const runId = await latestRunId(question.sessionId!)
    if (!runId) throw new AppError('Session has not been run yet', 400)

    const themes = await bootstrapThemeSet(question.id, runId, question.text)

    // Bootstrap clusters from a capped sample, so on a large class most answers are not
    // assigned yet. Hand the remainder to the batched worker rather than holding the
    // request open for a minute — it fills the counts in and pushes them over the socket.
    if (themes.classified < themes.total) {
      scheduleThemeWork(question.id, runId, question.sessionId!)
    }

    // `categories` keeps the old key so existing callers keep working; the entries are a
    // superset of SummaryCategory, carrying an id and isOther as well.
    res.json({ success: true, data: { categories: themes.categories, themes } })
  } catch (err) {
    next(err)
  }
})

// Read persisted themes. This is what makes a summary survive a page reload.
router.get('/sessions/:sessionId/questions/:questionId/themes', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const question = await findOwnedSessionQuestion(p(req.params.sessionId), p(req.params.questionId), professor)

    const runId = await latestRunId(question.sessionId!)
    if (!runId) return res.json({ success: true, data: { themes: null } })

    const themes = await readThemeSet(question.id, runId)
    res.json({ success: true, data: { themes } })
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
        ...ownedAssignmentQuestion(professor),
      },
      include: {
        assignment: { include: { class: { select: { effortGradingDefault: true } } } },
        responses: { include: { student: { select: { id: true, netId: true } } } },
      },
    })
    if (!question) throw new AppError('Question not found', 404)
    if (question.type !== 'FREE_TEXT') throw new AppError('AI grading only applies to FREE_TEXT questions', 400)
    if (!['CLOSED', 'ARCHIVED'].includes(question.assignment!.status))
      throw new AppError('Assignment must be closed before grading', 400)
    if (question.responses.length === 0) throw new AppError('No responses to grade', 400)

    const mode = (question.effortGrading ?? question.assignment!.class.effortGradingDefault)
      ? 'effort' as const
      : 'understanding' as const

    const { grades, failedCount } = await runAiGradingSync(question.text, question.correctAnswer, question.responses, mode)
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
        ...ownedAssignmentQuestion(professor),
      },
    })
    if (!question) throw new AppError('Question not found', 404)

    const response = await prisma.response.update({
      where: { id: p(req.params.responseId) },
      // Clear the AI reason: it justified the grader's score, not the one just set by hand.
      data: { aiScore, aiReason: null },
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
        ...ownedAssignmentQuestion(professor),
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
