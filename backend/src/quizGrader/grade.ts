/**
 * Turn one page's model reads into scored slot results. Pure: no I/O, no model.
 * The result shape follows docs/quiz-grader/SCHEMA.md §4, minus the storage fields.
 */
import type { GradedSlot } from './content.js'
import type { StructureRead, TextRead } from './reader.js'
import {
  type CofactorOptions,
  type CofactorResult,
  type TextMatch,
  matchText,
  normalize,
  stripCoefficient,
  reviewReasons,
  roundPoints,
  scoreCofactors,
  scoreStructure,
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_FUZZY_THRESHOLD,
} from './scoring.js'

export interface SlotResult {
  slotId: string
  kind: GradedSlot['ref']['kind']
  /** not_sent: a name or NetID slot, which stays on this machine and is matched by a person. */
  status: 'blank' | 'read' | 'illegible' | 'error' | 'not_sent'
  /** For blanks: found empty by the ink check (never read) or by the model. */
  blankBy?: 'ink' | 'model'
  transcription?: string
  match?: TextMatch
  cofactors?: TextRead['cofactors']
  cofactorResult?: CofactorResult
  description?: string
  features?: { feature: string; present: boolean; confidence: number }[]
  /** A stronger model's blind second reading, when the first was unsure or a near miss. */
  secondLook?: { transcription: string; status: TextRead['status']; confidence: number; agrees: boolean }
  confidence: number
  pointsAuto: number
  maxPoints: number
  needsReview: boolean
  reviewReasons: string[]
}

/**
 * How far a reading can be from an accepted answer and still earn a second look: about a
 * third of the letters, past the fuzzy band (0.2). "Endase" for "enolase" (0.29) gets one;
 * "aldolase" (0.38) and "hexokinase" (0.5) do not, and score 0 without a look. A real
 * mistake that does get one costs a cent and no flag: both readers agree on it.
 */
export const SECOND_LOOK_DISTANCE = 0.34

const acceptFor = (g: GradedSlot): string[] =>
  g.ref.kind === 'enzyme' ? g.ref.step.enzyme.accept : g.ref.kind === 'name' ? acceptedNames(g.ref.intermediate) : []

/**
 * Whether an enzyme or name reading deserves a second, blind look by a stronger model:
 * illegible, unsure, or a near miss of an accepted answer. A near miss counts whatever
 * the model's confidence, because a reader is often sure of its own misreads.
 */
export function wantsSecondLook(g: GradedSlot, read: TextRead | undefined, opts: GradeOptions = {}): boolean {
  if (!read) return false
  const unsure = read.confidence < (opts.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD)
  if (g.ref.kind === 'cofactors') {
    // Unsure, illegible, a side it could not place, or read as empty though the ink check
    // found writing (often only the enzyme name sharing the box).
    return read.status !== 'read' || unsure || read.cofactors.some((c) => c.side === 'unclear')
  }
  if (g.ref.kind !== 'enzyme' && g.ref.kind !== 'name') return false
  if (read.status === 'illegible') return true
  // An enzyme read as empty though the box has ink: flagged otherwise, so worth a look.
  if (read.status === 'blank') return g.ref.kind === 'enzyme'
  if (read.status !== 'read') return false
  if (unsure) return true
  const m = matchText(read.transcription, acceptFor(g), opts.fuzzyThreshold ?? DEFAULT_FUZZY_THRESHOLD)
  return m.verdict !== 'exact' && m.distance <= SECOND_LOOK_DISTANCE
}

/** The second look's reading, as a review reason (the review page explains it). */
const cofactorList = (items: TextRead['cofactors']) =>
  items.map((c) => `${c.text} ${c.side === 'in' ? '→ in' : c.side === 'out' ? '→ out' : '(side?)'}`).join(', ') || 'nothing'
const secondLookReason = (second: TextRead, kind: GradedSlot['ref']['kind']) =>
  second.status !== 'read' ? `second look: ${second.status}`
    : `second look: "${kind === 'cofactors' ? cofactorList(second.cofactors) : second.transcription}"`
/** A cofactor reading as a comparable set: side and normalised name of each item. */
const cofactorSet = (items: TextRead['cofactors']) =>
  items.map((c) => `${c.side}:${normalize(stripCoefficient(c.text))}`).filter((x) => !x.endsWith(':')).sort().join('|')

/**
 * The checks of a drawing worth a second look: the doubtful ones that could change its
 * score. None for a drawing not read, or (all or nothing) one surely missing a check.
 */
export function doubtfulChecks(g: GradedSlot, read: StructureRead | undefined, opts: GradeOptions = {}): number[] {
  if (!read || read.status !== 'read' || g.ref.kind !== 'structure') return []
  const t = opts.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD
  const answers = g.ref.intermediate.features.map((_, i) => read.features.find((f) => f.index === i))
  const sure = (a: { confidence: number } | undefined) => (a?.confidence ?? 0) >= t
  if (!g.partialCredit && answers.some((a) => sure(a) && !a!.present)) return []
  return answers.map((a, i) => (sure(a) ? -1 : i)).filter((i) => i >= 0)
}

