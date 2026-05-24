import type { ResponseWithStudent } from 'shared'

type ScoredQuestion = {
  type: string
  correctAnswer: string | null
  tolerance?: number | null
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
  if (q.type === 'MULTIPLE_CHOICE' || q.type === 'YES_NO') {
    if (!q.correctAnswer) return null
    return r.responseText === q.correctAnswer ? 1.0 : 0.5
  }
  if (q.type === 'FREE_TEXT') return r.aiScore
  if (q.type === 'NUMERIC') {
    if (!q.correctAnswer) return null
    const correct = parseFloat(q.correctAnswer)
    const student = parseFloat(r.responseText)
    if (isNaN(student)) return 0
    const tol = q.tolerance ?? 0
    return Math.abs(student - correct) <= tol ? 1.0 : 0.0
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
