/**
 * Quiz grader content: answer keys, layouts and assessments, kept as YAML.
 * Professor-only. See docs/quiz-grader/README.md.
 */
import express, { Router, Request, Response, NextFunction } from 'express'
import { PDFDocument } from 'pdf-lib'
import { z } from 'zod'
import type { QuizContent } from '@prisma/client'
import { prisma } from '../db/index.js'
import { AppError, isUniqueViolation } from '../middleware/error.middleware.js'
import { requireProfessor, ProfessorRequest } from '../middleware/auth.middleware.js'
import { ownedQuizContent } from '../utils/ownership.js'
import { p } from '../utils/params.js'
import { patchYaml } from '../quizGrader/yamlPatch.js'
import { printablePdf } from '../quizGrader/print.js'
import { assessmentSchema, versionPage } from '../quizGrader/content.js'
import {
  ContentError, KIND_LABEL, crossCheck, dependents, kindOf, parseSource, schemaIssues, slugOf, starterFiles, starterPdf, titleOf, validate,
  type Raw,
} from '../quizGrader/store.js'

const router = Router()

/** A bad file is the author's to fix, so it is a 400 with their problem in it. */
function asAppError(e: unknown): unknown {
  return e instanceof ContentError ? new AppError(e.message, 400) : e
}

/** A row without its PDF bytes, which only the PDF and print routes need. */
type Row = Omit<QuizContent, 'pdf'> & { hasPdf: boolean }

/** The summary the list shows, and the editor's header. */
function summary(row: Row, all: Row[]) {
  let raw: Raw | null = null
  let issues: string[]
  try {
    raw = parseSource(row.source)
    issues = schemaIssues(row.kind, raw)
  } catch (e) {
    issues = [(e as Error).message]
  }
  return {
    id: row.id,
    kind: row.kind,
    slug: row.slug,
    title: raw ? titleOf(row.kind, raw) : row.slug,
    updatedAt: row.updatedAt,
    hasPdf: row.hasPdf,
    issues,
    warnings: issues.length ? [] : [...pdfWarnings(row, all), ...crossCheck(row, all)],
  }
}

/** Printing needs the layout's blank form. */
function pdfWarnings(row: Row, all: Row[]): string[] {
  if (row.kind === 'LAYOUT') return row.hasPdf ? [] : ['No blank PDF uploaded yet, so it cannot be printed or drawn on.']
  if (row.kind !== 'ASSESSMENT') return []
  let layoutSlug: unknown
  try { layoutSlug = parseSource(row.source).layout } catch { return [] }
  const layout = all.find((r) => r.kind === 'LAYOUT' && r.slug === layoutSlug)
  return layout && !layout.hasPdf ? [`Layout "${layout.slug}" has no blank PDF, so this cannot be printed yet.`] : []
}

async function loadAll(professorId: string): Promise<Row[]> {
  const [rows, withPdf] = await Promise.all([
    prisma.quizContent.findMany({ where: { professorId }, omit: { pdf: true }, orderBy: [{ kind: 'asc' }, { slug: 'asc' }] }),
    prisma.quizContent.findMany({ where: { professorId, pdf: { not: null } }, select: { id: true } }),
  ])
  const has = new Set(withPdf.map((r) => r.id))
  return rows.map((r) => ({ ...r, hasPdf: has.has(r.id) }))
}

async function loadOne(req: Request): Promise<Row> {
  const professor = (req as ProfessorRequest).professor
  const row = await prisma.quizContent.findFirst({ where: { id: p(req.params.id), ...ownedQuizContent(professor) }, omit: { pdf: true } })
  if (!row) throw new AppError('Not found', 404)
  const withPdf = await prisma.quizContent.count({ where: { id: row.id, pdf: { not: null } } })
  return { ...row, hasPdf: withPdf > 0 }
}

// List everything, with problems and warnings for each.
router.get('/quiz-grader/content', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const all = await loadAll((req as ProfessorRequest).professor.id)
    res.json({ success: true, data: { items: all.map((r) => summary(r, all)) } })
  } catch (err) {
    next(err)
  }
})

// One item: its YAML, and its parsed form for the editor.
router.get('/quiz-grader/content/:id', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const row = await loadOne(req)
    const all = await loadAll(row.professorId)
    let data: Raw | null = null
    try { data = parseSource(row.source) } catch { /* summary carries the error */ }
    res.json({ success: true, data: { ...summary(row, all), source: row.source, data } })
  } catch (err) {
    next(err)
  }
})

