/**
 * Quiz grader content: answer keys, layouts and assessments, kept as YAML.
 * Professor-only. See docs/quiz-grader/README.md.
 */
import express, { Router, Request, Response, NextFunction } from 'express'
import { PDFDocument } from 'pdf-lib'
import { z } from 'zod'
import type { QuizContent, QuizContentKind } from '@prisma/client'
import { prisma } from '../db/index.js'
import { AppError, isUniqueViolation } from '../middleware/error.middleware.js'
import { requireProfessor, ProfessorRequest } from '../middleware/auth.middleware.js'
import { ownedClass, ownedQuizContent } from '../utils/ownership.js'
import { copyQuizInto, quizSources } from '../quizGrader/copy.js'
import { p } from '../utils/params.js'
import { patchYaml } from '../quizGrader/yamlPatch.js'
import { printablePdf } from '../quizGrader/print.js'
import { changedChecks, rescoreAfterEdit } from '../quizGrader/grading.js'
import { assessmentSchema, versionPage } from '../quizGrader/content.js'
import {
  ContentError, KIND_LABEL, crossCheck, dependents, kindOf, newQuizFiles, parseSource, schemaIssues, slugOf, slugify, starterFiles, starterPdf, titleOf, validate,
  type Raw,
} from '../quizGrader/store.js'

const router = Router()

async function ownedClassOrThrow(req: Request, classId: string) {
  const cls = await prisma.class.findFirst({ where: { id: classId, ...ownedClass((req as ProfessorRequest).professor) }, select: { id: true, name: true } })
  if (!cls) throw new AppError('Class not found', 404)
  return cls
}

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
    classId: row.classId,
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
    // Graded papers follow the edit: re-scored from what the model already read.
    if (method !== 'unchanged') void rescoreAfterEdit(row.professorId, row.kind, slug, row.kind === 'KEY' ? changedChecks(row.source, data) : undefined)
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

// Load the glycolysis and TCA examples into a class, skipping any the class already has.
router.post('/quiz-grader/starter', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const { classId } = z.object({ classId: z.string() }).parse(req.body)
    await ownedClassOrThrow(req, classId)
    const files = (await starterFiles()).map((f) => ({ ...f, raw: parseSource(f.source) }))
    const named = (kind: QuizContentKind, slug: unknown) => files.find((f) => kindOf(f.raw) === kind && slugOf(kind, f.raw) === slug)
    const inClass = await prisma.quizContent.findMany({ where: { classId, kind: 'ASSESSMENT' }, select: { slug: true } })
    const base = (slug: string) => slug.replace(/-\d+$/, '')
    const added: string[] = []
    const skipped: string[] = []
    for (const f of files.filter((x) => kindOf(x.raw) === 'ASSESSMENT')) {
      const slug = slugOf('ASSESSMENT', f.raw)
      // Copies are named slug, slug-2, ...: any of those in the class means it is there.
      if (inClass.some((q) => base(q.slug) === base(slug))) { skipped.push(slug); continue }
      const key = named('KEY', f.raw.key)
      const layout = named('LAYOUT', f.raw.layout)
      if (!key || !layout) continue
      const pdf = await starterPdf(layout.raw)
      await copyQuizInto(prisma, professor.id, classId, { quiz: f.source, key: key.source, layout: layout.source, pdf: pdf ? new Uint8Array(pdf) : null })
      added.push(slug)
    }
    res.json({ success: true, data: { added, skipped } })
  } catch (err) {
    next(asAppError(err))
  }
})

// ── Quizzes: an assessment with its answer key and blank form, edited as one ──────

const PARTS = { quiz: 'ASSESSMENT', key: 'KEY', layout: 'LAYOUT' } as const
type Part = keyof typeof PARTS

