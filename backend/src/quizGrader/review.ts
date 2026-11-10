/**
 * Review: the professor's decisions over the automatic scores.
 *
 * A box's score is the decision for that one paper (QuizOverride), else the decision for
 * everyone who wrote the same thing in that box (QuizGroupDecision), else the automatic
 * score. A box still needs review if it was flagged and nobody has decided it. Every
 * decision is logged, and decisions are stored apart from results, so re-scoring after a
 * key edit never erases them.
 */
import type { Prisma, QuizGroupDecision, QuizOverride, QuizSlotResult } from '@prisma/client'
import { prisma } from '../db/index.js'
import { slotsForVersion } from './content.js'
import { contextFor, rescoreAssessment } from './grading.js'
import { scoreStructure, roundPoints } from './scoring.js'
import { parseSource } from './store.js'
import { patchYaml } from './yamlPatch.js'

export type Source = 'paper' | 'group' | 'auto'

export interface EffectiveResult extends QuizSlotResult {
  points: number
  source: Source
  /** Flagged, and nobody has decided it yet. */
  open: boolean
  override: Pick<QuizOverride, 'points' | 'features' | 'note' | 'decidedAt'> | null
  decision: Pick<QuizGroupDecision, 'points' | 'decidedAt'> | null
}

type ResultWithPage = QuizSlotResult & { page: { id: string; batchId: string; index: number; version: string | null; batch: { assessmentId: string } } }

const key3 = (a: string, b: string, c: string | null) => `${a}\u0000${b}\u0000${c ?? ''}`

/** Results with their effective scores, for one assessment or one page. */
export async function effectiveResults(where: { assessmentId: string } | { pageId: string }): Promise<(EffectiveResult & { page: ResultWithPage['page'] })[]> {
  const rows: ResultWithPage[] = await prisma.quizSlotResult.findMany({
    where: 'pageId' in where
      ? { pageId: where.pageId, page: { gradeStatus: 'GRADED' } }
      : { page: { gradeStatus: 'GRADED', batch: { assessmentId: where.assessmentId } } },
    include: { page: { select: { id: true, batchId: true, index: true, version: true, batch: { select: { assessmentId: true } } } } },
  })
  if (!rows.length) return []
  const pageIds = [...new Set(rows.map((r) => r.pageId))]
  const assessmentIds = [...new Set(rows.map((r) => r.page.batch.assessmentId))]
  const [overrides, decisions] = await Promise.all([
    prisma.quizOverride.findMany({ where: { pageId: { in: pageIds } } }),
    prisma.quizGroupDecision.findMany({ where: { assessmentId: { in: assessmentIds } } }),
  ])
  const ov = new Map(overrides.map((o) => [`${o.pageId}\u0000${o.slotId}`, o]))
  const gd = new Map(decisions.map((d) => [key3(d.assessmentId, d.slotId, d.groupKey), d]))

  return rows.map((r) => {
    const o = ov.get(`${r.pageId}\u0000${r.slotId}`) ?? null
    // Structures have no group key: each drawing is its own decision.
    const g = r.groupKey != null ? gd.get(key3(r.page.batch.assessmentId, r.slotId, r.groupKey)) ?? null : null
    return {
      ...r,
      points: o?.points ?? g?.points ?? r.pointsAuto,
      source: o ? 'paper' : g ? 'group' : 'auto',
      open: r.needsReview && !o && !g,
      override: o && { points: o.points, features: o.features, note: o.note, decidedAt: o.decidedAt },
      decision: g && { points: g.points, decidedAt: g.decidedAt },
    }
  })
}

/** Total and boxes left to review, per page. */
export function pageTotals(results: EffectiveResult[]): Map<string, { points: number; max: number; open: number }> {
  const out = new Map<string, { points: number; max: number; open: number }>()
  for (const r of results) {
    const t = out.get(r.pageId) ?? { points: 0, max: 0, open: 0 }
    t.points = roundPoints(t.points + r.points)
    t.max += r.maxPoints
    t.open += r.open ? 1 : 0
    out.set(r.pageId, t)
  }
  return out
}

// ── Decisions ──────────────────────────────────────────────────────────────────

