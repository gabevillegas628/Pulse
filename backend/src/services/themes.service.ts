import Anthropic from '@anthropic-ai/sdk'
import * as z4 from 'zod/v4'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { prisma } from '../db/index.js'
import { config } from '../config/index.js'
import { AppError } from '../middleware/error.middleware.js'
import { getIo } from '../socket.js'
import { logger } from '../utils/logger.js'

/**
 * Live AI themes for FREE_TEXT answers. See live_ai_themes_spec.md.
 *
 * Phase 1 covers persistence only: the professor presses "Summarize responses", the
 * categories and their per-response assignments are stored, and a reload reads them
 * back. The debounced classifier that keeps them growing during a lecture is phase 2.
 *
 * Two invariants hold from here on:
 *  - Counts are never stored. They are derived from ResponseTheme, so they cannot drift.
 *  - Exactly one category per set is the "Forming" bucket, created here rather than by
 *    the model, so a low-confidence answer is never forced into a wrong bin.
 */

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey })

/** Bootstrap is the one call where a bad result poisons everything downstream. */
const BOOTSTRAP_MODEL = 'claude-opus-5'
/** Classification is high-volume, short-output and easy. Spend accordingly. */
const CLASSIFY_MODEL = 'claude-haiku-4-5'

/** Below this, the model's choice is not trusted and the answer goes to Forming. */
const MIN_CONFIDENCE = 0.6

// Tuning. See live_ai_themes_spec.md §3.1 for the reasoning behind each.
/** Answers required before categories are derived at all. */
export const BOOTSTRAP_N = 8
/**
 * Most answers the clustering call ever sees at once.
 *
 * Bootstrap is the one call that cannot be batched — clustering means looking at
 * everything together — so it is capped instead. Without this its output grows with the
 * class: at roughly 15 tokens per assignment, a 500-answer lecture would truncate
 * against max_tokens and dump the overflow into Forming. Forty answers cluster just as
 * well as four hundred, and everyone else goes through the batched classifier.
 */
const BOOTSTRAP_SAMPLE_MAX = 40
/** Small, so bars step visibly in the room rather than lurching in one jump. */
const CLASSIFY_BATCH = 8
/**
 * Bigger batch for working through a backlog, where smooth growth does not matter and
 * finishing does — pressing summarize on a lecture that has already ended, say.
 */
const CLASSIFY_BATCH_CATCHUP = 25
/** Backlog size that switches to the larger batch. */
const CATCHUP_THRESHOLD = 50
/** Quiet period after the last answer before work starts. */
const DEBOUNCE_MS = 2000
/** Ceiling on that quiet period, so a steady stream of answers still gets processed. */
const MAX_WAIT_MS = 6000
/** Share sitting in Forming that suggests the categories are wrong. */
const RECLUSTER_OTHER_RATIO = 0.3
/** Never re-cluster on thin data. */
const RECLUSTER_MIN_TOTAL = 20
/** Labels must never churn on a projector. */
const RECLUSTER_COOLDOWN_MS = 60_000
/**
 * Hard ceiling per theme set — bounds a bug, not the bill. At the catch-up batch size
 * this covers roughly 2,000 answers, so it will only ever be hit by a loop that is
 * failing to make progress. Shared with re-clusters, which inherit the count.
 */
const MAX_CLASSIFY_CALLS = 80

export const OTHER_LABEL = 'Still forming'
const OTHER_DESCRIPTION = 'Answers that do not yet fit a category cleanly.'

// ─── Public shape ─────────────────────────────────────────────────────────────

export interface ThemeCategoryDto {
  id: string
  label: string
  description: string
  count: number
  isOther: boolean
}

export interface ThemeSetDto {
  status: 'WAITING' | 'BOOTSTRAPPING' | 'ACTIVE' | 'RECLUSTERING' | 'FAILED'
  categories: ThemeCategoryDto[]
  classified: number
  total: number
  model: string | null
  /** WAITING only: how many answers are needed before categories appear. */
  need?: number
}

// ─── Enablement ───────────────────────────────────────────────────────────────

