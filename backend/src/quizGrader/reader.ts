/**
 * The vision model's half of grading: it transcribes handwriting and answers yes/no
 * feature questions about drawings. It is never asked whether an answer is correct.
 *
 * Name and NetID crops are never sent. Every crop that reaches the model is one blank
 * cut from the page, so the model sees answers, not who wrote them. readTextRegions
 * refuses identity slots outright, and slotsForVersion refuses layouts whose answer
 * boxes overlap a name or NetID box.
 *
 * One request per page per model: every text-like region of a page goes to the text
 * model together, every structure to the structure model. Regions are sent once even
 * when several slots share a box (an enzyme blank and its cofactor arrow, on the
 * glycolysis form), and the model returns one result per slot.
 */
import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { createHash } from 'crypto'
import * as z from 'zod/v4'
import type { GradedSlot, PathwayKey } from './content.js'

/** Bump when a prompt changes, so cached reads from the old prompt are not reused. */
export const PROMPT_VERSION = 'qg-read-v1'

export const DEFAULT_MODEL_TEXT = 'claude-haiku-5-5'
export const DEFAULT_MODEL_STRUCTURE = 'claude-sonnet-5-5'

export interface Region {
  id: string
  png: Buffer
  slots: GradedSlot[]
}

export interface Usage {
  model: string
  input_tokens: number
  output_tokens: number
  cached: boolean
}

export interface ReadCache {
  get(key: string): Promise<unknown | undefined>
  set(key: string, value: unknown): Promise<void>
}

// ── Output schemas ─────────────────────────────────────────────────────────────

const textReadSchema = z.object({
  slots: z.array(
    z.object({
      slot_id: z.string(),
      status: z.enum(['blank', 'read', 'illegible']),
      /** Verbatim handwriting, for enzyme slots. Empty for cofactor slots. */
      transcription: z.string(),
      /** Every item written at the arrow, for cofactor slots. Empty otherwise. */
      cofactors: z.array(z.object({ text: z.string(), side: z.enum(['in', 'out', 'unclear']) })),
      confidence: z.number(),
    }),
  ),
})
export type TextRead = z.infer<typeof textReadSchema>['slots'][number]

const structureReadSchema = z.object({
  slots: z.array(
    z.object({
      slot_id: z.string(),
      status: z.enum(['blank', 'read', 'illegible']),
      description: z.string(),
      features: z.array(z.object({ index: z.number(), present: z.boolean(), confidence: z.number() })),
      confidence: z.number(),
    }),
  ),
})
export type StructureRead = z.infer<typeof structureReadSchema>['slots'][number]

// ── Prompt pieces ──────────────────────────────────────────────────────────────

const nameOf = (key: PathwayKey, ids: string[]) => ids.map((id) => key.intermediates[id]?.name ?? id).join(' + ')

const SIDE_TEXT: Record<string, string> = {
  top: 'Items written at the TOP end of the curved arrow (where the curve starts) go IN — they are consumed. Items at the arrowhead end come OUT — they are produced.',
  bottom: 'Items written at the BOTTOM end of the curved arrow (where the curve starts) go IN — they are consumed. Items at the arrowhead end come OUT — they are produced.',
  left: 'Items written at the LEFT end of the curved arrow go IN (consumed); items at the arrowhead end come OUT (produced).',
  right: 'Items written at the RIGHT end of the curved arrow go IN (consumed); items at the arrowhead end come OUT (produced).',
}

function describeTextSlot(key: PathwayKey, g: GradedSlot): string {
  const { ref, slot } = g
  switch (ref.kind) {
    case 'enzyme':
      return `${slot.id}: the enzyme name for step ${ref.stepNo} (${nameOf(key, ref.step.from)} → ${nameOf(key, ref.step.to)}), handwritten on the horizontal line. The expected answer is "${ref.step.enzyme.accept[0]}" (also accepted: ${ref.step.enzyme.accept.slice(1).join(', ') || 'none'}). Use this ONLY to help decipher messy letters.`
    case 'name': {
      const names = [ref.intermediate.name, ...(ref.intermediate.accept ?? [])]
      return `${slot.id}: the NAME of an intermediate, written as words or an abbreviation (not the drawn structure, which may also be in this region). The expected name is "${names[0]}" (also accepted: ${names.slice(1).join(', ') || 'none'}). Use this ONLY to help decipher messy letters; transcribe what is written. If no name is written, status "blank".`
    }
    case 'cofactors':
      return `${slot.id}: the cofactors for step ${ref.stepNo}, small items written near the ends of the curved arrow. ${SIDE_TEXT[slot.in_end ?? 'top']} Do not include the enzyme name written on the line.`
    default:
      return `${slot.id}: (not a text slot)`
  }
}

const TEXT_RULES = `You are transcribing a student's handwritten answers on a printed biochemistry pathway quiz. You do not grade anything.

Rules:
- Transcribe exactly what is written, including misspellings, abbreviations and odd capitalisation. Never correct toward the expected answer. If the expected enzyme is "hexokinase" but the student wrote "phosphofructokinase", transcribe "phosphofructokinase". If they wrote "hexokinose", transcribe "hexokinose".
- Ignore the printed form itself (lines, arrows, stars, printed labels). Ignore writing that is clearly crossed out.
- status "blank" if nothing is handwritten for that slot; "illegible" if something is written but you cannot read it; otherwise "read".
- For cofactor slots, list each written item separately (e.g. "ATP", "ADP", "NAD+", "H2O") with its side. Use side "unclear" if you cannot tell which end it belongs to. Write charges and subscripts as plain text: NAD+, Mg2+, H2O.
- confidence is your probability (0 to 1) that the transcription, and for cofactors the sides, are exactly right.
- Return exactly one entry per slot id listed, even when blank.`

