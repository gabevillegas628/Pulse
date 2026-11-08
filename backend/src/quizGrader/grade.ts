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
  transcription?: string
  match?: TextMatch
  cofactors?: TextRead['cofactors']
  cofactorResult?: CofactorResult
  description?: string
  features?: { feature: string; present: boolean; confidence: number }[]
  confidence: number
  pointsAuto: number
  maxPoints: number
  needsReview: boolean
  reviewReasons: string[]
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
    if (blank.has(g.slot.id)) return finish({ status: 'blank', confidence: 1, pointsAuto: 0 }, [])

    if (g.ref.kind === 'structure') {
      const read = structureReads.get(g.slot.id)
      if (!read) return finish({ status: 'error', confidence: 0, pointsAuto: 0 }, ['no model result'])
      const feats = g.ref.intermediate.features
      const answers = feats.map((_, i) => read.features.find((f) => f.index === i))
      const pointsAuto = read.status === 'read' ? g.maxPoints * scoreStructure(g.ref.intermediate, answers.map((a) => !!a?.present)) : 0
      const minFeatureConf = Math.min(read.confidence, ...answers.map((a) => a?.confidence ?? 0))
      return finish(
        {
          status: read.status,
          description: read.description,
          features: feats.map((feature, i) => ({ feature, present: !!answers[i]?.present, confidence: answers[i]?.confidence ?? 0 })),
          confidence: minFeatureConf,
          pointsAuto,
        },
        reviewReasons(g.review, { confidence: minFeatureConf, illegible: read.status === 'illegible' }, confT),
      )
    }

    const read = textReads.get(g.slot.id)
    if (!read) return finish({ status: 'error', confidence: 0, pointsAuto: 0 }, ['no model result'])
    if (read.status !== 'read') {
      const reasons = read.status === 'illegible' ? reviewReasons(g.review, { confidence: 0, illegible: true }, confT) : []
      return finish({ status: read.status, transcription: read.transcription, confidence: read.confidence, pointsAuto: 0 }, reasons)
    }

    if (g.ref.kind === 'enzyme') {
      const match = matchText(read.transcription, g.ref.step.enzyme.accept, fuzzy)
      return finish(
        {
          status: 'read',
          transcription: read.transcription,
          match,
          confidence: read.confidence,
          pointsAuto: match.verdict === 'wrong' ? 0 : g.maxPoints,
        },
        reviewReasons(g.review, { confidence: read.confidence, nearThreshold: match.nearThreshold }, confT),
      )
    }

    // cofactors
    const cofactorResult = scoreCofactors(read.cofactors, g.ref.spec, opts)
    return finish(
      {
        status: 'read',
        cofactors: read.cofactors,
        cofactorResult,
        confidence: read.confidence,
        pointsAuto: g.maxPoints * cofactorResult.fraction,
      },
      reviewReasons(g.review, { confidence: read.confidence, unclearSide: cofactorResult.unclearSide }, confT),
    )
  })
}