/** A quiz with its key and layout rows, and the other quizzes sharing either. */
function bundle(quiz: Row, all: Row[]) {
  const detail = (r: Row) => {
    let data: Raw | null = null
    try { data = parseSource(r.source) } catch { /* summary carries the error */ }
    return { ...summary(r, all), source: r.source, data }
  }
  let raw: Raw = {}
  try { raw = parseSource(quiz.source) } catch { /* shown as the quiz's issue */ }
  const key = all.find((r) => r.kind === 'KEY' && r.slug === raw.key) ?? null
  const layout = all.find((r) => r.kind === 'LAYOUT' && r.slug === raw.layout) ?? null
  const others = (r: Row | null) => (r ? dependents(r, all).filter((s) => s !== quiz.slug) : [])
  return {
    quiz: detail(quiz),
    key: key && detail(key),
    layout: layout && detail(layout),
    sharedKey: others(key),
    sharedLayout: others(layout),
  }
}

async function loadQuiz(req: Request): Promise<{ row: Row; all: Row[] }> {
  const row = await loadOne(req)
  if (row.kind !== 'ASSESSMENT') throw new AppError('Not a quiz.', 404)
  return { row, all: await loadAll(row.professorId) }
}

router.get('/quiz-grader/quizzes/:id', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { row, all } = await loadQuiz(req)
    const cls = row.classId ? await prisma.class.findUnique({ where: { id: row.classId }, select: { id: true, name: true } }) : null
    res.json({ success: true, data: { ...bundle(row, all), class: cls } })
  } catch (err) {
    next(err)
  }
})

/**
 * Save a quiz's edits: any of its three files, each the whole edited parse as GET
 * returned it. All are checked before any is written, each is spliced (never
 * re-rendered), and graded papers are re-scored once afterwards.
 */
router.put('/quiz-grader/quizzes/:id', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { row, all } = await loadQuiz(req)
    const part = z.object({ data: z.record(z.unknown()), updatedAt: z.string().datetime() })
    const body = z.object({ quiz: part.optional(), key: part.optional(), layout: part.optional() }).parse(req.body)
    const current = bundle(row, all)

    const writes: { row: Row; text: string; kind: QuizContentKind; changed?: Set<string> }[] = []
    for (const name of Object.keys(PARTS) as Part[]) {
      const edit = body[name]
      if (!edit) continue
      const target = all.find((r) => r.id === current[name]?.id)
      if (!target) throw new AppError(`This quiz has no ${KIND_LABEL[PARTS[name]]} to save.`, 400)
      if (new Date(edit.updatedAt).getTime() !== target.updatedAt.getTime()) {
        throw new AppError('This quiz was changed since you opened it. Reload to see the latest version.', 409, 'QUIZ_CONTENT_STALE')
      }
      if (kindOf(edit.data) !== target.kind) throw new AppError(`The ${name} edit is not a ${KIND_LABEL[target.kind]}.`, 400)
      validate(target.kind, edit.data)
      if (slugOf(target.kind, edit.data) !== target.slug) throw new AppError('File names are changed from the Files view, not here.', 400)
      const { text, method } = patchYaml(target.source, edit.data)
      if (method !== 'unchanged') writes.push({ row: target, text, kind: target.kind, changed: target.kind === 'KEY' ? changedChecks(target.source, edit.data) : undefined })
    }

    if (writes.length) {
      await prisma.$transaction(writes.map((w) => prisma.quizContent.update({ where: { id: w.row.id }, data: { source: w.text }, select: { id: true } })))
      // Graded papers follow the edit, re-scored from what the model already read.
      void (async () => { for (const w of writes) await rescoreAfterEdit(row.professorId, w.kind, w.row.slug, w.changed) })()
    }
    const after = await loadAll(row.professorId)
    const cls = row.classId ? await prisma.class.findUnique({ where: { id: row.classId }, select: { id: true, name: true } }) : null
    res.json({ success: true, data: { ...bundle(after.find((r) => r.id === row.id)!, after), class: cls, saved: writes.length } })
  } catch (err) {
    next(asAppError(err))
  }
})