const STRUCTURE_RULES = `You are inspecting a student's hand-drawn chemical structure on a printed biochemistry pathway quiz. You do not grade anything: you answer yes/no questions about what is drawn.

Rules:
- Judge only what is drawn. Fischer projections, Haworth projections, line-angle and condensed formulas are all acceptable ways to show a feature.
- Ignore the printed form (arrows, lines, stars) and anything clearly crossed out.
- The crop is generous, so it may include neighbouring answers: enzyme names, cofactors, or the molecule's name written beside the drawing. Judge only the drawn structure.
- "present" is true only if the drawing clearly shows that feature. If a feature is ambiguous, answer your best judgement and give low confidence.
- description: one line saying what molecule the drawing appears to show, in plain words.
- status "blank" if nothing is drawn, "illegible" if something is drawn but cannot be interpreted, otherwise "read".
- Return exactly one entry per slot id listed, with one feature answer per numbered feature, using the feature's index.`

// ── Calls ──────────────────────────────────────────────────────────────────────

function cacheKey(model: string, prompt: string, regions: Region[]): string {
  const h = createHash('sha256').update(PROMPT_VERSION).update(model).update(prompt)
  for (const r of regions) h.update(r.png)
  return h.digest('hex')
}

type Content = Anthropic.ContentBlockParam[]

function regionBlocks(regions: Region[]): Content {
  const out: Content = []
  for (const r of regions) {
    out.push({ type: 'text', text: `Region ${r.id} (slots: ${r.slots.map((s) => s.slot.id).join(', ')}):` })
    out.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: r.png.toString('base64') } })
  }
  return out
}

async function cachedParse<S extends z.ZodType>(
  client: Anthropic,
  cache: ReadCache | undefined,
  model: string,
  effort: 'low' | 'medium' | 'high',
  prompt: string,
  regions: Region[],
  schema: S,
): Promise<{ parsed: z.infer<S>; usage: Usage }> {
  type T = z.infer<S>
  const k = cacheKey(model, prompt, regions)
  const hit = (await cache?.get(k)) as { parsed: T; usage: Usage } | undefined
  if (hit) return { parsed: hit.parsed, usage: { ...hit.usage, cached: true } }

  // Structured output guarantees the shape; retry once anyway, since a refusal or a
  // truncated response leaves parsed_output empty.
  for (let attempt = 1; ; attempt++) {
    const res = await client.messages.parse({
      model,
      max_tokens: 8192,
      output_config: { effort, format: zodOutputFormat(schema) },
      messages: [{ role: 'user', content: [...regionBlocks(regions), { type: 'text', text: prompt }] }],
    })
    const parsed = res.parsed_output as T | null
    if (parsed) {
      const usage: Usage = { model, input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens, cached: false }
      await cache?.set(k, { parsed, usage })
      return { parsed, usage }
    }
    if (attempt >= 2) throw new Error(`No parseable answer from ${model} (stop_reason ${res.stop_reason})`)
  }
}

export async function readTextRegions(
  client: Anthropic,
  key: PathwayKey,
  regions: Region[],
  opts: { model?: string; cache?: ReadCache } = {},
): Promise<{ reads: Map<string, TextRead>; usage: Usage }> {
  const model = opts.model ?? DEFAULT_MODEL_TEXT
  const slots = regions.flatMap((r) => r.slots)
  const identity = slots.filter((s) => s.ref.kind === 'identity').map((s) => s.slot.id)
  if (identity.length) {
    throw new Error(`Refusing to send ${identity.join(', ')} to the model: names and NetIDs stay local`)
  }
  const prompt = `${TEXT_RULES}\n\nSlots:\n${slots.map((s) => `- ${describeTextSlot(key, s)}`).join('\n')}`
  const { parsed, usage } = await cachedParse(client, opts.cache, model, 'low', prompt, regions, textReadSchema)
  return { reads: new Map(parsed.slots.map((s) => [s.slot_id, s])), usage }
}

export async function readStructureRegions(
  client: Anthropic,
  regions: Region[],
  opts: { model?: string; cache?: ReadCache } = {},
): Promise<{ reads: Map<string, StructureRead>; usage: Usage }> {
  const model = opts.model ?? DEFAULT_MODEL_STRUCTURE
  const lines: string[] = []
  for (const r of regions) {
    for (const g of r.slots) {
      if (g.ref.kind !== 'structure') continue
      lines.push(`- ${g.slot.id}: features to check:`)
      g.ref.intermediate.features.forEach((f, i) => lines.push(`    ${i}. ${f}`))
    }
  }
  const prompt = `${STRUCTURE_RULES}\n\nSlots:\n${lines.join('\n')}`
  const { parsed, usage } = await cachedParse(client, opts.cache, model, 'medium', prompt, regions, structureReadSchema)
  return { reads: new Map(parsed.slots.map((s) => [s.slot_id, s])), usage }
}