/**
 * All or nothing, only the checks that could change the score matter. A check the model is
 * sure is missing scores the drawing 0 whatever the doubtful ones say: nothing to decide.
 * Otherwise the doubtful checks decide it, so the least sure of them is what counts.
 * (With partial credit every check moves the score, so every one counts.)
 */
export function decidingConfidence(answers: ({ present: boolean; confidence: number } | undefined)[], threshold: number): number {
  const sure = (a: { confidence: number } | undefined) => (a?.confidence ?? 0) >= threshold
  if (answers.some((a) => sure(a) && !a!.present)) return 1
  const doubtful = answers.filter((a) => !sure(a))
  return doubtful.length ? Math.min(...doubtful.map((a) => a?.confidence ?? 0)) : 1
}

/** An intermediate's accepted names: its display name, then the key's aliases. */
export function acceptedNames(it: { name: string; accept?: string[] }): string[] {
  return [it.name, ...(it.accept ?? []).filter((a) => a.toLowerCase() !== it.name.toLowerCase())]
}

export interface GradeOptions extends CofactorOptions {
  fuzzyThreshold?: number
  confidenceThreshold?: number
}

/**
 * @param blank slot ids the ink check found empty; they score 0 without a read.
 */
export function gradePage(
  slots: GradedSlot[],
  blank: Set<string>,
  textReads: Map<string, TextRead>,
  structureReads: Map<string, StructureRead>,
  opts: GradeOptions = {},
  /** Second, blind readings of near misses and unsure answers, by slot id. */
  secondReads: Map<string, TextRead> = new Map(),
  /** Second, blind answers to a drawing's doubtful checks, by slot id. */
  secondStructures: Map<string, StructureRead> = new Map(),
): SlotResult[] {
  const fuzzy = opts.fuzzyThreshold ?? DEFAULT_FUZZY_THRESHOLD
  const confT = opts.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD

  return slots.map((g): SlotResult => {
    const base = { slotId: g.slot.id, kind: g.ref.kind, maxPoints: g.maxPoints }
    const finish = (r: Omit<SlotResult, 'needsReview' | 'reviewReasons' | 'slotId' | 'kind' | 'maxPoints'>, reasons: string[]): SlotResult => ({
      ...base,
      ...r,
      pointsAuto: roundPoints(r.pointsAuto),
      needsReview: reasons.length > 0,
      reviewReasons: reasons,
    })

    if (g.ref.kind === 'identity') return finish({ status: 'not_sent', confidence: 1, pointsAuto: 0 }, [])
    if (blank.has(g.slot.id)) return finish({ status: 'blank', blankBy: 'ink', confidence: 1, pointsAuto: 0 }, [])

    if (g.ref.kind === 'structure') {
      const read = structureReads.get(g.slot.id)
      if (!read) return finish({ status: 'error', confidence: 0, pointsAuto: 0 }, ['no model result'])
      const feats = g.ref.intermediate.features
      const answers = feats.map((_, i) => read.features.find((f) => f.index === i))
      const pointsAuto = read.status === 'read'
        ? g.maxPoints * scoreStructure(g.ref.intermediate, answers.map((a) => !!a?.present), g.partialCredit)
        : 0
      const minFeatureConf = Math.min(read.confidence, ...answers.map((a) => a?.confidence ?? 0))
      // A second look at the doubtful checks: the same answers settle the drawing; any
      // different answer goes to review, naming the checks the two disagree on.
      const second = secondStructures.get(g.slot.id)
      const doubtful = doubtfulChecks(g, read, opts)
      const disagree = second ? doubtful.filter((i) => {
        const s2 = second.features.find((f) => f.index === i)
        return !s2 || s2.present !== !!answers[i]?.present
      }) : []
      const settled = !!second && second.status === 'read' && doubtful.length > 0 && disagree.length === 0
      const reasons = reviewReasons(g.review, {
        confidence: settled ? 1 : read.status === 'read' && !g.partialCredit ? decidingConfidence(answers, confT) : minFeatureConf,
        illegible: read.status === 'illegible',
      }, confT)
      if (second && !settled && disagree.length && g.review !== 'never') {
        reasons.push(`second look disagrees on: ${disagree.map((i) => feats[i]).join('; ')}`)
      }
      return finish(
        {
          status: read.status,
          description: read.description,
          features: feats.map((feature, i) => ({ feature, present: !!answers[i]?.present, confidence: answers[i]?.confidence ?? 0 })),
          confidence: minFeatureConf,
          pointsAuto,
          ...(second ? { secondLook: { transcription: disagree.map((i) => feats[i]).join('; '), status: second.status, confidence: second.confidence, agrees: disagree.length === 0 } } : {}),
        },
        reasons,
      )
    }

    const read = textReads.get(g.slot.id)
    if (!read) return finish({ status: 'error', confidence: 0, pointsAuto: 0 }, ['no model result'])
    if (read.status !== 'read') {
      // Reaching here means the ink check found writing in this box. If the model calls
      // it blank anyway, one of the two is wrong, and a person should look. On boxes two
      // slots share, the ink may be the other slot's (an enzyme name beside empty
      // cofactor ends): still worth a glance, since a miss silently scores 0.
      // Not for intermediate names: they sit beside the drawings, so a name box nearly
      // always has ink, and an unnamed intermediate would be flagged on every paper.
      const second = secondReads.get(g.slot.id)
      // A second look that also finds nothing settles "read as empty, but written in": the
      // ink is someone else's (the enzyme name sharing a cofactor box, usually).
      const bothBlank = read.status === 'blank' && second?.status === 'blank'
      const reasons = read.status === 'illegible'
        ? reviewReasons(g.review, { confidence: 0, illegible: true }, confT)
        : g.ref.kind === 'name' || bothBlank ? [] : reviewReasons(g.review, { confidence: 1, missedInk: true }, confT)
      if (second?.status === 'read' && g.review !== 'never') reasons.push(secondLookReason(second, g.ref.kind))
      return finish({
        status: read.status,
        ...(read.status === 'blank' ? { blankBy: 'model' as const } : {}),
        transcription: read.transcription,
        confidence: read.confidence,
        pointsAuto: 0,
      }, reasons)
    }

    if (g.ref.kind === 'enzyme' || g.ref.kind === 'name') {
      const match = matchText(read.transcription, acceptFor(g), fuzzy)
      // A second look either confirms the first reading (the same words, so the answer
      // stands: a real misspelling or a wrong answer, no flag for being close), or
      // disagrees (then a person decides, seeing both readings).
      const second = secondReads.get(g.slot.id)
      const agree = second?.status === 'read' && normalize(second.transcription) === normalize(read.transcription)
      // Two readings that score the same leave nothing to decide (two accepted spellings,
      // or two wrong answers): the score is right whichever reading is.
      const points = (m: ReturnType<typeof matchText>) => (m.verdict === 'wrong' ? 0 : g.maxPoints)
      const sameScore = second?.status === 'read' && points(matchText(second.transcription, acceptFor(g), fuzzy)) === points(match)
      const settled = agree || sameScore
      // Two readers agreeing (or scoring the same) settles it, whatever either rated itself.
      const reasons = reviewReasons(g.review, {
        confidence: settled ? 1 : read.confidence,
        nearThreshold: settled ? false : match.nearThreshold,
        inexact: match.verdict === 'fuzzy' ? match.alias : undefined,
      }, confT)
      if (second && !settled && g.review !== 'never') reasons.push(secondLookReason(second, g.ref.kind))
      return finish(
        {
          status: 'read',
          transcription: read.transcription,
          match,
          confidence: read.confidence,
          pointsAuto: match.verdict === 'wrong' ? 0 : g.maxPoints,
          ...(second ? { secondLook: { transcription: second.transcription, status: second.status, confidence: second.confidence, agrees: agree } } : {}),
        },
        reasons,
      )
    }

    // cofactors
    const cofactorResult = scoreCofactors(read.cofactors, g.ref.spec, { ...opts, partialCredit: g.partialCredit })
    // A second look that reads the same items on the same sides confirms the reading; one
    // that differs but scores the same leaves nothing to decide either.
    const second = secondReads.get(g.slot.id)
    const agree = second?.status === 'read' && cofactorSet(second.cofactors) === cofactorSet(read.cofactors)
    const sameScore = second?.status === 'read'
      && scoreCofactors(second.cofactors, g.ref.spec, { ...opts, partialCredit: g.partialCredit }).fraction === cofactorResult.fraction
    const settled = agree || sameScore
    const reasons = reviewReasons(g.review, {
      confidence: settled ? 1 : read.confidence,
      // Both readers unsure of a side: still worth a look. Settled by the score: not.
      unclearSide: agree ? cofactorResult.unclearSide : settled ? false : cofactorResult.unclearSide,
      // An extra costs nothing on a full-marks answer (unless extras are penalised). On a
      // short one it may be the missing cofactor misread, worth a look, unless a second
      // look already settled the score.
      extras: !settled && (cofactorResult.fraction < 1 || opts.extraPenalty) ? cofactorResult.extras : [],
      bothSides: cofactorResult.bothSides,
    }, confT)
    if (second && !settled && g.review !== 'never') reasons.push(secondLookReason(second, g.ref.kind))
    return finish(
      {
        status: 'read',
        cofactors: read.cofactors,
        cofactorResult,
        confidence: read.confidence,
        pointsAuto: g.maxPoints * cofactorResult.fraction,
        ...(second ? { secondLook: { transcription: second.status === 'read' ? cofactorList(second.cofactors) : '', status: second.status, confidence: second.confidence, agrees: agree } } : {}),
      },
      reasons,
    )
  })
}
