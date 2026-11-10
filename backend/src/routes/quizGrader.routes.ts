/**
 * Quiz grader content: answer keys, layouts and assessments, kept as YAML.
 * Professor-only. See docs/quiz-grader/README.md.
 */
import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import type { QuizContent } from '@prisma/client'
import { prisma } from '../db/index.js'
import { AppError, isUniqueViolation } from '../middleware/error.middleware.js'
import { requireProfessor, ProfessorRequest } from '../middleware/auth.middleware.js'
import { ownedQuizContent } from '../utils/ownership.js'
import { p } from '../utils/params.js'
import { patchYaml } from '../quizGrader/yamlPatch.js'
import {
  ContentError, KIND_LABEL, crossCheck, dependents, kindOf, parseSource, schemaIssues, slugOf, starterFiles, titleOf, validate,
  type Raw,
} from '../quizGrader/store.js'

const router = Router()

/** A bad file is the author's to fix, so it is a 400 with their problem in it. */
function asAppError(e: unknown): unknown {
  return e instanceof ContentError ? new AppError(e.message, 400) : e
}

/** The summary the list shows, and the editor's header. */
function summary(row: QuizContent, all: QuizContent[]) {
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
    issues,
    warnings: issues.length ? [] : crossCheck(row, all),
  }
}

async function loadAll(professorId: string) {
  return prisma.quizContent.findMany({ where: { professorId }, orderBy: [{ kind: 'asc' }, { slug: 'asc' }] })
}

async function loadOne(req: Request) {
  const professor = (req as ProfessorRequest).professor
  const row = await prisma.quizContent.findFirst({ where: { id: p(req.params.id), ...ownedQuizContent(professor) } })
  if (!row) throw new AppError('Not found', 404)
  return row
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
    const row = existing
      ? await prisma.quizContent.update({ where: { id: existing.id }, data: { source } })
      : await prisma.quizContent.create({ data: { professorId: professor.id, kind, slug, source } })
    const all = await loadAll(professor.id)
    res.status(existing ? 200 : 201).json({ success: true, data: summary(row, all) })
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
      : await prisma.quizContent.update({ where: { id: row.id }, data: { source: text, slug } })
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
      const exists = await prisma.quizContent.findUnique({ where: { professorId_kind_slug: { professorId: professor.id, kind, slug } } })
      if (exists) { skipped.push(file); continue }
      await prisma.quizContent.create({ data: { professorId: professor.id, kind, slug, source } })
      added.push(file)
    }
    res.json({ success: true, data: { added, skipped } })
  } catch (err) {
    next(asAppError(err))
  }
})

export default router
