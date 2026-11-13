/**
 * Scanned quiz pages: upload, progress, images, fixing a version, retrying, deleting.
 * Professor-only; every image is checked against the requesting professor.
 */
import { Router, Request, Response, NextFunction } from 'express'
import multer from 'multer'
import os from 'os'
import fs from 'fs/promises'
import path from 'path'
import { z } from 'zod'
import { prisma } from '../db/index.js'
import { AppError } from '../middleware/error.middleware.js'
import { requireProfessor, ProfessorRequest } from '../middleware/auth.middleware.js'
import { ownedQuizContent } from '../utils/ownership.js'
import { p } from '../utils/params.js'
import { assessmentSchema } from '../quizGrader/content.js'
import { parseSource } from '../quizGrader/store.js'
import {
  createDocument, deleteDocument, originalFile, pageDir, removeBatchFiles, specFor, visionConfigured, visionHealthy, VisionError,
} from '../quizGrader/scans.js'
import { gradingConfigured, rescoreAssessment, secondLooksRunning, startSecondLooks } from '../quizGrader/grading.js'
import { costOf } from '../quizGrader/pricing.js'
import { scanStorageWarnings } from '../quizGrader/servers.js'
import { compare, type ResultRow } from '../quizGrader/compare.js'
import { effectiveResults, pageTotals } from '../quizGrader/review.js'

const router = Router()

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 300 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.mimetype.startsWith('image/')) cb(null, true)
    else cb(new AppError('Upload a PDF or a photo.', 400))
  },
})

const viewer = (req: Request) => (req as ProfessorRequest).professor

async function ownedBatch(req: Request, id: string) {
  const batch = await prisma.quizBatch.findFirst({ where: { id, professorId: viewer(req).id } })
  if (!batch) throw new AppError('Not found', 404)
  return batch
}

async function ownedPage(req: Request) {
  const page = await prisma.quizPage.findFirst({
    where: { id: p(req.params.pageId), batch: { professorId: viewer(req).id } },
    include: { batch: { select: { assessmentId: true } } },
  })
  if (!page) throw new AppError('Not found', 404)
  return page
}

const counts = (pages: { status: string }[]) =>
  pages.reduce<Record<string, number>>((acc, pg) => ({ ...acc, [pg.status]: (acc[pg.status] ?? 0) + 1 }), {})

// Is scanning available, and is the vision service answering?
router.get('/quiz-grader/vision', requireProfessor, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const configured = visionConfigured()
    res.json({
      success: true,
      data: { configured, healthy: configured ? await visionHealthy() : false, grading: gradingConfigured(), storage: await scanStorageWarnings() },
    })
  } catch (err) {
    next(err)
  }
})

// Upload a scanned PDF or a photo to an assessment.
router.post('/quiz-grader/content/:id/batches', requireProfessor, upload.single('file'), async (req: Request, res: Response, next: NextFunction) => {
  const file = req.file
  try {
    if (!file) throw new AppError('Choose a PDF or a photo to upload.', 400)
    if (!visionConfigured()) throw new AppError('Scanning is not set up on this server yet (the vision service).', 503)
    const assessment = await prisma.quizContent.findFirst({ where: { id: p(req.params.id), ...ownedQuizContent(viewer(req)) }, omit: { pdf: true } })
    if (!assessment || assessment.kind !== 'ASSESSMENT') throw new AppError('Upload scans to an assessment.', 400)
    if (!assessmentSchema.safeParse(parseSource(assessment.source)).success) throw new AppError('Fix this assessment’s problems first.', 400)
    try {
      await specFor(assessment.id) // fails early if the key, layout or blank PDF is missing
    } catch (e) {
      throw new AppError((e as Error).message, 400)
    }

    let doc: { id: string; pages: number }
    try {
      doc = await createDocument(file.path, file.originalname)
    } catch (e) {
      throw new AppError(e instanceof VisionError && e.status === 400 ? 'That file could not be read as a PDF or an image.' : (e as Error).message, e instanceof VisionError && e.status === 400 ? 400 : 502)
    }
    const batch = await prisma.quizBatch.create({
      data: {
        professorId: viewer(req).id,
        assessmentId: assessment.id,
        fileName: file.originalname.slice(0, 200),
        visionDocId: doc.id,
        pageCount: doc.pages,
        pages: { create: Array.from({ length: doc.pages }, (_, index) => ({ index })) },
      },
    })
    res.status(201).json({ success: true, data: { id: batch.id, pageCount: batch.pageCount } })
  } catch (err) {
    next(err)
  } finally {
    if (file) await fs.rm(file.path, { force: true }).catch(() => undefined)
  }
})

