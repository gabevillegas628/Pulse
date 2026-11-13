/**
 * Grading scanned pages: the model reads each answer crop, code scores it against the key.
 *
 * A page is graded once the vision service has lined it up and cut out its boxes (status
 * DONE). Boxes the ink check found empty are not sent; name and NetID boxes are never sent
 * (reader.ts refuses them). What the model said is stored on the page, so editing the key
 * re-scores every page at once without asking the model again.
 */
import fs from 'fs/promises'
import path from 'path'
import Anthropic from '@anthropic-ai/sdk'
import type { Prisma, QuizPage } from '@prisma/client'
import { prisma } from '../db/index.js'
import { config } from '../config/index.js'
import { logger } from '../utils/logger.js'
import {
  assessmentSchema, layoutSchema, pathwayKeySchema, slotsForVersion,
  type Assessment, type GradedSlot, type Layout, type PathwayKey,
} from './content.js'
import { doubtfulChecks, gradePage, wantsSecondLook, type SlotResult } from './grade.js'
import {
  readSecondLook, readStructureRegions, readStructureSecondLook, readTextRegions,
  DEFAULT_MODEL_SECOND_LOOK, DEFAULT_MODEL_STRUCTURE, DEFAULT_MODEL_STRUCTURE_SECOND_LOOK, DEFAULT_MODEL_TEXT,
  type ReadCache, type Region, type StructureRead, type TextRead, type Usage,
} from './reader.js'
import { normalize, stripCoefficient } from './scoring.js'
import { pageDir } from './scans.js'
import { parseSource } from './store.js'

export const gradingConfigured = () => Boolean(config.anthropicApiKey)

const MODEL_TEXT = process.env.MODEL_TEXT || DEFAULT_MODEL_TEXT
export const MODEL_STRUCTURE = process.env.MODEL_STRUCTURE || DEFAULT_MODEL_STRUCTURE
const MODEL_SECOND_LOOK = process.env.MODEL_SECOND_LOOK || DEFAULT_MODEL_SECOND_LOOK
const MODEL_STRUCTURE_SECOND_LOOK = process.env.MODEL_STRUCTURE_SECOND_LOOK || DEFAULT_MODEL_STRUCTURE_SECOND_LOOK

/** What the model said about one page, by slot id. */
export interface PageReads {
  text: Record<string, TextRead>
  structure: Record<string, StructureRead>
  /** Second, blind readings by a stronger model, for unsure and near-miss text answers. */
  second?: Record<string, TextRead>
  /** Second, blind answers to drawings' doubtful checks, by an even stronger model. */
  secondStructure?: Record<string, StructureRead>
  /**
   * The checks each drawing was asked, by slot id. Answers are matched to checks by
   * position, so once a drawing's checks change its answers mean nothing: it is read again.
   */
  checks?: Record<string, string[]>
}

interface Context {
  assessment: Assessment
  key: PathwayKey
  layout: Layout
}

/** The assessment with its key and layout, as currently saved. */
export async function contextFor(assessmentId: string): Promise<Context> {
  const a = await prisma.quizContent.findUniqueOrThrow({ where: { id: assessmentId }, select: { source: true, professorId: true }, })
  const assessment = assessmentSchema.parse(parseSource(a.source))
  const find = (kind: 'KEY' | 'LAYOUT', slug: string) =>
    prisma.quizContent.findUnique({ where: { professorId_kind_slug: { professorId: a.professorId, kind, slug } }, select: { source: true } })
  const [k, l] = await Promise.all([find('KEY', assessment.key), find('LAYOUT', assessment.layout)])
  if (!k) throw new Error(`No answer key named "${assessment.key}"`)
  if (!l) throw new Error(`No layout named "${assessment.layout}"`)
  return { assessment, key: pathwayKeySchema.parse(parseSource(k.source)), layout: layoutSchema.parse(parseSource(l.source)) }
}

/** Model reads cached in the database, keyed by model, prompt and images. */
export const dbCache: ReadCache = {
  async get(key) {
    return (await prisma.quizReadCache.findUnique({ where: { key } }))?.value ?? undefined
  },
  async set(key, value) {
    await prisma.quizReadCache.upsert({ where: { key }, create: { key, value: value as Prisma.InputJsonValue }, update: {} })
  },
}

/** Slots the vision service's ink check found empty. */
function inkBlanks(page: Pick<QuizPage, 'slots'>): Set<string> {
  const slots = (page.slots ?? []) as { id: string; blank: boolean }[]
  return new Set(slots.filter((s) => s.blank).map((s) => s.id))
}

