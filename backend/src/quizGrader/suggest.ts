/**
 * Suggested structure checks, written by a model and tested by code before anyone sees them.
 *
 * A strong model is shown the professor's own key drawings (keyDrawings.ts) and writes, for
 * each graded intermediate, short yes/no checks: true for any correct drawing of it, and
 * together false for every other molecule in the pathway. Then the reader that grades papers
 * answers those checks on every key drawing, as it would on a student's, and code tallies:
 *
 *   - the intermediate's own drawing must pass every check (one that fails is wrong);
 *   - every other molecule's drawing must fail at least one (or the two cannot be told apart).
 *
 * Checks with problems go back once to be revised, with what went wrong; a check that still
 * fails on the key's own drawing is dropped. The current checks are tested the same way, so
 * the two can be compared. Nothing is saved: the professor accepts suggestions in the Key tab,
 * and they are saved like any other edit. This writes the key; it never grades a paper.
 */
import Anthropic from '@anthropic-ai/sdk'
import * as z from 'zod/v4'
import { prisma } from '../db/index.js'
import { config } from '../config/index.js'
import { logger } from '../utils/logger.js'
import type { GradedSlot, PathwayKey } from './content.js'
import { contextFor, dbCache, MODEL_STRUCTURE } from './grading.js'
import type { KeyDrawingsData } from './keyDrawings.js'
import { costOf } from './pricing.js'
import { cachedParse, readStructureRegions, type Region, type StructureRead, type Usage } from './reader.js'

export const DEFAULT_MODEL_SUGGEST = 'claude-opus-5-5'
const MODEL_SUGGEST = process.env.MODEL_SUGGEST || DEFAULT_MODEL_SUGGEST

/** How one list of checks fared on the key drawings. */
export interface CheckTest {
  /** False when the intermediate has no key drawing to test on. */
  tested: boolean
  /** Checks its own key drawing failed, with what the reader saw there. */
  keyFails: { check: string; saw: string }[]
  /** Other molecules' key drawings that pass every check: not told apart. */
  confusedWith: { id: string; name: string }[]
  /** Other molecules' key drawings that fail, and which checks they fail. */
  tellsApart: { id: string; name: string; by: string[] }[]
}

export interface CheckSuggestion {
  id: string
  name: string
  current: string[]
  currentTest: CheckTest | null
  suggested: string[]
  suggestedTest: CheckTest
  /** Suggested checks the key's own drawing failed even after a revision: left out. */
  dropped: { check: string; saw: string }[]
  /** Whether the first suggestion had problems and was sent back once. */
  revised: boolean
}

export interface SuggestJob {
  status: 'running' | 'done' | 'failed'
  step: string
  startedAt: string
  finishedAt?: string
  error?: string
  /** The key as it was when suggestions were made: accepting them over a newer key is refused in the app. */
  keyUpdatedAt?: string
  result?: { items: CheckSuggestion[]; dollars: number; models: string[]; drawings: number }
}

// ── Prompts ────────────────────────────────────────────────────────────────────

const suggestionSchema = z.object({
  intermediates: z.array(z.object({ id: z.string(), checks: z.array(z.string()) })),
})

const SUGGEST_RULES = `You are helping a biochemistry professor write the checks an automatic grader uses on students' hand-drawn structures. Later, a separate reader looks at one student's drawing at a time and answers each check yes or no, without being told which molecule the drawing is meant to be. Code then gives the points only if every check is yes.

The images above are the professor's own drawings from the answer key. They show the correct structures and the way this class was taught to draw them.

Rules for every check:
- One yes/no fact that a reader can verify by looking at a drawing.
- True for EVERY correct drawing of the molecule, however it is drawn: condensed formulas like the key's, line-angle (skeletal), Fischer or Haworth projections, or every atom drawn out. Do not describe how the key drawing is laid out: no "top", "bottom", "row", "line", "left", "right".
- Never use carbon numbers (C1, C2, "carbon 3"): readers and students number chains differently. Say where a group is by what it is bonded to, e.g. "at each end of the chain", "on a carbon directly bonded to a carboxylate carbon", "on a carbon bonded to three other carbons".
- When counting carbons, say whether carboxylate carbons are counted.
- Do not require what a correct drawing may leave out: hydrogens; charges (COO⁻ and COOH are both a carboxylate; a phosphate however drawn); stereochemistry or geometry, unless the key drawing shows it AND it is the only thing that tells this molecule from another in the pathway.
- Never name the molecule, and never ask whether the drawing "is" or "looks like" a molecule.

Together, one molecule's checks must rule out every other molecule in the pathway: each other molecule must fail at least one of them. Use the fewest checks that do this, usually 3 to 5.`