// An assessment's uploads, with how far along each is.
router.get('/quiz-grader/content/:id/batches', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const batches = await prisma.quizBatch.findMany({
      where: { assessmentId: p(req.params.id), professorId: viewer(req).id },
      include: { pages: { select: { status: true } } },
      orderBy: { createdAt: 'desc' },
    })
    res.json({
      success: true,
      data: { batches: batches.map(({ pages, ...b }) => ({ ...b, counts: counts(pages) })) },
    })
  } catch (err) {
    next(err)
  }
})

// One upload's pages.
router.get('/quiz-grader/batches/:batchId', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const batch = await ownedBatch(req, p(req.params.batchId))
    const pages = await prisma.quizPage.findMany({ where: { batchId: batch.id }, orderBy: { index: 'asc' }, omit: { reads: true, usage: true } })
    // Scores after review decisions; toReview is what is still undecided.
    const totals = pageTotals((await effectiveResults({ assessmentId: batch.assessmentId })).filter((r) => r.page.batchId === batch.id))
    res.json({
      success: true,
      data: {
        ...batch,
        counts: counts(pages),
        pages: pages.map((pg) => {
          const t = totals.get(pg.id)
          return t ? { ...pg, pointsFinal: t.points, toReview: t.open } : { ...pg, pointsFinal: null }
        }),
      },
    })
  } catch (err) {
    next(err)
  }
})

router.delete('/quiz-grader/batches/:batchId', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const batch = await ownedBatch(req, p(req.params.batchId))
    await prisma.quizBatch.delete({ where: { id: batch.id } })
    if (batch.visionDocId) await deleteDocument(batch.visionDocId)
    await removeBatchFiles(batch.id)
    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

// One page, with the boxes it was cropped to (for drawing them over the aligned image).
router.get('/quiz-grader/pages/:pageId', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = await ownedPage(req)
    let boxes: { id: string; box: number[] }[] = []
    let versions: string[] = []
    try {
      const spec = await specFor(page.batch.assessmentId)
      versions = spec.versions.map((v) => v.name)
      boxes = spec.versions.find((v) => v.name === page.version)?.boxes ?? []
    } catch { /* content changed since; the page still shows */ }
    const results = (await effectiveResults({ pageId: page.id })).map(({ page: _p, ...r }) => r)
    const t = pageTotals(results).get(page.id)
    const usage = (page.usage ?? []) as { model: string; input_tokens: number; output_tokens: number }[]
    res.json({
      success: true,
      data: { ...page, reads: undefined, versions, boxes, results, cost: costOf(usage).dollars, pointsFinal: t?.points ?? null, toReview: t ? t.open : page.toReview },
    })
  } catch (err) {
    next(err)
  }
})

// Page images: the upload, the aligned page, and one box's crop.
router.get('/quiz-grader/pages/:pageId/:kind(original|aligned)', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = await ownedPage(req)
    const file = req.params.kind === 'original'
      ? await originalFile(page.batchId, page.index)
      : path.join(pageDir(page.batchId, page.index), 'aligned.png')
    if (!file || !(await fs.stat(file).then(() => true, () => false))) {
      throw new AppError(page.status === 'DONE' || page.status === 'NEEDS_VERSION' ? 'This page\'s images are not on this server\'s disk' : 'Not processed yet', 404)
    }
    res.setHeader('Cache-Control', 'private, no-store')
    res.sendFile(file)
  } catch (err) {
    next(err)
  }
})

router.get('/quiz-grader/pages/:pageId/crops/:slotId', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = await ownedPage(req)
    const slot = p(req.params.slotId)
    if (!/^[\w-]+$/.test(slot)) throw new AppError('Bad slot', 400)
    const file = path.join(pageDir(page.batchId, page.index), `crop-${slot}.png`)
    if (!(await fs.stat(file).then(() => true, () => false))) throw new AppError('No crop for that box', 404)
    res.setHeader('Cache-Control', 'private, no-store')
    res.sendFile(file)
  } catch (err) {
    next(err)
  }
})