/**
 * Whether live theming is on for a question. Per-question `liveThemes` wins; null
 * inherits the class default. Resolved outside the lecture, never during one.
 */
export function themesEnabled(
  question: { type: string; liveThemes: boolean | null },
  cls: { liveThemesDefault: boolean }
): boolean {
  if (question.type !== 'FREE_TEXT') return false
  return question.liveThemes ?? cls.liveThemesDefault
}

// ─── Reading ──────────────────────────────────────────────────────────────────

/**
 * The theme set for a question in a run, with counts derived rather than stored.
 * Returns null when nothing has been derived yet — the caller decides what that means.
 */
export async function readThemeSet(questionId: string, runId: string): Promise<ThemeSetDto | null> {
  const set = await prisma.themeSet.findUnique({
    where: { questionId_runId: { questionId, runId } },
    include: { categories: { orderBy: { order: 'asc' } } },
  })
  if (!set) return null

  const counts = await prisma.responseTheme.groupBy({
    by: ['categoryId'],
    where: { category: { themeSetId: set.id } },
    _count: { _all: true },
  })
  const countByCategory = new Map(counts.map((c) => [c.categoryId, c._count._all]))

  const total = await prisma.response.count({ where: { questionId, runId } })
  const classified = counts.reduce((sum, c) => sum + c._count._all, 0)

  return {
    status: set.status,
    categories: set.categories.map((c) => ({
      id: c.id,
      label: c.label,
      description: c.description,
      count: countByCategory.get(c.id) ?? 0,
      isOther: c.isOther,
    })),
    classified,
    total,
    model: set.model,
  }
}

