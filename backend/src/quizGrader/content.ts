/**
 * The three content layers of the quiz grader — pathway key, layout, assessment — and
 * the rules that join them. See docs/quiz-grader/SCHEMA.md.
 *
 * Nothing here knows about glycolysis or the TCA cycle. A new quiz is new YAML.
 */
import { z } from 'zod'
import { parse } from 'yaml'

// ── Pathway key ────────────────────────────────────────────────────────────────

const intermediateSchema = z.object({
  name: z.string(),
  accept: z.array(z.string()).default([]),
  features: z.array(z.string()).default([]),
  feature_weights: z.array(z.number()).optional(),
})

const cofactorSpecSchema = z.object({
  in: z.array(z.array(z.string())).default([]),
  out: z.array(z.array(z.string())).default([]),
  optional: z.array(z.string()).default([]),
})

const stepSchema = z.object({
  from: z.array(z.string()),
  to: z.array(z.string()),
  enzyme: z.object({ accept: z.array(z.string()).min(1) }),
  cofactors: cofactorSpecSchema.optional(),
})

export const pathwayKeySchema = z.object({
  pathway: z.string(),
  title: z.string(),
  intermediates: z.record(intermediateSchema),
  // YAML reads `1:` as a number; records stringify their keys, so steps are keyed "1".
  steps: z.record(stepSchema),
})

export type PathwayKey = z.infer<typeof pathwayKeySchema>
export type Intermediate = z.infer<typeof intermediateSchema>
export type Step = z.infer<typeof stepSchema>
export type CofactorSpec = z.infer<typeof cofactorSpecSchema>

// ── Layout ─────────────────────────────────────────────────────────────────────

export const SLOT_TYPES = ['text', 'cofactor_set', 'structure', 'identity'] as const
export type SlotType = (typeof SLOT_TYPES)[number]

/** [x, y, w, h] as fractions of the page, so a box survives any scan resolution. */
const boxSchema = z.tuple([z.number(), z.number(), z.number(), z.number()])
export type Box = z.infer<typeof boxSchema>

const slotSchema = z.object({
  id: z.string(),
  type: z.enum(SLOT_TYPES),
  ref: z.string(),
  /** Which end of a cofactor arrow is the "in" side. */
  in_end: z.enum(['top', 'bottom', 'left', 'right']).nullable().optional(),
  box: boxSchema.nullable(),
})

export const layoutSchema = z.object({
  layout: z.string(),
  page: z.object({ size: z.string(), source_pdf: z.string() }),
  markers: z.object({ dictionary: z.string(), ids: z.array(z.number()) }).optional(),
  slots: z.array(slotSchema),
})

export type Layout = z.infer<typeof layoutSchema>
export type LayoutSlot = z.infer<typeof slotSchema>

// ── Assessment ─────────────────────────────────────────────────────────────────

const reviewPolicy = z.enum(['always', 'low_confidence', 'never'])
export type ReviewPolicy = z.infer<typeof reviewPolicy>

const stepSelection = z.union([z.literal('all'), z.array(z.number())])

export const assessmentSchema = z.object({
  assessment: z.string(),
  key: z.string(),
  layout: z.string(),
  defaults: z.object({
    points: z.object({
      enzyme: z.number().default(1),
      cofactors: z.number().default(1),
      structure: z.number().default(2),
    }),
    structure_review: reviewPolicy.default('always'),
    text_review: reviewPolicy.default('low_confidence'),
  }),
  grade: z.object({
    enzymes: stepSelection.default('all'),
    cofactors: stepSelection.default('all'),
  }),
  versions: z.record(z.object({ structures: z.array(z.string()).default([]) })),
})

export type Assessment = z.infer<typeof assessmentSchema>

// ── Loading ────────────────────────────────────────────────────────────────────

