import Anthropic from '@anthropic-ai/sdk'
import * as z4 from 'zod/v4'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { prisma } from '../db/index.js'
import { config } from '../config/index.js'
import { AppError } from '../middleware/error.middleware.js'
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

/** Below this, the model's choice is not trusted and the answer goes to Forming. */
const MIN_CONFIDENCE = 0.6

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
- Do NOT create a catch-all or "other" category. If a response fits none of your categories, assign it category -1.
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
  questionText: string
): Promise<ThemeSetDto> {
  const answers = await prisma.response.findMany({
    where: { questionId, runId },
    orderBy: { submittedAt: 'asc' },
    select: { id: true, responseText: true },
  })
  if (answers.length === 0) throw new AppError('No responses to categorise', 400)

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
    answers: answers.length,
    forming: dto.categories.find((c) => c.isOther)?.count ?? 0,
  })

  return dto
}
