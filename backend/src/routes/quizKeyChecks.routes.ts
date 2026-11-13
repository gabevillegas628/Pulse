/**
 * The professor's filled-in answer key, cut into drawings, and checks suggested from them.
 * The key is the professor's own work, not a student's; it is still served only to them.
 */
import express, { Router, Request, Response, NextFunction } from 'express'
import { Prisma } from '@prisma/client'
import { prisma } from '../db/index.js'
import { AppError } from '../middleware/error.middleware.js'
import { requireProfessor, ProfessorRequest } from '../middleware/auth.middleware.js'
import { ownedQuizContent } from '../utils/ownership.js'
import { p } from '../utils/params.js'
import { contextFor } from '../quizGrader/grading.js'
import { cutKeyDrawings, drawingsOutOfDate, structureBoxes, type KeyDrawingsData } from '../quizGrader/keyDrawings.js'
import { visionConfigured, VisionError } from '../quizGrader/scans.js'
import { startSuggestion, suggestJob } from '../quizGrader/suggest.js'

const router = Router()

async function ownedQuiz(req: Request) {
  const q = await prisma.quizContent.findFirst({
    where: { id: p(req.params.id), ...ownedQuizContent((req as ProfessorRequest).professor), kind: 'ASSESSMENT' },
    select: { id: true },
  })
  if (!q) throw new AppError('Not found', 404)
  return q
}

/** What the Key tab shows: which drawings were found, and what needs doing. */
async function summary(assessmentId: string) {
  const row = await prisma.quizKeyDrawings.findUnique({ where: { assessmentId }, select: { fileName: true, updatedAt: true, drawings: true } })
  if (!row) return null
  const ctx = await contextFor(assessmentId)
  const data = row.drawings as unknown as KeyDrawingsData | null
  const graded = new Set(Object.values(ctx.assessment.versions).flatMap((v) => v.structures))
  const boxed = new Set(structureBoxes(ctx.layout, ctx.key).map((b) => b.intermediate))
  return {
    fileName: row.fileName,
    uploadedAt: row.updatedAt,
    cutAt: data?.cutAt ?? null,
    pages: data?.pages ?? 0,
    notes: data?.notes ?? [],
    items: Object.entries(data?.items ?? {}).map(([id, d]) => ({ id, name: ctx.key.intermediates[id]?.name ?? id, slotId: d.slotId, page: d.page, graded: graded.has(id) })),
    // Boxes moved since the drawings were cut: cut again.
    outOfDate: data ? drawingsOutOfDate(data, ctx.layout, ctx.key) : [],
    // Graded drawings with no box to cut them out with.
    noBox: [...graded].filter((id) => !boxed.has(id)).map((id) => ctx.key.intermediates[id]?.name ?? id),
  }
}

const cutError = (e: unknown) => new AppError(e instanceof VisionError ? `The vision service: ${e.message}` : (e as Error).message, 400)

router.get('/quiz-grader/quizzes/:id/key-drawings', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = await ownedQuiz(req)
    res.json({ success: true, data: { drawings: await summary(q.id), vision: visionConfigured(), suggestion: suggestJob(q.id) } })
  } catch (err) {
    next(err)
  }
})

// Upload the filled-in key (PDF or photo) and cut it into drawings. Replaces any earlier one.
router.put(
  '/quiz-grader/quizzes/:id/key-drawings',
  requireProfessor,
  express.raw({ type: ['application/pdf', 'image/png', 'image/jpeg'], limit: '20mb' }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = await ownedQuiz(req)
      if (!visionConfigured()) throw new AppError('The vision service is not set up, so the key cannot be lined up.', 400)
      const bytes = req.body as Buffer
      if (!Buffer.isBuffer(bytes) || !bytes.length) throw new AppError('Send the file as the request body (a PDF, PNG or JPEG).', 400)
      const fileName = (typeof req.query.name === 'string' ? req.query.name : 'answer-key').slice(0, 200)
      await prisma.quizKeyDrawings.upsert({
        where: { assessmentId: q.id },
        create: { assessmentId: q.id, fileName, file: new Uint8Array(bytes) },
        update: { fileName, file: new Uint8Array(bytes), drawings: Prisma.DbNull },
      })
      try { await cutKeyDrawings(q.id) } catch (e) { throw cutError(e) }
      res.json({ success: true, data: await summary(q.id) })
    } catch (err) {
      next(err)
    }
  },
)

// Cut the stored key again: after boxes move.
router.post('/quiz-grader/quizzes/:id/key-drawings/cut', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = await ownedQuiz(req)
    if (!(await prisma.quizKeyDrawings.count({ where: { assessmentId: q.id } }))) throw new AppError('Upload the filled-in key first.', 400)
    try { await cutKeyDrawings(q.id) } catch (e) { throw cutError(e) }
    res.json({ success: true, data: await summary(q.id) })
  } catch (err) {
    next(err)
  }
})

router.delete('/quiz-grader/quizzes/:id/key-drawings', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = await ownedQuiz(req)
    await prisma.quizKeyDrawings.deleteMany({ where: { assessmentId: q.id } })
    res.json({ success: true, data: null })
  } catch (err) {
    next(err)
  }
})

// One intermediate's drawing, as cut from the key.
router.get('/quiz-grader/quizzes/:id/key-drawings/:intermediate.png', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = await ownedQuiz(req)
    const row = await prisma.quizKeyDrawings.findUnique({ where: { assessmentId: q.id }, select: { drawings: true } })
    const d = (row?.drawings as unknown as KeyDrawingsData | null)?.items[p(req.params.intermediate)]
    if (!d) throw new AppError('No drawing for that intermediate.', 404)
    res.setHeader('Content-Type', 'image/png')
    res.setHeader('Cache-Control', 'private, no-store')
    res.send(Buffer.from(d.png, 'base64'))
  } catch (err) {
    next(err)
  }
})

// Suggest checks: start, and see how it is going (and the result when done).
router.post('/quiz-grader/quizzes/:id/suggest-checks', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = await ownedQuiz(req)
    let job
    try { job = await startSuggestion(q.id) } catch (e) { throw new AppError((e as Error).message, 400) }
    res.status(202).json({ success: true, data: job })
  } catch (err) {
    next(err)
  }
})

router.get('/quiz-grader/quizzes/:id/suggest-checks', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = await ownedQuiz(req)
    res.json({ success: true, data: suggestJob(q.id) })
  } catch (err) {
    next(err)
  }
})

export default router