/** The run a question's themes belong to: the session's most recent, open or closed. */
export async function latestRunId(sessionId: string): Promise<string | null> {
  const run = await prisma.sessionRun.findFirst({
    where: { sessionId },
    orderBy: { openedAt: 'desc' },
    select: { id: true },
  })
  return run?.id ?? null
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

/**
 * Categories plus an assignment for every answer the model was shown.
 *
 * The spec describes bootstrap as deriving categories only, with classification as a
 * separate pass. Asking for both in one call is strictly better here: the model has
 * already read every answer to cluster them, so a second pass over the same text would
 * be paid twice for no gain. Phase 2's classifier handles only answers that arrive
 * after this point.
 */
const bootstrapSchema = z4.object({
  categories: z4
    .array(
      z4.object({
        label: z4.string(),
        description: z4.string(),
      })
    )
    .min(2)
    .max(6),
  assignments: z4.array(
    z4.object({
      index: z4.number().int(),
      // Index into `categories`, or -1 when the answer fits none of them.
      category: z4.number().int(),
      confidence: z4.number().min(0).max(1),
    })
  ),
})

interface AnswerRow {
  id: string
  responseText: string
}

/** At most `max` items, spread evenly across the list rather than taken from one end. */
function evenSample<T>(rows: T[], max: number): T[] {
  if (rows.length <= max) return rows
  const step = rows.length / max
  const out: T[] = []
  for (let i = 0; i < max; i++) out.push(rows[Math.floor(i * step)]!)
  return out
}

async function callBootstrap(questionText: string, answers: AnswerRow[]) {
  const list = answers.map((a, i) => `[${i}] ${a.responseText}`).join('\n')

  // No `temperature` here: it is deprecated on Opus 5 and the API rejects the request
  // outright with a 400. The older grading calls on claude-sonnet-4-6 still accept it.
  const res = await anthropic.messages.parse({
    model: BOOTSTRAP_MODEL,
    max_tokens: 8192,
    output_config: { format: zodOutputFormat(bootstrapSchema) },
    messages: [
      {
        role: 'user',
        content: `You are analysing student responses to a classroom question. Group them into 3-4 distinct themes, then assign every response to one of those themes.

Question asked: "${questionText}"

Student responses (${answers.length} total, indexed 0 to ${answers.length - 1}):
${list}

Rules:
- Give each category a short label and a one-sentence description of what those students said. Be concise and objective.
- Categories must describe what students actually said, not what a correct answer would be.
- Every category must describe a genuine attempt to answer the question.
- Do NOT create a catch-all or "other" category. If a response fits none of your categories, assign it category -1.
- Do NOT create a category for non-answers — blank, off-topic, joke, keyboard-mash, or "I don't know" responses. Assign every one of those category -1, however many of them there are. This holds even if they would form one of the largest groups.
- Use confidence below 0.6 when you are unsure rather than guessing.
- Return exactly one assignment for every index from 0 to ${answers.length - 1}.`,
      },
    ],
  })

  const parsed = res.parsed_output
  if (!parsed) throw new AppError('Could not read categories from the AI response', 502)
  return parsed
}

/**
 * Derive and persist categories for a question in a run, replacing anything already
 * there. Returns the stored set with derived counts.
 */
export async function bootstrapThemeSet(
  questionId: string,
  runId: string,
  questionText: string,
  // Carried across a re-cluster: the replacement set inherits the old call count, so
  // re-clustering cannot be used to reset the per-set spend ceiling.
  carryClassifyCalls = 0
): Promise<ThemeSetDto> {
  const all = await prisma.response.findMany({
    where: { questionId, runId },
    orderBy: { submittedAt: 'asc' },
    select: { id: true, responseText: true },
  })
  if (all.length === 0) throw new AppError('No responses to categorise', 400)

  // Spread the sample across submission order rather than taking the first N. The
  // students who answer first are not a random sample of the room, and categories
  // derived only from them would miss where the rest of the class went.
  const answers = evenSample(all, BOOTSTRAP_SAMPLE_MAX)

  const parsed = await callBootstrap(questionText, answers)

  // Anything the model omitted, sent out of range, or was unsure about goes to Forming.
  const byIndex = new Map(parsed.assignments.map((a) => [a.index, a]))

  await prisma.$transaction(async (tx) => {
    // Re-running replaces the previous set outright; cascades clear its categories
    // and assignments, so counts can never blend two generations of labels.
    await tx.themeSet.deleteMany({ where: { questionId, runId } })

    const set = await tx.themeSet.create({
      data: {
        questionId,
        runId,
        status: 'ACTIVE',
        model: BOOTSTRAP_MODEL,
        bootstrapN: answers.length,
        classifyCalls: carryClassifyCalls,
        lastClusteredAt: new Date(),
      },
    })

    const created = await Promise.all(
      parsed.categories.map((c, i) =>
        tx.themeCategory.create({
          data: { themeSetId: set.id, label: c.label, description: c.description, order: i },
        })
      )
    )
    // Always last, always exactly one, never invented by the model.
    const other = await tx.themeCategory.create({
      data: {
        themeSetId: set.id,
        label: OTHER_LABEL,
        description: OTHER_DESCRIPTION,
        order: parsed.categories.length,
        isOther: true,
      },
    })

    await tx.responseTheme.createMany({
      data: answers.map((answer, i) => {
        const a = byIndex.get(i)
        const target =
          a && a.category >= 0 && a.category < created.length && a.confidence >= MIN_CONFIDENCE
            ? created[a.category]!
            : other
        return {
          responseId: answer.id,
          categoryId: target.id,
          confidence: a?.confidence ?? null,
          source: 'AI' as const,
        }
      }),
    })
  })

  const dto = await readThemeSet(questionId, runId)
  if (!dto) throw new AppError('Themes were not stored', 500)

  logger.info('Themes bootstrapped', {
    questionId,
    runId,
    categories: parsed.categories.length,
    sampled: answers.length,
    total: all.length,
    // Anything beyond the sample is left unassigned on purpose; the batched classifier
    // picks it up on the next drain.
    awaitingClassification: all.length - answers.length,
    forming: dto.categories.find((c) => c.isOther)?.count ?? 0,
  })

  return dto
}

// ─── Classification ───────────────────────────────────────────────────────────

/**
 * Assign answers to categories that already exist.
 *
 * The category id is constrained to an enum of the real ids plus "other", so a drifting
 * or invented label is impossible by construction rather than by parsing. Note that
 * "other" comes back with high confidence when the model is *sure* an answer fits
 * nothing — so "other" means Forming regardless of its score, and the confidence floor
 * applies only to the real categories.
 */
const classifySchema = (categoryIds: string[]) =>
  z4.object({
    assignments: z4.array(
      z4.object({
        index: z4.number().int(),
        categoryId: z4.enum(['other', ...categoryIds] as [string, ...string[]]),
        confidence: z4.number().min(0).max(1),
      })
    ),
  })

async function callClassify(
  questionText: string,
  categories: Array<{ id: string; label: string; description: string }>,
  answers: AnswerRow[]
) {
  const catList = categories.map((c) => `- ${c.id}: ${c.label} — ${c.description}`).join('\n')
  const list = answers.map((a, i) => `[${i}] ${a.responseText}`).join('\n')

  const res = await anthropic.messages.parse({
    model: CLASSIFY_MODEL,
    max_tokens: 1024,
    temperature: 0,
    output_config: { format: zodOutputFormat(classifySchema(categories.map((c) => c.id))) },
    messages: [
      {
        role: 'user',
        content: `Assign each student answer to one of the existing categories for this question.

Question: "${questionText}"

Categories:
${catList}

Answers (${answers.length} total, indexed 0 to ${answers.length - 1}):
${list}

Rules:
- Use the category id exactly as written above.
- Use "other" when an answer genuinely fits none of the categories, including when it is junk, empty of content, or off topic.
- Do not stretch a category to fit. "other" is the right answer more often than a bad match is.
- Use confidence below 0.6 when you are unsure rather than guessing.
- Return exactly one assignment for every index from 0 to ${answers.length - 1}.`,
      },
    ],
  })

  const parsed = res.parsed_output
  if (!parsed) throw new Error('classify returned no parsable output')
  return parsed
}

/**
 * Classify one batch of not-yet-assigned answers. Returns how many were assigned.
 * A batch that fails twice takes the whole set to FAILED — the projector then falls
 * back to plain counts rather than showing a half-built picture forever.
 */
async function classifyNextBatch(
  setId: string,
  questionId: string,
  runId: string,
  questionText: string,
  backlog: number
): Promise<number> {
  // A trickle of answers during a lecture wants small batches so the bars step visibly.
  // A large backlog — summarising a finished session, or a bootstrap that sampled only
  // part of a big class — just wants to be done.
  const take = backlog > CATCHUP_THRESHOLD ? CLASSIFY_BATCH_CATCHUP : CLASSIFY_BATCH

  const [categories, answers] = await Promise.all([
    prisma.themeCategory.findMany({
      where: { themeSetId: setId },
      orderBy: { order: 'asc' },
      select: { id: true, label: true, description: true, isOther: true },
    }),
    prisma.response.findMany({
      where: { questionId, runId, theme: { is: null } },
      orderBy: { submittedAt: 'asc' },
      take,
      select: { id: true, responseText: true },
    }),
  ])
  if (answers.length === 0) return 0

  const real = categories.filter((c) => !c.isOther)
  const other = categories.find((c) => c.isOther)
  if (!other || real.length === 0) throw new Error('theme set is missing its categories')

  let parsed: Awaited<ReturnType<typeof callClassify>>
  try {
    parsed = await callClassify(questionText, real, answers)
  } catch (first) {
    logger.warn('Classify batch failed, retrying once', {
      questionId,
      error: first instanceof Error ? first.message : String(first),
    })
    try {
      parsed = await callClassify(questionText, real, answers)
    } catch (second) {
      logger.error('Classify batch failed twice, marking set FAILED', {
        questionId,
        error: second instanceof Error ? second.message : String(second),
      })
      await prisma.themeSet.update({ where: { id: setId }, data: { status: 'FAILED' } })
      return 0
    }
  }

  const byIndex = new Map(parsed.assignments.map((a) => [a.index, a]))
  const realById = new Map(real.map((c) => [c.id, c]))

  await prisma.$transaction([
    prisma.responseTheme.createMany({
      data: answers.map((answer, i) => {
        const a = byIndex.get(i)
        // "other", an unknown id, a missing entry, or low confidence on a real category
        // all mean the same thing: not confidently placed, so it waits in Forming.
        const target =
          a && a.categoryId !== 'other' && realById.has(a.categoryId) && a.confidence >= MIN_CONFIDENCE
            ? a.categoryId
            : other.id
        return {
          responseId: answer.id,
          categoryId: target,
          confidence: a?.confidence ?? null,
          source: 'AI' as const,
        }
      }),
      skipDuplicates: true,
    }),
    prisma.themeSet.update({ where: { id: setId }, data: { classifyCalls: { increment: 1 } } }),
  ])

  return answers.length
}

// ─── Emitting ─────────────────────────────────────────────────────────────────

/**
 * The set as the projector should see it, including the pre-bootstrap state. No row is
 * written before there are enough answers to cluster, so "waiting" is synthesised
 * rather than stored — the progress line still needs something to render.
 */
export async function readOrWaiting(questionId: string, runId: string): Promise<ThemeSetDto> {
  const dto = await readThemeSet(questionId, runId)
  if (dto) return dto
  const total = await prisma.response.count({ where: { questionId, runId } })
  return { status: 'WAITING', categories: [], classified: 0, total, model: null, need: BOOTSTRAP_N }
}

/** Aggregate only — this reaches a lecture-hall projector, so no identity may ride along. */
async function emitThemes(sessionId: string, questionId: string, runId: string): Promise<void> {
  try {
    const themes = await readOrWaiting(questionId, runId)
    getIo().to(`${sessionId}:professor`).emit('themes_updated', { questionId, runId, ...themes })
  } catch (err) {
    // A socket that is not up must never stop classification; polling still catches up.
    logger.warn('Could not emit themes_updated', {
      questionId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

// ─── The debounced worker ─────────────────────────────────────────────────────

interface Pending {
  timer: NodeJS.Timeout
  firstQueuedAt: number
  running: boolean
  again: boolean
}

/**
 * In-memory debounce state, keyed by question and run.
 *
 * This assumes a single app instance: two would both classify the same answers. Railway
 * runs one today. If that changes, claim work with a conditional update on ThemeSet
 * before doing it — see live_ai_themes_spec.md section 3.1.
 */
const pending = new Map<string, Pending>()
const workKey = (questionId: string, runId: string) => `${questionId}:${runId}`

/**
 * Ask for theme work after an answer arrives. Returns immediately and never throws:
 * a student must never wait on, or be failed by, an LLM call.
 */
export function scheduleThemeWork(questionId: string, runId: string, sessionId: string): void {
  try {
    const k = workKey(questionId, runId)
    const now = Date.now()
    const existing = pending.get(k)

    if (existing) {
      // Mid-drain: note that more arrived rather than starting a second pass.
      if (existing.running) {
        existing.again = true
        return
      }
      clearTimeout(existing.timer)
      // A steady stream would otherwise push the deadline back forever, so the wait is
      // capped: once MAX_WAIT_MS has passed since the first queued answer, run now.
      const waited = now - existing.firstQueuedAt
      const delay = waited >= MAX_WAIT_MS ? 0 : Math.min(DEBOUNCE_MS, MAX_WAIT_MS - waited)
      existing.timer = setTimeout(() => void fire(k, questionId, runId, sessionId), delay)
      return
    }

    pending.set(k, {
      firstQueuedAt: now,
      running: false,
      again: false,
      timer: setTimeout(() => void fire(k, questionId, runId, sessionId), DEBOUNCE_MS),
    })
  } catch (err) {
    logger.error('Could not schedule theme work', {
      questionId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

async function fire(k: string, questionId: string, runId: string, sessionId: string): Promise<void> {
  const entry = pending.get(k)
  if (!entry || entry.running) return
  entry.running = true
  entry.again = false

  let again = false
  try {
    again = await drainThemeWork(questionId, runId, sessionId)
  } catch (err) {
    logger.error('Theme work failed', {
      questionId,
      runId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  const more = again || entry.again
  if (more) {
    entry.running = false
    entry.firstQueuedAt = Date.now()
    // Work already known to exist runs straight away; a late arrival waits out the usual
    // quiet period, so a trickle of answers does not become one API call per answer.
    entry.timer = setTimeout(() => void fire(k, questionId, runId, sessionId), again ? 0 : DEBOUNCE_MS)
    return
  }
  pending.delete(k)
}

/**
 * One unit of work. Returns true when there is definitely more to do straight away.
 *
 *   no set, too few answers  -> emit progress, wait
 *   no set, enough answers   -> bootstrap (which also assigns everything it saw)
 *   active, unassigned left  -> classify one batch
 *   active, all assigned     -> consider re-clustering
 *   failed                   -> stop; the projector falls back to counts
 */
async function drainThemeWork(questionId: string, runId: string, sessionId: string): Promise<boolean> {
  const question = await prisma.question.findUnique({
    where: { id: questionId },
    select: { text: true },
  })
  if (!question) return false

  const set = await prisma.themeSet.findUnique({
    where: { questionId_runId: { questionId, runId } },
    select: { id: true, status: true, classifyCalls: true, lastClusteredAt: true },
  })

  if (!set) {
    const total = await prisma.response.count({ where: { questionId, runId } })
    if (total < BOOTSTRAP_N) {
      await emitThemes(sessionId, questionId, runId)
      return false
    }
    logger.info('Bootstrapping themes', { questionId, runId, answers: total })
    await bootstrapThemeSet(questionId, runId, question.text)
    await emitThemes(sessionId, questionId, runId)
    // Bootstrap only assigns the answers it sampled. On a large class the rest are still
    // unassigned, so keep going rather than stopping with most of the room uncounted.
    const left = await prisma.response.count({ where: { questionId, runId, theme: { is: null } } })
    return left > 0
  }

  if (set.status === 'FAILED') return false

  const unclassified = await prisma.response.count({
    where: { questionId, runId, theme: { is: null } },
  })

  if (unclassified > 0) {
    if (set.classifyCalls >= MAX_CLASSIFY_CALLS) {
      logger.warn('Classify ceiling reached for theme set', { questionId, runId, calls: set.classifyCalls })
      return false
    }
    const done = await classifyNextBatch(set.id, questionId, runId, question.text, unclassified)
    await emitThemes(sessionId, questionId, runId)
    return done > 0 && unclassified > done
  }

  if (await maybeRecluster(set, questionId, runId, question.text)) {
    await emitThemes(sessionId, questionId, runId)
  }
  return false
}

/**
 * Re-derive categories when too many answers have collected in Forming — a sign the
 * original categories missed where the class actually went. Rate-limited hard: labels
 * changing on a projector reads as instability, so this must be rare and deliberate.
 */
async function maybeRecluster(
  set: { id: string; classifyCalls: number; lastClusteredAt: Date | null },
  questionId: string,
  runId: string,
  questionText: string
): Promise<boolean> {
  if (set.classifyCalls >= MAX_CLASSIFY_CALLS) return false
  if (set.lastClusteredAt && Date.now() - set.lastClusteredAt.getTime() < RECLUSTER_COOLDOWN_MS) return false

  const other = await prisma.themeCategory.findFirst({
    where: { themeSetId: set.id, isOther: true },
    select: { id: true },
  })
  if (!other) return false

  const [inForming, total] = await Promise.all([
    prisma.responseTheme.count({ where: { categoryId: other.id } }),
    prisma.response.count({ where: { questionId, runId } }),
  ])
  if (total < RECLUSTER_MIN_TOTAL) return false
  if (inForming / total <= RECLUSTER_OTHER_RATIO) return false

  logger.info('Re-clustering themes', { questionId, runId, inForming, total })
  await prisma.themeSet.update({ where: { id: set.id }, data: { status: 'RECLUSTERING' } })
  await bootstrapThemeSet(questionId, runId, questionText, set.classifyCalls + 1)
  return true
}
