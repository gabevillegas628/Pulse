/**
 * Canonical score calculator — single source of truth used by classes,
 * sessions, and responses routes.
 *
 * Returns a value in [0, 1]:
 *   1.0 = full credit
 *   0.5 = partial credit
 *   0.0 = no credit
 */
export function calcScore(
  qType: string,
  correctAnswer: string | null,
  response: { responseText: string; aiScore: number | null } | null,
  tolerance?: number | null
): number {
  if (!response) return 0

  if (qType === 'MULTIPLE_CHOICE' || qType === 'YES_NO') {
    if (!correctAnswer) return 1.0
    return response.responseText === correctAnswer ? 1.0 : 0.5
  }

  if (qType === 'FREE_TEXT') {
    return response.aiScore !== null && response.aiScore !== undefined
      ? response.aiScore
      : 1.0
  }

  if (qType === 'NUMERIC') {
    if (!correctAnswer) return 1.0
    const correct = parseFloat(correctAnswer)
    const student = parseFloat(response.responseText)
    if (isNaN(student)) return 0
    const tol = tolerance ?? 0
    return Math.abs(student - correct) <= tol ? 1.0 : 0.0
  }

  if (qType === 'MULTI_SELECT') {
    if (!correctAnswer) return 1.0
    let studentArr: string[] = []
    try { studentArr = JSON.parse(response.responseText) } catch { return 0 }
    if (!Array.isArray(studentArr) || studentArr.length === 0) return 0
    const correctArr: string[] = JSON.parse(correctAnswer)
    const sSet = new Set(studentArr)
    const cSet = new Set(correctArr)
    return sSet.size === cSet.size && [...cSet].every(v => sSet.has(v)) ? 1.0 : 0.5
  }

  if (qType === 'ORDERING') {
    if (!correctAnswer) return 1.0
    let studentArr: string[] = []
    try { studentArr = JSON.parse(response.responseText) } catch { return 0 }
    if (!Array.isArray(studentArr) || studentArr.length === 0) return 0
    const correctArr: string[] = JSON.parse(correctAnswer)
    return correctArr.length === studentArr.length &&
      correctArr.every((v, i) => v === studentArr[i])
      ? 1.0 : 0.5
  }

  if (qType === 'STRUCTURE') {
    if (response.aiScore !== null && response.aiScore !== undefined) return response.aiScore
    if (!correctAnswer) return 1.0
    if (!response.responseText) return 0
    return response.responseText === correctAnswer ? 1.0 : 0.5
  }

  return 1.0 // RATING — participation credit regardless of value
}