/** A new, empty quiz: its answer key, blank form and settings, named from the title. */
router.post('/quiz-grader/quizzes', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const { title, classId } = z.object({ title: z.string().trim().min(1).max(120), classId: z.string() }).parse(req.body)
    await ownedClassOrThrow(req, classId)
    const taken = new Set((await prisma.quizContent.findMany({ where: { professorId: professor.id }, select: { slug: true } })).map((r) => r.slug))
    const base = slugify(title)
    let slug = base
    for (let n = 2; taken.has(slug) || taken.has(`${slug}-form`); n++) slug = `${base}-${n}`
    const files = newQuizFiles(slug, title)
    const [quiz] = await prisma.$transaction([
      prisma.quizContent.create({ data: { professorId: professor.id, classId, kind: 'ASSESSMENT', slug, source: files.ASSESSMENT }, select: { id: true } }),
      prisma.quizContent.create({ data: { professorId: professor.id, kind: 'KEY', slug, source: files.KEY }, select: { id: true } }),
      prisma.quizContent.create({ data: { professorId: professor.id, kind: 'LAYOUT', slug: `${slug}-form`, source: files.LAYOUT }, select: { id: true } }),
    ])
    res.status(201).json({ success: true, data: { id: quiz.id } })
  } catch (err) {
    next(isUniqueViolation(err) ? new AppError('That name was taken a moment ago; try again.', 409) : asAppError(err))
  }
})

/** Delete a quiz, with its key and blank form unless another quiz uses them. Not once it has scans. */
router.delete('/quiz-grader/quizzes/:id', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { row, all } = await loadQuiz(req)
    const scans = await prisma.quizBatch.count({ where: { assessmentId: row.id } })
    if (scans) throw new AppError(`This quiz has ${scans} upload${scans > 1 ? 's' : ''} of scans. Delete ${scans > 1 ? 'them' : 'it'} first.`, 409)
    const b = bundle(row, all)
    const ids = [row.id]
    if (b.key && !b.sharedKey.length) ids.push(b.key.id)
    if (b.layout && !b.sharedLayout.length) ids.push(b.layout.id)
    await prisma.quizContent.deleteMany({ where: { id: { in: ids }, professorId: row.professorId } })
    res.json({ success: true, data: { deleted: ids.length } })
  } catch (err) {
    next(err)
  }
})

// A class's paper quizzes, and the professor's quizzes not in any class yet (to move in).
router.get('/quiz-grader/classes/:classId/quizzes', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const cls = await ownedClassOrThrow(req, p(req.params.classId))
    const all = await loadAll(professor.id)
    const quizzes = all.filter((r) => r.kind === 'ASSESSMENT')
    const pages = await prisma.quizPage.findMany({
      where: { batch: { assessmentId: { in: quizzes.map((q) => q.id) } } },
      select: { gradeStatus: true, studentNetId: true, batch: { select: { assessmentId: true } } },
    })
    const stats = (id: string) => {
      const mine = pages.filter((pg) => pg.batch.assessmentId === id)
      return { papers: mine.length, graded: mine.filter((pg) => pg.gradeStatus === 'GRADED').length, matched: mine.filter((pg) => pg.studentNetId).length }
    }
    const row = (q: Row) => ({ ...summary(q, all), ...stats(q.id) })
    res.json({
      success: true,
      data: {
        class: cls,
        quizzes: quizzes.filter((q) => q.classId === cls.id).map(row),
        unfiled: quizzes.filter((q) => !q.classId).map(row),
        // Other classes' quizzes, to copy from.
        elsewhere: quizzes.filter((q) => q.classId && q.classId !== cls.id).map((q) => ({ id: q.id, title: summary(q, all).title, classId: q.classId })),
      },
    })
  } catch (err) {
    next(err)
  }
})

// Copy a quiz's setup (not its scans or grades) into a class.
router.post('/quiz-grader/quizzes/:id/copy', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const { row } = await loadQuiz(req)
    const { classId } = z.object({ classId: z.string() }).parse(req.body)
    await ownedClassOrThrow(req, classId)
    const src = await quizSources(prisma, row.id)
    if (!src) throw new AppError('This quiz is missing its answer key or boxes, so it cannot be copied.', 400)
    const id = await copyQuizInto(prisma, professor.id, classId, src)
    res.status(201).json({ success: true, data: { id } })
  } catch (err) {
    next(isUniqueViolation(err) ? new AppError('A name was taken a moment ago; try again.', 409) : asAppError(err))
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
      // updatedAt guards edits to the text against overwriting each other. The PDF is not
      // the text, so uploading one must not make an open quiz page's next save look stale.
      await prisma.quizContent.update({ where: { id: row.id }, data: { pdf: new Uint8Array(bytes), updatedAt: row.updatedAt } })
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
