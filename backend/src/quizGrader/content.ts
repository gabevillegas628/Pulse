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
    /** false = all or nothing: every required cofactor group, every structure feature. */
    partial_credit: z
      .object({ cofactors: z.boolean().default(true), structure: z.boolean().default(true) })
      .default({}),
    structure_review: reviewPolicy.default('always'),
    text_review: reviewPolicy.default('low_confidence'),
  }),
  grade: z.object({
    enzymes: stepSelection.default('all'),
    cofactors: stepSelection.default('all'),
  }),
  versions: z.record(z.object({
    structures: z.array(z.string()).default([]),
    /** Page of the layout's PDF printed for this version; default: its position in `versions`. */
    page: z.number().int().positive().optional(),
  })),
})

export type Assessment = z.infer<typeof assessmentSchema>

/** The 1-based page of the layout PDF that a version is printed from. */
export function versionPage(assessment: Assessment, version: string): number {
  const v = assessment.versions[version]
  if (!v) throw new Error(`Version "${version}" is not in ${assessment.assessment}`)
  return v.page ?? Object.keys(assessment.versions).indexOf(version) + 1
}

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
  /** 0 for identity slots, which are cropped for a person to match but never sent to the model or scored. */
  maxPoints: number
  review: ReviewPolicy
  /** Fractional credit for a partly right answer; false means full points or none. */
  partialCredit: boolean
}

const overlaps = (a: Box, b: Box) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3]

/**
 * The slots a version uses, in layout order. Identity slots are always included (they
 * are cropped for a person, never sent to the model); a structure is included only when
 * this version grades it. Throws on a version the assessment does not define, a graded
 * slot with no box drawn yet, or an answer box that overlaps a name or NetID box — a
 * crop of that answer would carry the student's name to the model with it.
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
  const { points, text_review, structure_review, partial_credit } = assessment.defaults
  const out: GradedSlot[] = []

  for (const slot of layout.slots) {
    const ref = resolveRef(key, slot.ref)
    let graded: GradedSlot | null = null

    if (ref.kind === 'identity') graded = { slot, ref, maxPoints: 0, review: 'never', partialCredit: false }
    else if (ref.kind === 'enzyme' && selects(assessment.grade.enzymes, ref.stepNo))
      graded = { slot, ref, maxPoints: points.enzyme, review: text_review, partialCredit: false }
    else if (ref.kind === 'cofactors' && selects(assessment.grade.cofactors, ref.stepNo))
      graded = { slot, ref, maxPoints: points.cofactors, review: text_review, partialCredit: partial_credit.cofactors }
    else if (ref.kind === 'structure' && v.structures.includes(ref.id))
      graded = { slot, ref, maxPoints: points.structure, review: structure_review, partialCredit: partial_credit.structure }

    if (!graded) continue
    if (!slot.box) throw new Error(`Slot ${slot.id} is graded but has no box in ${layout.layout}`)
    out.push(graded)
  }

  const identity = out.filter((g) => g.ref.kind === 'identity')
  for (const g of out) {
    if (g.ref.kind === 'identity') continue
    const hit = identity.find((i) => overlaps(i.slot.box!, g.slot.box!))
    if (hit) throw new Error(`Slot ${g.slot.id} overlaps ${hit.slot.id} in ${layout.layout}; its crop would include the student's ${hit.slot.id}`)
  }
  return out
}