/** What identical answers share, so one review decision can cover them all. */
function groupKey(r: SlotResult): string | null {
  if (r.status === 'blank') return '(blank)'
  if (r.status !== 'read') return `(${r.status})`
  if (r.kind === 'enzyme' || r.kind === 'name') return r.match?.normalized ?? normalize(r.transcription ?? '')
  if (r.kind === 'cofactors') {
    return (r.cofactors ?? []).map((c) => `${c.side}:${normalize(stripCoefficient(c.text))}`).sort().join(' ')
  }
  return null
}

/** Score a page from its stored reads against the current key, and save the results. */
export async function scorePage(pageId: string, ctx: Context): Promise<void> {
  const page = await prisma.quizPage.findUniqueOrThrow({ where: { id: pageId } })
  if (!page.version || !page.reads) return
  const slots = slotsForVersion(ctx.assessment, ctx.layout, ctx.key, page.version)
  const reads = page.reads as unknown as PageReads
  const results = gradePage(
    slots,
    inkBlanks(page),
    new Map(Object.entries(reads.text ?? {})),
    new Map(Object.entries(reads.structure ?? {})),
    {},
    new Map(Object.entries(reads.second ?? {})),
    new Map(Object.entries(reads.secondStructure ?? {})),
  ).filter((r) => r.maxPoints > 0)

  await prisma.$transaction([
    prisma.quizSlotResult.deleteMany({ where: { pageId } }),
    prisma.quizSlotResult.createMany({
      data: results.map((r) => ({
        pageId,
        slotId: r.slotId,
        kind: r.kind,
        status: r.status,
        blankBy: r.blankBy ?? null,
        transcription: r.transcription ?? null,
        groupKey: groupKey(r),
        detail: {
          match: r.match ?? null,
          cofactors: r.cofactors ?? null,
          cofactorResult: r.cofactorResult ?? null,
          features: r.features ?? null,
          description: r.description ?? null,
          secondLook: r.secondLook ?? null,
        } as Prisma.InputJsonValue,
        confidence: r.confidence,
        pointsAuto: r.pointsAuto,
        maxPoints: r.maxPoints,
        needsReview: r.needsReview,
        reviewReasons: r.reviewReasons,
      })),
    }),
    prisma.quizPage.update({
      where: { id: pageId },
      data: {
        pointsAuto: Math.round(results.reduce((a, r) => a + r.pointsAuto, 0) * 100) / 100,
        maxPoints: results.reduce((a, r) => a + r.maxPoints, 0),
        toReview: results.filter((r) => r.needsReview).length,
      },
    }),
  ])
}

/**
 * One region per distinct box (an enzyme blank and its cofactor arrow share one on the
 * glycolysis form), holding the slots in it that have writing. Identity slots never go.
 */
async function regionsFor(page: Pick<QuizPage, 'batchId' | 'index' | 'slots'>, slots: GradedSlot[]): Promise<Region[]> {
  const blank = inkBlanks(page)
  const dir = pageDir(page.batchId, page.index)
  const byBox = new Map<string, GradedSlot[]>()
  for (const g of slots) {
    if (g.ref.kind === 'identity' || blank.has(g.slot.id)) continue
    const k = JSON.stringify(g.slot.box)
    byBox.set(k, [...(byBox.get(k) ?? []), g])
  }
  const regions: Region[] = []
  for (const group of byBox.values()) {
    const crop = path.join(dir, `crop-${group[0]!.slot.id}.png`)
    const png = await fs.readFile(crop).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') throw new MissingScan()
      throw e
    })
    regions.push({ id: group[0]!.slot.id, png, slots: group })
  }
  return regions
}

const only = (regions: Region[], keep: (g: GradedSlot) => boolean) => regions
  .map((r) => ({ ...r, slots: r.slots.filter(keep) }))
  .filter((r) => r.slots.length)

/**
 * A second, blind look at the page's unsure and near-miss enzyme and name readings,
 * by the stronger model. Returns only the slots it looked at (none: no call made).
 */
async function secondLook(client: Anthropic, ctx: Context, regions: Region[], text: Record<string, TextRead>, skip: Set<string> = new Set()) {
  const due = only(regions, (g) => !skip.has(g.slot.id) && wantsSecondLook(g, text[g.slot.id]))
  if (!due.length) return null
  // A second look only removes flags: if it fails, the page is graded without it.
  return readSecondLook(client, ctx.key, due, { model: MODEL_SECOND_LOOK, cache: dbCache })
    .catch((e) => { logger.warn('quiz second look failed; graded without it', { error: (e as Error).message }); return null })
}