// The YAML file, as a download. Byte-for-byte what was imported, plus any edits.
router.get('/quiz-grader/content/:id/yaml', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const row = await loadOne(req)
    res.setHeader('Content-Type', 'application/yaml; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${row.slug.replace(/[^\w.-]/g, '_')}.yaml"`)
    res.send(row.source)
  } catch (err) {
    next(err)
  }
})

// Import a YAML file. Its kind and name come from the file itself. With replace, an
// existing item of the same kind and name is overwritten; without, that is a 409.
router.post('/quiz-grader/content', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const { source, replace } = z.object({ source: z.string().min(1).max(500_000), replace: z.boolean().default(false) }).parse(req.body)
    const raw = parseSource(source)
    const kind = kindOf(raw)
    validate(kind, raw)
    const slug = slugOf(kind, raw)

    const existing = await prisma.quizContent.findUnique({ where: { professorId_kind_slug: { professorId: professor.id, kind, slug } } })
    if (existing && !replace) {
      throw new AppError(`You already have a ${KIND_LABEL[kind]} named "${slug}". Import it again with "replace" to overwrite it.`, 409, 'QUIZ_CONTENT_EXISTS')
    }
    const saved = existing
      ? await prisma.quizContent.update({ where: { id: existing.id }, data: { source }, select: { id: true } })
      : await prisma.quizContent.create({ data: { professorId: professor.id, kind, slug, source }, select: { id: true } })
    const all = await loadAll(professor.id)
    res.status(existing ? 200 : 201).json({ success: true, data: summary(all.find((r) => r.id === saved.id)!, all) })
  } catch (err) {
    next(isUniqueViolation(err) ? new AppError('That name was taken a moment ago; try again.', 409) : asAppError(err))
  }
})

// Save an edit. The body is the whole edited item, as GET returned it in `data`; only
// the YAML text that changed is rewritten, so comments and formatting elsewhere stay.
router.put('/quiz-grader/content/:id', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const row = await loadOne(req)
    const { data, updatedAt } = z.object({
      data: z.record(z.unknown()),
      /** The version the editor loaded, so a save cannot silently undo someone else's. */
      updatedAt: z.string().datetime().optional(),
    }).parse(req.body)
    if (updatedAt && new Date(updatedAt).getTime() !== row.updatedAt.getTime()) {
      throw new AppError('This was changed since you opened it. Reload to see the latest version.', 409, 'QUIZ_CONTENT_STALE')
    }
    if (kindOf(data) !== row.kind) throw new AppError(`This is a ${KIND_LABEL[row.kind]}; the edit is not.`, 400)
    validate(row.kind, data)

    const all = await loadAll(row.professorId)
    const slug = slugOf(row.kind, data)
    if (slug !== row.slug) {
      const users = dependents(row, all)
      if (users.length) throw new AppError(`Renaming would break ${users.join(', ')}, which use${users.length === 1 ? 's' : ''} "${row.slug}".`, 409)
    }

    const { text, method } = patchYaml(row.source, data)
    const saved = method === 'unchanged'
      ? row
      : { ...(await prisma.quizContent.update({ where: { id: row.id }, data: { source: text, slug }, omit: { pdf: true } })), hasPdf: row.hasPdf }
    const after = all.map((r) => (r.id === saved.id ? saved : r))
    res.json({ success: true, data: { ...summary(saved, after), source: saved.source, data: parseSource(saved.source), method } })
  } catch (err) {
    next(isUniqueViolation(err) ? new AppError('Another item already has that name.', 409) : asAppError(err))
  }
})