// Say which version a page is (detection was unsure or wrong); it is processed again.
router.post('/quiz-grader/pages/:pageId/version', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = await ownedPage(req)
    const { version } = z.object({ version: z.string().min(1).nullable() }).parse(req.body)
    if (version) {
      const spec = await specFor(page.batch.assessmentId).catch(() => null)
      if (!spec?.versions.some((v) => v.name === version)) throw new AppError(`No version "${version}"`, 400)
    }
    await prisma.quizPage.update({
      where: { id: page.id },
      data: { versionForced: version, status: 'PENDING', attempts: 0, error: null, gradeStatus: 'NONE' },
    })
    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

// Grade a page again with the model (after a failure). Cached reads are reused.
router.post('/quiz-grader/pages/:pageId/regrade', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = await ownedPage(req)
    if (page.status !== 'DONE') throw new AppError('The page has to be lined up first', 409)
    if (!gradingConfigured()) throw new AppError('Grading is not set up on this server (ANTHROPIC_API_KEY).', 503)
    await prisma.quizPage.update({ where: { id: page.id }, data: { gradeStatus: 'PENDING', gradeAttempts: 0, gradeError: null } })
    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

// Second looks at graded pages' unsure and near-miss readings (pages graded before
// second looks existed), in the background. Says how many pages are due.
router.post('/quiz-grader/content/:id/second-looks', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const a = await prisma.quizContent.findFirst({ where: { id: p(req.params.id), ...ownedQuizContent(viewer(req)), kind: 'ASSESSMENT' }, select: { id: true } })
    if (!a) throw new AppError('Not found', 404)
    if (!gradingConfigured()) throw new AppError('Grading is not set up on this server (ANTHROPIC_API_KEY).', 503)
    res.json({ success: true, data: await startSecondLooks(a.id) })
  } catch (err) {
    next(err)
  }
})

// Every page of an assessment with its score: the results table.
router.get('/quiz-grader/content/:id/results', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const assessment = await prisma.quizContent.findFirst({ where: { id: p(req.params.id), ...ownedQuizContent(viewer(req)), kind: 'ASSESSMENT' }, select: { id: true } })
    if (!assessment) throw new AppError('Not found', 404)
    const pages = await prisma.quizPage.findMany({
      where: { batch: { assessmentId: assessment.id } },
      select: {
        id: true, batchId: true, index: true, status: true, version: true, gradeStatus: true, gradeError: true,
        pointsAuto: true, maxPoints: true, toReview: true, usage: true, studentNetId: true, batch: { select: { fileName: true, createdAt: true } },
      },
      orderBy: [{ batch: { createdAt: 'asc' } }, { index: 'asc' }],
    })
    const usage = pages.flatMap((pg) => (pg.usage ?? []) as { model: string; input_tokens: number; output_tokens: number }[])
    const graded = pages.filter((pg) => pg.gradeStatus === 'GRADED')
    const effective = await effectiveResults({ assessmentId: assessment.id })
    const totals = pageTotals(effective)
    // Model calls by model (a cached re-read counts as a call but was not paid again), and
    // how second looks went: answers looked at, and how many still disagree.
    const byModel = new Map<string, typeof usage>()
    for (const u of usage) byModel.set(u.model, [...(byModel.get(u.model) ?? []), u])
    const looked = effective.filter((r) => (r.detail as { secondLook?: unknown } | null)?.secondLook)
    res.json({
      success: true,
      data: {
        pages: pages.map(({ usage: _u, batch, ...pg }) => {
          const t = totals.get(pg.id)
          return { ...pg, fileName: batch.fileName, pointsFinal: t?.points ?? null, toReview: t ? t.open : pg.toReview }
        }),
        summary: {
          secondLooksRunning: secondLooksRunning(assessment.id),
          pages: pages.length,
          graded: graded.length,
          grading: pages.filter((pg) => pg.gradeStatus === 'PENDING' || pg.gradeStatus === 'GRADING').length,
          failed: pages.filter((pg) => pg.gradeStatus === 'FAILED').length,
          toReview: graded.reduce((a, pg) => a + (totals.get(pg.id)?.open ?? 0), 0),
          cost: costOf(usage),
          models: [...byModel.entries()].map(([model, us]) => ({ model, calls: us.length, dollars: costOf(us).dollars }))
            .sort((a, b) => b.dollars - a.dollars),
          secondLooks: {
            answers: looked.length,
            disagree: looked.filter((r) => Array.isArray(r.reviewReasons) && (r.reviewReasons as string[]).some((x) => x.startsWith('second look'))).length,
          },
        },
      },
    })
  } catch (err) {
    next(err)
  }
})