/** A second, blind look at drawings' doubtful checks. Null when none, or when it fails. */
async function structureSecondLook(client: Anthropic, regions: Region[], structure: Record<string, StructureRead>, skip: Set<string> = new Set()) {
  const doubtful = new Map<string, number[]>()
  const due = only(regions, (g) => {
    if (skip.has(g.slot.id)) return false
    const checks = doubtfulChecks(g, structure[g.slot.id])
    if (checks.length) doubtful.set(g.slot.id, checks)
    return checks.length > 0
  })
  if (!due.length) return null
  return readStructureSecondLook(client, due, doubtful, { model: MODEL_STRUCTURE_SECOND_LOOK, cache: dbCache })
    .catch((e) => { logger.warn('quiz structure second look failed; graded without it', { error: (e as Error).message }); return null })
}

/** Read one page with the model, then score it. */
async function gradeOne(pageId: string): Promise<void> {
  const page = await prisma.quizPage.findUniqueOrThrow({ where: { id: pageId }, include: { batch: { select: { assessmentId: true } } } })
  if (page.status !== 'DONE' || !page.version) throw new Error('The page is not lined up yet')
  const ctx = await contextFor(page.batch.assessmentId)
  const slots = slotsForVersion(ctx.assessment, ctx.layout, ctx.key, page.version)
  const regions = await regionsFor(page, slots)
  const pick = (kinds: string[]) => only(regions, (s) => kinds.includes(s.ref.kind))

  const client = new Anthropic({ apiKey: config.anthropicApiKey })
  const textRegions = pick(['enzyme', 'name', 'cofactors'])
  const structRegions = pick(['structure'])
  const [text, struct] = await Promise.all([
    textRegions.length ? readTextRegions(client, ctx.key, textRegions, { model: MODEL_TEXT, cache: dbCache }) : null,
    structRegions.length ? readStructureRegions(client, structRegions, { model: MODEL_STRUCTURE, cache: dbCache }) : null,
  ])
  const textReads = Object.fromEntries(text?.reads ?? [])
  const structureReads = Object.fromEntries(struct?.reads ?? [])
  const [second, secondStruct] = await Promise.all([
    secondLook(client, ctx, regions, textReads),
    structureSecondLook(client, pick(['structure']), structureReads),
  ])
  const reads: PageReads = {
    text: textReads,
    structure: structureReads,
    second: Object.fromEntries(second?.reads ?? []),
    secondStructure: Object.fromEntries(secondStruct?.reads ?? []),
    checks: Object.fromEntries(slots.filter((g) => g.ref.kind === 'structure').map((g) => [g.slot.id, (g.ref as { intermediate: { features: string[] } }).intermediate.features])),
  }
  const usage: Usage[] = [text?.usage, struct?.usage, second?.usage, secondStruct?.usage].filter((u): u is Usage => !!u)
  await prisma.quizPage.update({
    where: { id: pageId },
    data: { reads: reads as unknown as Prisma.InputJsonValue, usage: usage as unknown as Prisma.InputJsonValue },
  })
  await scorePage(pageId, ctx)
  await prisma.quizPage.update({ where: { id: pageId }, data: { gradeStatus: 'GRADED', gradedAt: new Date(), gradeError: null, gradeClaimedAt: null } })
}

/**
 * Second looks for an assessment's graded pages: at unsure and near-miss readings that
 * have not had one (pages graded before second looks existed). Then re-scored. Returns
 * how many pages it looked at; the stronger model is called once per such page.
 */
