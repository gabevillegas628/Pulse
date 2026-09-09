import { unit as mathUnit } from 'mathjs'
import type { ResponseWithStudent } from 'shared'

const NUM_RE = /^([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)\s*(.*)$/

export function parseValueUnit(s: string): [number, string] {
  const m = s.trim().match(NUM_RE)
  if (!m) return [NaN, '']
  return [parseFloat(m[1]), m[2].trim()]
}

/**
 * Significant figures in a number as the student wrote it. Leading zeros never count;
 * trailing zeros count only when a decimal point is present. So "0.0042" is two and
 * "2100" is two, but "4.20" is three.
 */
function sigFigs(literal: string): number {
  const mantissa = literal.replace(/^[+-]/, '').split(/[eE]/)[0]
  const hasPoint = mantissa.includes('.')
  let digits = mantissa.replace('.', '').replace(/^0+/, '')
  if (!hasPoint) digits = digits.replace(/0+$/, '')
  return digits.length || 1
}

export type NormalizedNumeric =
  | { kind: 'value'; value: number; sigFigs: number }
  | { kind: 'nounit' }
  | { kind: 'unreadable' }

/**
 * A numeric answer converted into `keyUnit`, with the precision it was written to.
 *
 * An empty `keyUnit` means the question is unitless and the value stands as written.
 * Anything unreadable as a number, or carrying a unit that will not convert, comes back
 * as its own kind rather than being dropped — a caller bucketing responses has to be
 * able to account for every one of them, or its bars stop summing to the total.
 */
export function normalizeNumeric(text: string, keyUnit: string): NormalizedNumeric {
  const m = text.trim().match(NUM_RE)
  if (!m) return { kind: 'unreadable' }
  const value = parseFloat(m[1])
  if (isNaN(value)) return { kind: 'unreadable' }
  const written = sigFigs(m[1])
  const unitStr = m[2].trim()
  if (!keyUnit) return { kind: 'value', value, sigFigs: written }
  if (!unitStr) return { kind: 'nounit' }
  try {
    return { kind: 'value', value: mathUnit(value, unitStr).toNumber(keyUnit), sigFigs: written }
  } catch {
    return { kind: 'unreadable' }
  }
}

type ScoredQuestion = {
  type: string
  correctAnswer: string | null
  tolerance?: number | null
  unit?: string | null
}

type ScoredResponse = {
  responseText: string
  aiScore: number | null
}

/** Compute a 0–1 score for a single student response, or null if unscored. */
export function calcResponseScore(
  q: ScoredQuestion,
  r: ScoredResponse | ResponseWithStudent
): number | null {
  if (r.aiScore !== null && r.aiScore !== undefined) return r.aiScore
  if (q.type === 'MULTIPLE_CHOICE' || q.type === 'YES_NO') {
    if (!q.correctAnswer) return null
    return r.responseText === q.correctAnswer ? 1.0 : 0.5
  }
  if (q.type === 'FREE_TEXT') return r.aiScore
  if (q.type === 'NUMERIC') {
    if (!q.correctAnswer) return null
    const [correctVal, correctUnitStr] = parseValueUnit(q.correctAnswer)
    const answerKeyUnit = correctUnitStr || q.unit || ''
    const [studentVal, studentUnitStr] = parseValueUnit(r.responseText)
    if (isNaN(studentVal)) return 0
    const tol = q.tolerance ?? 0
    if (!answerKeyUnit) {
      return Math.abs(studentVal - correctVal) <= tol ? 1.0 : 0.0
    }
    if (!studentUnitStr) return 0
    try {
      const converted = mathUnit(studentVal, studentUnitStr).toNumber(answerKeyUnit)
      return Math.abs(converted - correctVal) <= tol ? 1.0 : 0.0
    } catch {
      return 0
    }
  }
  if (q.type === 'MULTI_SELECT') {
    if (!q.correctAnswer) return null
    try {
      const studentArr: string[] = JSON.parse(r.responseText)
      const correctArr: string[] = JSON.parse(q.correctAnswer)
      const sSet = new Set(studentArr)
      const cSet = new Set(correctArr)
      return sSet.size === cSet.size && [...cSet].every(v => sSet.has(v)) ? 1.0 : 0.5
    } catch { return 0 }
  }
  if (q.type === 'ORDERING') {
    if (!q.correctAnswer) return null
    try {
      const studentArr: string[] = JSON.parse(r.responseText)
      const correctArr: string[] = JSON.parse(q.correctAnswer)
      return correctArr.length === studentArr.length &&
        correctArr.every((v, i) => v === studentArr[i]) ? 1.0 : 0.5
    } catch { return 0 }
  }
  if (q.type === 'STRUCTURE') {
    if (r.aiScore !== null) return r.aiScore
    if (!q.correctAnswer) return 1.0
    if (!r.responseText) return 0
    return r.responseText === q.correctAnswer ? 1.0 : 0.5
  }
  return null
}

/** Cycle a score through null/1 → 0 → 0.5 → 1. */
export function cycleScore(current: number | null): number {
  if (current === null || current === 1.0) return 0
  if (current === 0) return 0.5
  return 1.0
}