// Delete, unless an assessment still uses it.
router.delete('/quiz-grader/content/:id', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const row = await loadOne(req)
    const users = dependents(row, await loadAll(row.professorId))
    if (users.length) throw new AppError(`Still used by ${users.join(', ')}. Delete or change ${users.length === 1 ? 'that' : 'those'} first.`, 409)
    const scans = await prisma.quizBatch.count({ where: { assessmentId: row.id } })
    if (scans) throw new AppError(`This assessment has ${scans} upload${scans > 1 ? 's' : ''} of scans. Delete ${scans > 1 ? 'them' : 'it'} first.`, 409)
    await prisma.quizContent.delete({ where: { id: row.id } })
    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

// Load the glycolysis and TCA starter content, skipping anything already there by name.
router.post('/quiz-grader/starter', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const added: string[] = []
    const skipped: string[] = []
    for (const { file, source } of await starterFiles()) {
      const raw = parseSource(source)
      const kind = kindOf(raw)
      const slug = slugOf(kind, raw)
      const pdf = kind === 'LAYOUT' ? await starterPdf(raw) : null
      const exists = await prisma.quizContent.findUnique({
        where: { professorId_kind_slug: { professorId: professor.id, kind, slug } },
        select: { id: true, pdf: true },
      })
      if (exists) {
        // An existing starter layout without its PDF (loaded before PDFs were kept) gets one.
        if (pdf && !exists.pdf) await prisma.quizContent.update({ where: { id: exists.id }, data: { pdf: new Uint8Array(pdf) } })
        skipped.push(file)
        continue
      }
      await prisma.quizContent.create({ data: { professorId: professor.id, kind, slug, source, ...(pdf ? { pdf: new Uint8Array(pdf) } : {}) } })
      added.push(file)
    }
    res.json({ success: true, data: { added, skipped } })
  } catch (err) {
    next(asAppError(err))
  }
})

// ── Blank forms and printing ───────────────────────────────────────────────────

/** Upload a layout's blank form: one page per version. Replaces any earlier one. */
router.put(
  '/quiz-grader/content/:id/pdf',
  requireProfessor,
  express.raw({ type: 'application/pdf', limit: '15mb' }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const row = await loadOne(req)
      if (row.kind !== 'LAYOUT') throw new AppError('Only a layout has a blank PDF.', 400)
      const bytes = req.body as Buffer
      if (!Buffer.isBuffer(bytes) || !bytes.length) throw new AppError('Send the PDF as the request body (Content-Type: application/pdf).', 400)
      let pages: number
      try {
        pages = (await PDFDocument.load(bytes)).getPageCount()
      } catch {
        throw new AppError('That file could not be read as a PDF.', 400)
      }
      await prisma.quizContent.update({ where: { id: row.id }, data: { pdf: new Uint8Array(bytes) } })
      res.json({ success: true, data: { pages } })
    } catch (err) {
      next(err)
    }
  },
)

router.get('/quiz-grader/content/:id/pdf', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const row = await loadOne(req)
    const { pdf } = await prisma.quizContent.findUniqueOrThrow({ where: { id: row.id }, select: { pdf: true } })
    if (!pdf) throw new AppError('No blank PDF uploaded for this layout.', 404)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="${row.slug.replace(/[^\w.-]/g, '_')}.pdf"`)
    res.send(Buffer.from(pdf))
  } catch (err) {
    next(err)
  }
})

/**
 * An assessment's print-ready PDF: each version's page of the blank form with corner
 * markers. `?version=A` for one version, or every version in order without it.
 */
router.get('/quiz-grader/content/:id/print', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const row = await loadOne(req)
    if (row.kind !== 'ASSESSMENT') throw new AppError('Print an assessment; it says which page each version uses.', 400)
    const parsed = assessmentSchema.safeParse(parseSource(row.source))
    if (!parsed.success) throw new AppError('Fix this assessment\'s problems before printing it.', 400)
    const a = parsed.data
    const version = typeof req.query.version === 'string' ? req.query.version : null
    const versions = version ? [version] : Object.keys(a.versions)
    if (version && !a.versions[version]) throw new AppError(`No version "${version}" in ${a.assessment}.`, 400)

    const layout = await prisma.quizContent.findUnique({
      where: { professorId_kind_slug: { professorId: row.professorId, kind: 'LAYOUT', slug: a.layout } },
      select: { pdf: true },
    })
    if (!layout) throw new AppError(`No layout named "${a.layout}".`, 400)
    if (!layout.pdf) throw new AppError(`Layout "${a.layout}" has no blank PDF yet.`, 400)

    let out: Uint8Array
    try {
      out = await printablePdf(layout.pdf, versions.map((v) => versionPage(a, v)))
    } catch (e) {
      throw new AppError((e as Error).message, 400)
    }
    const name = `${a.assessment}${version ? `-${version}` : ''}`.replace(/[^\w.-]/g, '_')
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${name}.pdf"`)
    res.send(Buffer.from(out))
  } catch (err) {
    next(asAppError(err))
  }
})

export default router