export async function secondLooksFor(assessmentId: string, opts: { dryRun?: boolean } = {}): Promise<number> {
  const ctx = await contextFor(assessmentId)
  const pages = await prisma.quizPage.findMany({
    where: { gradeStatus: 'GRADED', batch: { assessmentId } },
    select: { id: true, batchId: true, index: true, slots: true, version: true, reads: true, usage: true },
  })
  const client = new Anthropic({ apiKey: config.anthropicApiKey })
  let looked = 0
  for (const page of pages) {
    if (!page.version || !page.reads) continue
    const reads = page.reads as unknown as PageReads
    const slots = slotsForVersion(ctx.assessment, ctx.layout, ctx.key, page.version)
    const done = new Set(Object.keys(reads.second ?? {}))
    const doneStruct = new Set(Object.keys(reads.secondStructure ?? {}))
    const textDue = slots.some((g) => !done.has(g.slot.id) && wantsSecondLook(g, reads.text?.[g.slot.id]))
    const structDue = slots.some((g) => !doneStruct.has(g.slot.id) && doubtfulChecks(g, reads.structure?.[g.slot.id]).length > 0)
    if (!textDue && !structDue) continue
    if (opts.dryRun) { looked++; continue }
    const regions = await regionsFor(page, slots)
    const [second, secondStruct] = await Promise.all([
      textDue ? secondLook(client, ctx, regions, reads.text ?? {}, done) : null,
      structDue ? structureSecondLook(client, only(regions, (g) => g.ref.kind === 'structure'), reads.structure ?? {}, doneStruct) : null,
    ])
    if (!second && !secondStruct) continue
    looked++
    await prisma.quizPage.update({
      where: { id: page.id },
      data: {
        reads: {
          ...reads,
          second: { ...(reads.second ?? {}), ...Object.fromEntries(second?.reads ?? []) },
          secondStructure: { ...(reads.secondStructure ?? {}), ...Object.fromEntries(secondStruct?.reads ?? []) },
        } as unknown as Prisma.InputJsonValue,
        usage: [...((page.usage ?? []) as unknown as Usage[]), ...[second?.usage, secondStruct?.usage].filter((u): u is Usage => !!u)] as unknown as Prisma.InputJsonValue,
      },
    })
    await scorePage(page.id, ctx)
  }
  return looked
}

const runningSecondLooks = new Set<string>()

/** Start second looks for an assessment in the background; how many pages are due. */
export async function startSecondLooks(assessmentId: string): Promise<{ pages: number; running: boolean }> {
  if (runningSecondLooks.has(assessmentId)) return { pages: 0, running: true }
  const pages = await secondLooksFor(assessmentId, { dryRun: true })
  if (!pages) return { pages: 0, running: false }
  runningSecondLooks.add(assessmentId)
  void secondLooksFor(assessmentId)
    .then((n) => logger.info('quiz second looks done', { assessmentId, pages: n }))
    .catch((e) => logger.warn('quiz second looks failed', { assessmentId, error: (e as Error).message }))
    .finally(() => runningSecondLooks.delete(assessmentId))
  return { pages, running: true }
}
export const secondLooksRunning = (assessmentId: string) => runningSecondLooks.has(assessmentId)

/**
 * Re-score every graded page of an assessment from its stored reads: after the key,
 * the points or the review rules change. No model calls.
 */
export async function rescoreAssessment(assessmentId: string, changed: Set<string> = new Set()): Promise<number> {
  const ctx = await contextFor(assessmentId)
  const pages = await prisma.quizPage.findMany({
    where: { gradeStatus: 'GRADED', batch: { assessmentId } },
    select: { id: true, version: true, reads: true },
  })
  const reread: string[] = []
  for (const p of pages) {
    if (gradingConfigured() && drawingsAskedOtherChecks(ctx, p, changed)) { reread.push(p.id); continue }
    await scorePage(p.id, ctx)
  }
  // Their drawings are read again with the new checks (written answers come from the cache).
  if (reread.length) {
    await prisma.quizPage.updateMany({ where: { id: { in: reread } }, data: { gradeStatus: 'PENDING', gradeAttempts: 0, gradeError: null } })
    logger.info('quiz pages queued to read drawings again after their checks changed', { assessmentId, pages: reread.length })
  }
  return pages.length
}

/**
 * Whether a page's drawings were read against checks other than the key's current ones.
 * Pages read before the checks were recorded are judged by `changed` (the intermediates
 * whose checks the edit being saved changes) and by how many checks were answered.
 */
function drawingsAskedOtherChecks(ctx: Context, page: { version: string | null; reads: unknown }, changed: Set<string>): boolean {
  if (!page.version || !page.reads) return false
  const reads = page.reads as PageReads
  let slots: GradedSlot[]
  try { slots = slotsForVersion(ctx.assessment, ctx.layout, ctx.key, page.version) } catch { return false }
  return slots.some((g) => {
    if (g.ref.kind !== 'structure' || !reads.structure?.[g.slot.id]) return false
    const asked = reads.checks?.[g.slot.id]
    if (asked) return JSON.stringify(asked) !== JSON.stringify(g.ref.intermediate.features)
    // Read before checks were recorded: a different number of answers gives it away.
    const read = reads.structure[g.slot.id]!
    return changed.has(g.ref.id) || (read.status === 'read' && read.features.length !== g.ref.intermediate.features.length)
  })
}