function pathwayList(key: PathwayKey, drawn: Set<string>): string {
  return Object.entries(key.intermediates)
    .map(([id, it]) => `- ${id}: ${it.name}${drawn.has(id) ? ' (key drawing above)' : ''}`)
    .join('\n')
}

function drawingRegions(key: PathwayKey, data: KeyDrawingsData, ids: string[]): Region[] {
  return ids.filter((id) => data.items[id]).map((id) => ({
    id, png: Buffer.from(data.items[id]!.png, 'base64'), slots: [],
    label: `Key drawing of ${key.intermediates[id]?.name ?? id} (${id}):`,
  }))
}

async function suggest(client: Anthropic, key: PathwayKey, data: KeyDrawingsData, targets: string[]) {
  const drawn = new Set(Object.keys(data.items))
  const prompt = `${SUGGEST_RULES}\n\nThe molecules in this pathway:\n${pathwayList(key, drawn)}\n\nWrite checks for each of these, returning one entry per id: ${targets.join(', ')}.`
  return cachedParse(client, dbCache, MODEL_SUGGEST, 'high', prompt, drawingRegions(key, data, Object.keys(key.intermediates)), suggestionSchema, 16000)
}

async function revise(
  client: Anthropic, key: PathwayKey, data: KeyDrawingsData,
  problems: { id: string; checks: string[]; test: CheckTest }[],
) {
  const drawn = new Set(Object.keys(data.items))
  const lines = problems.map(({ id, checks, test }) => {
    const out = [`${id} (${key.intermediates[id]?.name ?? id}). Your checks were:`, ...checks.map((c) => `  - ${c}`)]
    for (const f of test.keyFails) out.push(`  The reader said the key's own drawing of ${id} does NOT show "${f.check}". It described the drawing as: ${f.saw || '(no description)'}. Reword or replace that check so a correct drawing passes it.`)
    if (test.confusedWith.length) out.push(`  The key drawings of ${test.confusedWith.map((c) => c.name).join(', ')} passed every one of these checks, so they cannot be told apart from ${id}. Add or sharpen a check that they fail.`)
    return out.join('\n')
  })
  const prompt = `${SUGGEST_RULES}\n\nThe molecules in this pathway:\n${pathwayList(key, drawn)}\n\nYou wrote checks earlier, and they were tested: a reader answered each check on every key drawing above. These had problems:\n\n${lines.join('\n\n')}\n\nReturn a complete, revised list of checks for each of these ids: ${problems.map((p) => p.id).join(', ')}.`
  return cachedParse(client, dbCache, MODEL_SUGGEST, 'high', prompt, drawingRegions(key, data, Object.keys(key.intermediates)), suggestionSchema, 16000)
}

// ── Testing ────────────────────────────────────────────────────────────────────

/** A check list dressed as a slot, so the grading reader answers it exactly as it would on a paper. */
function asSlot(label: string, checks: string[]): GradedSlot {
  return {
    slot: { id: label, type: 'structure', ref: `intermediate.${label}`, box: [0, 0, 1, 1] },
    ref: { kind: 'structure', id: label, intermediate: { name: '', accept: [], features: checks } },
    maxPoints: 0, review: 'never', partialCredit: false,
  }
}

type Answers = Map<string, Map<string, StructureRead>> // drawing id → list id → read