export const parsePathwayKey = (src: string): PathwayKey => pathwayKeySchema.parse(parse(src))
export const parseLayout = (src: string): Layout => layoutSchema.parse(parse(src))
export const parseAssessment = (src: string): Assessment => assessmentSchema.parse(parse(src))

// ── Resolving a slot against the key ───────────────────────────────────────────

/**
 * What a slot's `ref` points at. Refs are `step.<n>.enzyme`, `step.<n>.cofactors`,
 * `intermediate.<id>`, or `student.<field>`.
 */
export type ResolvedRef =
  | { kind: 'enzyme'; stepNo: string; step: Step }
  | { kind: 'cofactors'; stepNo: string; step: Step; spec: CofactorSpec }
  | { kind: 'structure'; id: string; intermediate: Intermediate }
  | { kind: 'identity'; field: string }

export function resolveRef(key: PathwayKey, ref: string): ResolvedRef {
  const parts = ref.split('.')
  if (parts[0] === 'student' && parts.length === 2) return { kind: 'identity', field: parts[1]! }

  if (parts[0] === 'intermediate' && parts.length === 2) {
    const intermediate = key.intermediates[parts[1]!]
    if (!intermediate) throw new Error(`Unknown intermediate "${parts[1]}" in ref ${ref}`)
    return { kind: 'structure', id: parts[1]!, intermediate }
  }

  if (parts[0] === 'step' && parts.length === 3) {
    const stepNo = parts[1]!
    const step = key.steps[stepNo]
    if (!step) throw new Error(`Unknown step ${stepNo} in ref ${ref}`)
    if (parts[2] === 'enzyme') return { kind: 'enzyme', stepNo, step }
    if (parts[2] === 'cofactors') {
      if (!step.cofactors) throw new Error(`Step ${stepNo} has no cofactors in the key (ref ${ref})`)
      return { kind: 'cofactors', stepNo, step, spec: step.cofactors }
    }
  }

  throw new Error(`Unrecognised slot ref "${ref}"`)
}

const selects = (sel: 'all' | number[], stepNo: string) => sel === 'all' || sel.includes(Number(stepNo))

/** One slot of one version, joined to everything needed to read and score it. */
export interface GradedSlot {
  slot: LayoutSlot
  ref: ResolvedRef
  /** 0 for identity slots, which are read but never scored. */
  maxPoints: number
  review: ReviewPolicy
}

/**
 * The slots a version reads, in layout order. Identity slots are always read; a
 * structure is read only when this version grades it. Throws on a version the
 * assessment does not define, or a graded slot with no box drawn yet.
 */
export function slotsForVersion(
  assessment: Assessment,
  layout: Layout,
  key: PathwayKey,
  version: string,
): GradedSlot[] {
  const v = assessment.versions[version]
  if (!v) {
    const known = Object.keys(assessment.versions).join(', ')
    throw new Error(`Version "${version}" is not in ${assessment.assessment} (has: ${known})`)
  }
  const { points, text_review, structure_review } = assessment.defaults
  const out: GradedSlot[] = []

  for (const slot of layout.slots) {
    const ref = resolveRef(key, slot.ref)
    let graded: GradedSlot | null = null

    if (ref.kind === 'identity') graded = { slot, ref, maxPoints: 0, review: 'never' }
    else if (ref.kind === 'enzyme' && selects(assessment.grade.enzymes, ref.stepNo))
      graded = { slot, ref, maxPoints: points.enzyme, review: text_review }
    else if (ref.kind === 'cofactors' && selects(assessment.grade.cofactors, ref.stepNo))
      graded = { slot, ref, maxPoints: points.cofactors, review: text_review }
    else if (ref.kind === 'structure' && v.structures.includes(ref.id))
      graded = { slot, ref, maxPoints: points.structure, review: structure_review }

    if (!graded) continue
    if (!slot.box) throw new Error(`Slot ${slot.id} is graded but has no box in ${layout.layout}`)
    out.push(graded)
  }
  return out
}