/** Intermediates whose checks differ between a key's saved text and an edit of it. */
export function changedChecks(before: string, after: unknown): Set<string> {
  const out = new Set<string>()
  try {
    const a = pathwayKeySchema.parse(parseSource(before)).intermediates
    const b = pathwayKeySchema.parse(after).intermediates
    for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (JSON.stringify(a[id]?.features ?? []) !== JSON.stringify(b[id]?.features ?? [])) out.add(id)
    }
  } catch { /* not a key */ }
  return out
}

/** Re-score everything that depends on a key or assessment that was just edited. */
export async function rescoreAfterEdit(professorId: string, kind: string, slug: string, changed: Set<string> = new Set()): Promise<void> {
  const field = kind === 'KEY' ? 'key' : kind === 'LAYOUT' ? 'layout' : null
  const assessments = await prisma.quizContent.findMany({ where: { professorId, kind: 'ASSESSMENT' }, select: { id: true, slug: true, source: true } })
  for (const a of assessments) {
    let uses = kind === 'ASSESSMENT' && a.slug === slug
    if (field) { try { uses = parseSource(a.source)[field] === slug } catch { uses = false } }
    if (!uses) continue
    try {
      const n = await rescoreAssessment(a.id, changed)
      if (n) logger.info('quiz pages re-scored after an edit', { assessment: a.slug, pages: n })
    } catch (e) {
      logger.warn('re-scoring after an edit failed', { assessment: a.slug, error: (e as Error).message })
    }
  }
}

// ── The worker ─────────────────────────────────────────────────────────────────

/** The page's cut-out boxes are not on this server's disk: retrying cannot help. */
class MissingScan extends Error {
  constructor() {
    super('This page\'s images are not on this server\'s disk (a redeploy without a volume, or another Pulse server sharing the database). Upload the scan again.')
  }
}

const MAX_ATTEMPTS = 3
const STALE_MS = 5 * 60_000
const CONCURRENCY = 2

async function claim(): Promise<string | null> {
  await prisma.quizPage.updateMany({
    where: { gradeStatus: 'GRADING', gradeClaimedAt: { lt: new Date(Date.now() - STALE_MS) } },
    data: { gradeStatus: 'PENDING', gradeClaimedAt: null },
  })
  const next = await prisma.quizPage.findFirst({
    where: { gradeStatus: 'PENDING', status: 'DONE' },
    orderBy: [{ createdAt: 'asc' }, { index: 'asc' }],
    select: { id: true },
  })
  if (!next) return null
  const won = await prisma.quizPage.updateMany({
    where: { id: next.id, gradeStatus: 'PENDING' },
    data: { gradeStatus: 'GRADING', gradeClaimedAt: new Date(), gradeAttempts: { increment: 1 } },
  })
  return won.count ? next.id : null
}

async function runOne(): Promise<boolean> {
  const id = await claim()
  if (!id) return false
  try {
    await gradeOne(id)
  } catch (e) {
    const page = await prisma.quizPage.findUnique({ where: { id }, select: { gradeAttempts: true } })
    const message = e instanceof Error ? e.message : String(e)
    const giveUp = !page || page.gradeAttempts >= MAX_ATTEMPTS || e instanceof Anthropic.AuthenticationError || e instanceof MissingScan
    logger.warn('quiz page grading failed', { pageId: id, attempts: page?.gradeAttempts, giveUp, error: message })
    await prisma.quizPage.update({
      where: { id },
      data: { gradeStatus: giveUp ? 'FAILED' : 'PENDING', gradeError: message, gradeClaimedAt: null },
    }).catch(() => undefined)
  }
  return true
}

let started = false

/** Grade lined-up pages in the background, a couple at a time; claims survive restarts. */
export function startQuizGradeWorker(): void {
  if (started || !gradingConfigured()) return
  started = true
  const loop = async () => {
    for (;;) {
      let worked = false
      try {
        worked = await runOne()
      } catch (e) {
        logger.error('quiz grade loop error', { error: (e as Error).message })
      }
      await new Promise((r) => setTimeout(r, worked ? 50 : 2000))
    }
  }
  for (let i = 0; i < CONCURRENCY; i++) void loop()
  logger.info('Quiz grading worker started')
}
