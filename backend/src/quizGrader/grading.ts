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
import { gradePage, type SlotResult } from './grade.js'
import {
  readStructureRegions, readTextRegions, DEFAULT_MODEL_STRUCTURE, DEFAULT_MODEL_TEXT,
  type ReadCache, type Region, type StructureRead, type TextRead, type Usage,
} from './reader.js'
import { normalize, stripCoefficient } from './scoring.js'
import { pageDir } from './scans.js'
import { parseSource } from './store.js'

export const gradingConfigured = () => Boolean(config.anthropicApiKey)

const MODEL_TEXT = process.env.MODEL_TEXT || DEFAULT_MODEL_TEXT
const MODEL_STRUCTURE = process.env.MODEL_STRUCTURE || DEFAULT_MODEL_STRUCTURE

/** What the model said about one page, by slot id. */
export interface PageReads {
  text: Record<string, TextRead>
  structure: Record<string, StructureRead>
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
const dbCache: ReadCache = {
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
  if (r.kind === 'enzyme') return r.match?.normalized ?? normalize(r.transcription ?? '')
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

/** Read one page with the model, then score it. */
async function gradeOne(pageId: string): Promise<void> {
  const page = await prisma.quizPage.findUniqueOrThrow({ where: { id: pageId }, include: { batch: { select: { assessmentId: true } } } })
  if (page.status !== 'DONE' || !page.version) throw new Error('The page is not lined up yet')
  const ctx = await contextFor(page.batch.assessmentId)
  const slots = slotsForVersion(ctx.assessment, ctx.layout, ctx.key, page.version)
  const blank = inkBlanks(page)
  const dir = pageDir(page.batchId, page.index)

  // One region per distinct box (an enzyme blank and its cofactor arrow share one on the
  // glycolysis form), holding the slots in it that have writing. Identity slots never go.
  const byBox = new Map<string, GradedSlot[]>()
  for (const g of slots) {
    if (g.ref.kind === 'identity' || blank.has(g.slot.id)) continue
    const k = JSON.stringify(g.slot.box)
    byBox.set(k, [...(byBox.get(k) ?? []), g])
  }
  const regions: Region[] = []
  for (const group of byBox.values()) {
    const crop = path.join(dir, `crop-${group[0]!.slot.id}.png`)
    regions.push({ id: group[0]!.slot.id, png: await fs.readFile(crop), slots: group })
  }
  const pick = (kinds: string[]) => regions
    .map((r) => ({ ...r, slots: r.slots.filter((s) => kinds.includes(s.ref.kind)) }))
    .filter((r) => r.slots.length)

  const client = new Anthropic({ apiKey: config.anthropicApiKey })
  const textRegions = pick(['enzyme', 'cofactors'])
  const structRegions = pick(['structure'])
  const [text, struct] = await Promise.all([
    textRegions.length ? readTextRegions(client, ctx.key, textRegions, { model: MODEL_TEXT, cache: dbCache }) : null,
    structRegions.length ? readStructureRegions(client, structRegions, { model: MODEL_STRUCTURE, cache: dbCache }) : null,
  ])
  const reads: PageReads = {
    text: Object.fromEntries(text?.reads ?? []),
    structure: Object.fromEntries(struct?.reads ?? []),
  }
  const usage: Usage[] = [text?.usage, struct?.usage].filter((u): u is Usage => !!u)
  await prisma.quizPage.update({
    where: { id: pageId },
    data: { reads: reads as unknown as Prisma.InputJsonValue, usage: usage as unknown as Prisma.InputJsonValue },
  })
  await scorePage(pageId, ctx)
  await prisma.quizPage.update({ where: { id: pageId }, data: { gradeStatus: 'GRADED', gradedAt: new Date(), gradeError: null, gradeClaimedAt: null } })
}

/**
 * Re-score every graded page of an assessment from its stored reads: after the key,
 * the points or the review rules change. No model calls.
 */
export async function rescoreAssessment(assessmentId: string): Promise<number> {
  const ctx = await contextFor(assessmentId)
  const pages = await prisma.quizPage.findMany({
    where: { gradeStatus: 'GRADED', batch: { assessmentId } },
    select: { id: true },
  })
  for (const p of pages) await scorePage(p.id, ctx)
  return pages.length
}

/** Re-score everything that depends on a key or assessment that was just edited. */
export async function rescoreAfterEdit(professorId: string, kind: string, slug: string): Promise<void> {
  const field = kind === 'KEY' ? 'key' : kind === 'LAYOUT' ? 'layout' : null
  const assessments = await prisma.quizContent.findMany({ where: { professorId, kind: 'ASSESSMENT' }, select: { id: true, slug: true, source: true } })
  for (const a of assessments) {
    let uses = kind === 'ASSESSMENT' && a.slug === slug
    if (field) { try { uses = parseSource(a.source)[field] === slug } catch { uses = false } }
    if (!uses) continue
    try {
      const n = await rescoreAssessment(a.id)
      if (n) logger.info('quiz pages re-scored after an edit', { assessment: a.slug, pages: n })
    } catch (e) {
      logger.warn('re-scoring after an edit failed', { assessment: a.slug, error: (e as Error).message })
    }
  }
}

// ── The worker ─────────────────────────────────────────────────────────────────

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
    const giveUp = !page || page.gradeAttempts >= MAX_ATTEMPTS || e instanceof Anthropic.AuthenticationError
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
