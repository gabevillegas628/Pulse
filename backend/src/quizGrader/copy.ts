/**
 * Copy a quiz (its settings, answer key and boxes with the blank form) into a class.
 *
 * Quiz files are named uniquely per professor, and a quiz finds its key and boxes by those
 * names. A copy therefore gets fresh names (glycolysis-quiz-2, ...) and its settings file is
 * re-pointed at its own key and boxes: through patchYaml, so only those lines change. Scans,
 * results and review decisions are never copied: a copy is a fresh start for a new class.
 */
import type { Prisma, PrismaClient } from '@prisma/client'
import { patchYaml } from './yamlPatch.js'
import { kindOf, parseSource, slugOf } from './store.js'

type Db = PrismaClient | Prisma.TransactionClient

export interface QuizSources {
  quiz: string
  key: string
  layout: string
  pdf: Uint8Array | null
}

/** A name not yet used by this professor: the base, else base-2, base-3, ... */
function freeName(base: string, taken: Set<string>): string {
  const stem = base.replace(/-\d+$/, '')
  let name = stem
  for (let n = 2; taken.has(name); n++) name = `${stem}-${n}`
  taken.add(name)
  return name
}

/** Rewrite one naming field of a YAML file, splicing only that line. */
function rename(source: string, field: string, value: string): string {
  const raw = parseSource(source)
  return patchYaml(source, { ...raw, [field]: value }).text
}

export async function copyQuizInto(db: Db, professorId: string, classId: string, src: QuizSources): Promise<string> {
  const raw = parseSource(src.quiz)
  if (kindOf(raw) !== 'ASSESSMENT') throw new Error('Not a quiz settings file')
  const taken = new Set((await db.quizContent.findMany({ where: { professorId }, select: { slug: true } })).map((r) => r.slug))

  const quizSlug = freeName(slugOf('ASSESSMENT', raw), taken)
  const keySlug = freeName(slugOf('KEY', parseSource(src.key)), taken)
  const layoutSlug = freeName(slugOf('LAYOUT', parseSource(src.layout)), taken)

  let quiz = rename(src.quiz, 'assessment', quizSlug)
  quiz = rename(quiz, 'key', keySlug)
  quiz = rename(quiz, 'layout', layoutSlug)

  const created = await db.quizContent.create({ data: { professorId, classId, kind: 'ASSESSMENT', slug: quizSlug, source: quiz }, select: { id: true } })
  await db.quizContent.create({ data: { professorId, kind: 'KEY', slug: keySlug, source: rename(src.key, 'pathway', keySlug) } })
  await db.quizContent.create({
    data: { professorId, kind: 'LAYOUT', slug: layoutSlug, source: rename(src.layout, 'layout', layoutSlug), ...(src.pdf ? { pdf: new Uint8Array(src.pdf) } : {}) },
  })
  return created.id
}

/** A quiz's three files as stored, ready to copy. Null if its key or boxes are missing. */
export async function quizSources(db: Db, quizId: string): Promise<QuizSources | null> {
  const quiz = await db.quizContent.findUnique({ where: { id: quizId }, select: { source: true, professorId: true, kind: true } })
  if (!quiz || quiz.kind !== 'ASSESSMENT') return null
  let raw: Record<string, unknown>
  try { raw = parseSource(quiz.source) } catch { return null }
  const find = (kind: 'KEY' | 'LAYOUT', slug: unknown) => typeof slug === 'string'
    ? db.quizContent.findUnique({ where: { professorId_kind_slug: { professorId: quiz.professorId, kind, slug } }, select: { source: true, pdf: true } })
    : null
  const [key, layout] = await Promise.all([find('KEY', raw.key), find('LAYOUT', raw.layout)])
  if (!key || !layout) return null
  return { quiz: quiz.source, key: key.source, layout: layout.source, pdf: layout.pdf }
}