/**
 * Every key drawing answers every list of checks: one reader call per drawing. Lists are
 * labelled neutrally (l1, l2…) so the reader is not told which molecule each describes.
 */
async function testLists(client: Anthropic, data: KeyDrawingsData, lists: Map<string, string[]>, usage: Usage[]): Promise<Answers> {
  const labels = [...lists.keys()]
  const slots = labels.map((id, i) => asSlot(`l${i + 1}`, lists.get(id)!))
  const back = new Map(labels.map((id, i) => [`l${i + 1}`, id]))
  const answers: Answers = new Map()
  const drawings = Object.entries(data.items)
  for (let i = 0; i < drawings.length; i += 4) {
    await Promise.all(drawings.slice(i, i + 4).map(async ([id, d]) => {
      const { reads, usage: u } = await readStructureRegions(client, [{ id: 'd', png: Buffer.from(d.png, 'base64'), slots }], { model: MODEL_STRUCTURE, cache: dbCache })
      usage.push(u)
      answers.set(id, new Map([...reads].map(([label, r]) => [back.get(label) ?? label, r])))
    }))
  }
  return answers
}

function evaluate(key: PathwayKey, data: KeyDrawingsData, answers: Answers, target: string, list: string, checks: string[]): CheckTest {
  const holds = (r: StructureRead | undefined, i: number) => !!r && r.status === 'read' && !!r.features.find((f) => f.index === i)?.present
  const own = answers.get(target)?.get(list)
  const tested = !!data.items[target]
  const keyFails = tested ? checks.flatMap((check, i) => (holds(own, i) ? [] : [{ check, saw: own?.description ?? '' }])) : []
  const confusedWith: CheckTest['confusedWith'] = []
  const tellsApart: CheckTest['tellsApart'] = []
  for (const other of Object.keys(data.items)) {
    if (other === target) continue
    const r = answers.get(other)?.get(list)
    const name = key.intermediates[other]?.name ?? other
    const by = checks.filter((_, i) => !holds(r, i))
    if (by.length) tellsApart.push({ id: other, name, by })
    else confusedWith.push({ id: other, name })
  }
  return { tested, keyFails, confusedWith, tellsApart }
}

const badness = (t: CheckTest) => t.keyFails.length * 10 + t.confusedWith.length

// ── The job ────────────────────────────────────────────────────────────────────

const jobs = new Map<string, SuggestJob>()
export const suggestJob = (assessmentId: string) => jobs.get(assessmentId) ?? null