// Grade every lined-up page not yet graded: pages uploaded before grading was set up,
// and pages whose grading failed.
router.post('/quiz-grader/content/:id/grade-ungraded', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const assessment = await prisma.quizContent.findFirst({ where: { id: p(req.params.id), ...ownedQuizContent(viewer(req)), kind: 'ASSESSMENT' }, select: { id: true } })
    if (!assessment) throw new AppError('Not found', 404)
    if (!gradingConfigured()) throw new AppError('Grading is not set up on this server (ANTHROPIC_API_KEY).', 503)
    const r = await prisma.quizPage.updateMany({
      where: { batch: { assessmentId: assessment.id }, status: 'DONE', gradeStatus: { in: ['NONE', 'FAILED'] } },
      data: { gradeStatus: 'PENDING', gradeAttempts: 0, gradeError: null },
    })
    res.json({ success: true, data: { queued: r.count } })
  } catch (err) {
    next(err)
  }
})

// Line up and crop every page again, then grade it: after the layout's boxes change. Review
// decisions are kept (they live apart from results). Model reads are cached per request, so
// a page whose crops did not change costs nothing; one that gained a box is read again.
router.post('/quiz-grader/content/:id/reprocess', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const assessment = await prisma.quizContent.findFirst({ where: { id: p(req.params.id), ...ownedQuizContent(viewer(req)), kind: 'ASSESSMENT' }, select: { id: true } })
    if (!assessment) throw new AppError('Not found', 404)
    const r = await prisma.quizPage.updateMany({
      where: { batch: { assessmentId: assessment.id }, status: { not: 'PROCESSING' } },
      data: { status: 'PENDING', attempts: 0, error: null, gradeStatus: 'NONE' },
    })
    res.json({ success: true, data: { queued: r.count } })
  } catch (err) {
    next(err)
  }
})

// Re-score every graded page against the key as it is now. No model calls.
router.post('/quiz-grader/content/:id/rescore', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const assessment = await prisma.quizContent.findFirst({ where: { id: p(req.params.id), ...ownedQuizContent(viewer(req)), kind: 'ASSESSMENT' }, select: { id: true } })
    if (!assessment) throw new AppError('Not found', 404)
    res.json({ success: true, data: { pages: await rescoreAssessment(assessment.id) } })
  } catch (err) {
    next(err)
  }
})

// Compare an upload's automatic scores with hand grades (a CSV like the spike's).
router.post('/quiz-grader/batches/:batchId/compare', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const batch = await ownedBatch(req, p(req.params.batchId))
    const { csv } = z.object({ csv: z.string().min(1).max(2_000_000) }).parse(req.body)
    const rows = await prisma.quizSlotResult.findMany({
      where: { page: { batchId: batch.id, gradeStatus: 'GRADED' } },
      include: { page: { select: { index: true } } },
    })
    const results: ResultRow[] = rows.map((r) => ({
      pageIndex: r.page.index, slotId: r.slotId, kind: r.kind, status: r.status, transcription: r.transcription,
      pointsAuto: r.pointsAuto, needsReview: r.needsReview, reviewReasons: r.reviewReasons as string[],
    }))
    res.json({ success: true, data: compare(results, csv) })
  } catch (err) {
    next(err)
  }
})

// Process a page again: after a failure, or after the layout's boxes changed.
router.post('/quiz-grader/pages/:pageId/retry', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = await ownedPage(req)
    if (page.status === 'PROCESSING') throw new AppError('Already being processed', 409)
    await prisma.quizPage.update({ where: { id: page.id }, data: { status: 'PENDING', attempts: 0, error: null, gradeStatus: 'NONE' } })
    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

export default router
