/**
 * Quiz content as stored: YAML source text per answer key, layout and assessment.
 *
 * Everything here works on the raw parse of the YAML (what the editor holds, with no
 * schema defaults filled in) and validates it with the schemas in content.ts. Saving
 * raw data, not schema output, is what keeps edits from writing defaults the author
 * never typed into their file.
 */
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { parseDocument } from 'yaml'
import type { QuizContentKind } from '@prisma/client'
import { ZodError, type ZodSchema } from 'zod'
import { assessmentSchema, layoutSchema, pathwayKeySchema, resolveRef, type Assessment, type Layout, type PathwayKey } from './content.js'

export type Raw = Record<string, unknown>

const SCHEMAS: Record<QuizContentKind, ZodSchema> = {
  KEY: pathwayKeySchema,
  LAYOUT: layoutSchema,
  ASSESSMENT: assessmentSchema,
}
const SLUG_FIELD: Record<QuizContentKind, string> = { KEY: 'pathway', LAYOUT: 'layout', ASSESSMENT: 'assessment' }

export const KIND_LABEL: Record<QuizContentKind, string> = { KEY: 'answer key', LAYOUT: 'layout', ASSESSMENT: 'assessment' }

/** A YAML file the author can fix, with the line to look at. */
export class ContentError extends Error {}

/** Parse YAML text, reporting the first problem with its line number. */
export function parseSource(source: string): Raw {
  const doc = parseDocument(source, { prettyErrors: true })
  if (doc.errors.length) throw new ContentError(doc.errors[0]!.message.split('\n')[0]!)
  const raw = doc.toJS()
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new ContentError('The file should be a YAML mapping (key: value lines).')
  return raw as Raw
}

/** Which kind of content a parsed file is, from its naming field. */
export function kindOf(raw: Raw): QuizContentKind {
  // An assessment also has a `layout:` field (the layout it uses), so it is checked first.
  if (typeof raw.assessment === 'string') return 'ASSESSMENT'
  if (typeof raw.pathway === 'string') return 'KEY'
  if (typeof raw.layout === 'string') return 'LAYOUT'
  throw new ContentError('Not a quiz grader file: expected a `pathway:`, `layout:` or `assessment:` line naming it.')
}

/** Schema problems as short lines a person can act on: `steps.6.enzyme.accept: Required`. */
export function schemaIssues(kind: QuizContentKind, raw: Raw): string[] {
  const r = SCHEMAS[kind].safeParse(raw)
  return r.success ? [] : (r.error as ZodError).issues.map((i) => `${i.path.join('.') || '(file)'}: ${i.message}`)
}

export const slugOf = (kind: QuizContentKind, raw: Raw) => String(raw[SLUG_FIELD[kind]])

export function titleOf(kind: QuizContentKind, raw: Raw): string {
  if (kind === 'KEY' && typeof raw.title === 'string') return raw.title
  return slugOf(kind, raw)
}

/** Validate an incoming file or edit; throws ContentError listing what is wrong. */
export function validate(kind: QuizContentKind, raw: Raw): void {
  const issues = schemaIssues(kind, raw)
  if (issues.length) throw new ContentError(`${issues.length} problem${issues.length > 1 ? 's' : ''}: ${issues.slice(0, 5).join('; ')}`)
}

export interface StoredContent { kind: QuizContentKind; slug: string; source: string }

/**
 * What an assessment needs from the rest of a professor's content, and what is missing:
 * its key and layout, every layout ref resolving against the key, every graded
 * structure existing. For a layout, slots with no box yet. Warnings, not errors — a
 * half-drawn layout is a normal state.
 */
export function crossCheck(item: StoredContent, all: StoredContent[]): string[] {
  if (item.kind === 'LAYOUT') {
    try {
      const unboxed = layoutSchema.parse(parseSource(item.source)).slots.filter((s) => !s.box).length
      return unboxed ? [`${unboxed} slot${unboxed > 1 ? 's have' : ' has'} no box drawn yet.`] : []
    } catch { return [] }
  }
  if (item.kind !== 'ASSESSMENT') return []
  const find = (kind: QuizContentKind, slug: string) => all.find((c) => c.kind === kind && c.slug === slug)
  const warnings: string[] = []
  let a: Assessment
  try { a = assessmentSchema.parse(parseSource(item.source)) } catch { return [] }

  const keyRow = find('KEY', a.key)
  const layoutRow = find('LAYOUT', a.layout)
  if (!keyRow) warnings.push(`No answer key named "${a.key}".`)
  if (!layoutRow) warnings.push(`No layout named "${a.layout}".`)
  if (!keyRow) return warnings

  let key: PathwayKey
  try { key = pathwayKeySchema.parse(parseSource(keyRow.source)) } catch { return [...warnings, `Answer key "${a.key}" has errors.`] }

  for (const [v, ver] of Object.entries(a.versions)) {
    for (const s of ver.structures) if (!key.intermediates[s]) warnings.push(`Version ${v} grades structure "${s}", which "${a.key}" does not define.`)
  }
  if (layoutRow) {
    let layout: Layout | null = null
    try { layout = layoutSchema.parse(parseSource(layoutRow.source)) } catch { warnings.push(`Layout "${a.layout}" has errors.`) }
    for (const slot of layout?.slots ?? []) {
      try { resolveRef(key, slot.ref) } catch (e) { warnings.push(`Layout slot ${slot.id}: ${(e as Error).message}`) }
    }
    const unboxed = (layout?.slots ?? []).filter((s) => !s.box).length
    if (unboxed) warnings.push(`${unboxed} layout slot${unboxed > 1 ? 's have' : ' has'} no box drawn yet.`)
  }
  return warnings
}

/** Assessments that name this key or layout, which would break if it were deleted. */
export function dependents(item: StoredContent, all: StoredContent[]): string[] {
  if (item.kind === 'ASSESSMENT') return []
  const field = item.kind === 'KEY' ? 'key' : 'layout'
  return all
    .filter((c) => c.kind === 'ASSESSMENT')
    .filter((c) => { try { return parseSource(c.source)[field] === item.slug } catch { return false } })
    .map((c) => c.slug)
}

// ── Starter content ────────────────────────────────────────────────────────────

const SEED_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'quiz-grader', 'seed')

/** The handoff's glycolysis and TCA content, as shipped in docs/quiz-grader/seed. */
export async function starterFiles(): Promise<{ file: string; source: string }[]> {
  const out: { file: string; source: string }[] = []
  for (const sub of ['keys', 'layouts', 'assessments']) {
    const dir = path.join(SEED_DIR, sub)
    for (const f of (await fs.readdir(dir)).filter((f) => f.endsWith('.yaml')).sort()) {
      out.push({ file: `${sub}/${f}`, source: await fs.readFile(path.join(dir, f), 'utf8') })
    }
  }
  return out
}

const CONTENT_DIR = path.resolve(SEED_DIR, '..')

/**
 * A starter layout's blank form, from the `page.source_pdf` path its YAML names
 * (relative to docs/quiz-grader). Null when it names none or the file is not there.
 */
export async function starterPdf(raw: Raw): Promise<Buffer | null> {
  const rel = (raw.page as { source_pdf?: unknown } | undefined)?.source_pdf
  if (typeof rel !== 'string') return null
  const file = path.resolve(CONTENT_DIR, rel)
  if (!file.startsWith(CONTENT_DIR + path.sep)) return null
  try { return await fs.readFile(file) } catch { return null }
}