async function run(assessmentId: string, job: SuggestJob): Promise<void> {
  const ctx = await contextFor(assessmentId)
  const row = await prisma.quizKeyDrawings.findUnique({ where: { assessmentId }, select: { drawings: true } })
  const data = row?.drawings as unknown as KeyDrawingsData | null
  if (!data || !Object.keys(data.items).length) throw new Error('Upload your filled-in answer key first: suggestions are written from its drawings and tested on them.')
  const key = ctx.key
  const targets = [...new Set(Object.values(ctx.assessment.versions).flatMap((v) => v.structures))].filter((id) => key.intermediates[id])
  if (!targets.length) throw new Error('No version grades a drawn structure (Versions tab), so there are no checks to write.')

  const client = new Anthropic({ apiKey: config.anthropicApiKey })
  const usage: Usage[] = []

  job.step = 'Writing checks from your key drawings'
  const first = await suggest(client, key, data, targets)
  usage.push(first.usage)
  const suggested = new Map(targets.map((id) => [id, first.parsed.intermediates.find((x) => x.id === id)?.checks.filter((c) => c.trim()) ?? []]))

  job.step = 'Testing the suggested and current checks on every key drawing'
  const current = new Map(targets.filter((id) => key.intermediates[id]!.features.length).map((id) => [id, key.intermediates[id]!.features]))
  const [answers, currentAnswers] = await Promise.all([
    testLists(client, data, suggested, usage),
    current.size ? testLists(client, data, current, usage) : Promise.resolve(new Map() as Answers),
  ])
  const tests = new Map(targets.map((id) => [id, evaluate(key, data, answers, id, id, suggested.get(id)!)]))

  const problems = targets.filter((id) => badness(tests.get(id)!) > 0)
  const revised = new Set<string>()
  if (problems.length) {
    job.step = `Revising checks for ${problems.length} intermediate${problems.length > 1 ? 's' : ''} that did not pass, and testing again`
    const second = await revise(client, key, data, problems.map((id) => ({ id, checks: suggested.get(id)!, test: tests.get(id)! })))
    usage.push(second.usage)
    const next = new Map(problems.map((id) => [id, second.parsed.intermediates.find((x) => x.id === id)?.checks.filter((c) => c.trim()) ?? []]).filter(([, c]) => c.length) as [string, string[]][])
    if (next.size) {
      const again = await testLists(client, data, next, usage)
      for (const [id, checks] of next) {
        const t = evaluate(key, data, again, id, id, checks)
        // Keep the revision only if it did better.
        if (badness(t) < badness(tests.get(id)!)) {
          suggested.set(id, checks)
          tests.set(id, t)
          for (const [d, m] of again) { const a = answers.get(d) ?? new Map(); a.set(id, m.get(id)!); answers.set(d, a) }
          revised.add(id)
        }
      }
    }
  }

  const items: CheckSuggestion[] = targets.map((id) => {
    let checks = suggested.get(id)!
    let test = tests.get(id)!
    const dropped = test.keyFails
    if (dropped.length) {
      // A check the key's own drawing fails would mark correct papers wrong: leave it out.
      // Re-tally from the same answers, keeping each answer with its check.
      const keep = checks.map((c, i) => ({ c, i })).filter(({ c }) => !dropped.some((d) => d.check === c))
      const remapped: Answers = new Map([...answers].map(([d, m]) => {
        const r = m.get(id)
        const features = keep.flatMap(({ i }, j) => { const f = r?.features.find((x) => x.index === i); return f ? [{ ...f, index: j }] : [] })
        return [d, new Map([[id, r ? { ...r, features } : r!]])]
      }))
      checks = keep.map(({ c }) => c)
      test = evaluate(key, data, remapped, id, id, checks)
    }
    return {
      id,
      name: key.intermediates[id]!.name,
      current: key.intermediates[id]!.features,
      currentTest: current.has(id) ? evaluate(key, data, currentAnswers, id, id, current.get(id)!) : null,
      suggested: checks,
      suggestedTest: test,
      dropped,
      revised: revised.has(id),
    }
  })
  const { dollars } = costOf(usage.filter((u) => !u.cached))
  job.result = { items, dollars, models: [...new Set(usage.map((u) => u.model))], drawings: Object.keys(data.items).length }
}

/** Start suggesting checks for a quiz in the background. One run per quiz at a time. */
export async function startSuggestion(assessmentId: string): Promise<SuggestJob> {
  const running = jobs.get(assessmentId)
  if (running?.status === 'running') return running
  if (!config.anthropicApiKey) throw new Error('Grading is not set up (ANTHROPIC_API_KEY), so there is no model to write checks.')
  const ctx = await contextFor(assessmentId)
  const a = await prisma.quizContent.findUniqueOrThrow({ where: { id: assessmentId }, select: { professorId: true } })
  const keyRow = await prisma.quizContent.findUnique({
    where: { professorId_kind_slug: { professorId: a.professorId, kind: 'KEY', slug: ctx.assessment.key } },
    select: { updatedAt: true },
  })
  const job: SuggestJob = { status: 'running', step: 'Starting', startedAt: new Date().toISOString(), keyUpdatedAt: keyRow?.updatedAt.toISOString() }
  jobs.set(assessmentId, job)
  void run(assessmentId, job)
    .then(() => { job.status = 'done'; job.step = 'Done' })
    .catch((e) => {
      job.status = 'failed'
      job.error = (e as Error).message
      logger.warn('quiz check suggestions failed', { assessmentId, error: job.error })
    })
    .finally(() => { job.finishedAt = new Date().toISOString() })
  return job
}