/** Decide a whole group (or withdraw the decision with points = null). */
export async function decideGroup(professorId: string, assessmentId: string, slotId: string, groupKey: string, points: number | null) {
  const existing = await prisma.quizGroupDecision.findUnique({ where: { assessmentId_slotId_groupKey: { assessmentId, slotId, groupKey } } })
  const papers = await prisma.quizSlotResult.count({ where: { slotId, groupKey, page: { batch: { assessmentId } } } })
  await prisma.$transaction([
    points == null
      ? prisma.quizGroupDecision.deleteMany({ where: { assessmentId, slotId, groupKey } })
      : prisma.quizGroupDecision.upsert({
          where: { assessmentId_slotId_groupKey: { assessmentId, slotId, groupKey } },
          create: { assessmentId, slotId, groupKey, points, decidedById: professorId },
          update: { points, decidedById: professorId, decidedAt: new Date() },
        }),
    prisma.quizDecisionLog.create({
      data: { assessmentId, professorId, scope: 'group', slotId, groupKey, fromPoints: existing?.points ?? null, toPoints: points, papers },
    }),
  ])
}

/**
 * Decide one paper's box (or withdraw it with points = null). For a structure, `features`
 * are the professor's answers to the key's feature checks, and the points follow from them.
 */
export async function decidePaper(
  professorId: string,
  pageId: string,
  slotId: string,
  input: { points: number | null; features?: boolean[]; note?: string },
) {
  const page = await prisma.quizPage.findUniqueOrThrow({ where: { id: pageId }, include: { batch: { select: { assessmentId: true } } } })
  const [current] = (await effectiveResults({ pageId })).filter((r) => r.slotId === slotId)
  if (!current) throw new Error('That box has no result on this page')

  let points = input.points
  if (input.features && points != null) {
    const ctx = await contextFor(page.batch.assessmentId)
    const g = slotsForVersion(ctx.assessment, ctx.layout, ctx.key, page.version!).find((s) => s.slot.id === slotId)
    if (g?.ref.kind !== 'structure') throw new Error('Features apply to structures only')
    if (input.features.length !== g.ref.intermediate.features.length) throw new Error('One answer per feature, please')
    points = roundPoints(g.maxPoints * scoreStructure(g.ref.intermediate, input.features, g.partialCredit))
  }
  if (points != null && (points < 0 || points > current.maxPoints)) throw new Error(`Points must be between 0 and ${current.maxPoints}`)

  await prisma.$transaction([
    points == null
      ? prisma.quizOverride.deleteMany({ where: { pageId, slotId } })
      : prisma.quizOverride.upsert({
          where: { pageId_slotId: { pageId, slotId } },
          create: { pageId, slotId, points, features: input.features ?? undefined, note: input.note, decidedById: professorId },
          update: { points, features: input.features ?? undefined, note: input.note ?? null, decidedById: professorId, decidedAt: new Date() },
        }),
    prisma.quizDecisionLog.create({
      data: {
        assessmentId: page.batch.assessmentId, professorId, scope: 'paper', slotId, pageId,
        fromPoints: current.points, toPoints: points,
        detail: (input.features || input.note ? { features: input.features, note: input.note } : undefined) as Prisma.InputJsonValue | undefined,
      },
    }),
  ])
  return points
}

/**
 * Add a written answer to the key as an accepted enzyme name ("alias learning"), so papers
 * that wrote it score automatically from now on. Splices into the key's YAML like any edit,
 * then re-scores the assessment.
 */
export async function addAlias(professorId: string, assessmentId: string, slotId: string, text: string): Promise<string> {
  const ctx = await contextFor(assessmentId)
  const slot = ctx.layout.slots.find((s) => s.id === slotId)
  const m = slot && /^step\.(\w+)\.enzyme$/.exec(slot.ref)
  if (!m) throw new Error('Only enzyme names can be added to the key from review')
  const stepNo = m[1]!
  const keyRow = await prisma.quizContent.findUniqueOrThrow({
    where: { professorId_kind_slug: { professorId, kind: 'KEY', slug: ctx.assessment.key } },
    select: { id: true, source: true },
  })
  const raw = parseSource(keyRow.source) as { steps: Record<string, { enzyme: { accept: string[] } }> }
  const accept = raw.steps[stepNo]?.enzyme.accept
  if (!accept) throw new Error(`Step ${stepNo} is not in the key`)
  const alias = text.trim()
  if (!alias) throw new Error('Nothing to add')
  if (!accept.some((a) => a.toLowerCase() === alias.toLowerCase())) {
    accept.push(alias)
    const { text: source } = patchYaml(keyRow.source, raw)
    await prisma.quizContent.update({ where: { id: keyRow.id }, data: { source } })
  }
  await prisma.quizDecisionLog.create({
    data: { assessmentId, professorId, scope: 'alias', slotId, detail: { step: stepNo, alias, key: ctx.assessment.key } },
  })
  await rescoreAssessment(assessmentId)
  return alias
}
