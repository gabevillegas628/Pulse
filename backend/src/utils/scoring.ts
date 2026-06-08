// ─── Types ────────────────────────────────────────────────────────────────────

export interface QuestionGradeInput {
  id: string
  type: string
  correctAnswer: string | null
  tolerance?: number | null
  /** Total responses across ALL students — used for the IN_CLASS "was it presented?" check */
  totalResponseCount: number
  /** True if ANY student's response has a non-null aiScore — signals the professor ran grading */
  hasAnyAiScore: boolean
  /** This particular student's response, or null if they didn't answer */
  studentResponse: { responseText: string; aiScore: number | null } | null
}

export interface QuestionGradeResult {
  id: string
  /** The student's score on this question (0–1). Zero for uncounted questions. */
  score: number
  /** The professor has set this question up for grading */
  graded: boolean
  /** Counts toward earned and max: graded AND (HW always | IN_CLASS only if presented) */
  counted: boolean
}

export interface SessionGradeResult {
  earned: number
  max: number
  questions: QuestionGradeResult[]
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Score for a single response. aiScore is always the authoritative override —
 * it wins over all computed scores for every question type.
 */
function scoreResponse(
  qType: string,
  correctAnswer: string | null,
  response: { responseText: string; aiScore: number | null } | null,
  tolerance?: number | null
): number {
  if (!response) return 0

  // aiScore is a universal override — professor manual grades / AI grades always win
  if (response.aiScore !== null && response.aiScore !== undefined) return response.aiScore

  if (qType === 'MULTIPLE_CHOICE' || qType === 'YES_NO') {
    if (!correctAnswer) return 1.0
    return response.responseText === correctAnswer ? 1.0 : 0.5
  }

  if (qType === 'FREE_TEXT') return 1.0

  if (qType === 'NUMERIC') {
    if (!correctAnswer) return 1.0
    const correct = parseFloat(correctAnswer)
    const student = parseFloat(response.responseText)
    if (isNaN(student)) return 0
    return Math.abs(student - correct) <= (tolerance ?? 0) ? 1.0 : 0.0
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
      correctArr.every((v, i) => v === studentArr[i]) ? 1.0 : 0.5
  }

  if (qType === 'STRUCTURE') {
    if (!correctAnswer) return 1.0
    if (!response.responseText) return 0
    return response.responseText === correctAnswer ? 1.0 : 0.5
  }

  return 1.0 // RATING — participation credit regardless of value
}

/**
 * Returns true if the professor has set this question up for grading.
 * Ungraded questions are excluded from both earned and max.
 *
 * - RATING: always counted (participation by design)
 * - FREE_TEXT: counted after AI grading has run (any response has aiScore)
 * - STRUCTURE: counted when AI-graded or correctAnswer is set
 * - All others: counted when correctAnswer is set
 */
function isGraded(
  qType: string,
  correctAnswer: string | null,
  hasAnyAiScore: boolean
): boolean {
  if (qType === 'RATING') return true
  if (qType === 'FREE_TEXT') return hasAnyAiScore
  if (qType === 'STRUCTURE') return hasAnyAiScore || correctAnswer !== null
  return correctAnswer !== null
}

// ─── Canonical grade function ─────────────────────────────────────────────────

/**
 * THE single source of truth for computing a student's grade on a session.
 *
 * Every backend route that needs grades calls this function. No scoring logic
 * lives outside this file.
 *
 * @param sessionType  'IN_CLASS' | 'HOMEWORK' — determines whether questions
 *                     with zero total responses are excluded from the max
 * @param questions    Per-question data including the student's response
 * @returns            earned, max, and a per-question breakdown
 */
export function gradeSession(
  sessionType: string,
  questions: QuestionGradeInput[]
): SessionGradeResult {
  const results: QuestionGradeResult[] = questions.map((q) => {
    const graded = isGraded(q.type, q.correctAnswer, q.hasAnyAiScore)
    // IN_CLASS: a question with zero total responses was never shown to students
    const wasPresented = sessionType !== 'IN_CLASS' || q.totalResponseCount > 0
    const counted = graded && wasPresented
    const score = counted
      ? scoreResponse(q.type, q.correctAnswer, q.studentResponse, q.tolerance)
      : 0
    return { id: q.id, score, graded, counted }
  })

  const counted = results.filter((r) => r.counted)
  const earned = counted.reduce((s, r) => s + r.score, 0)

  return {
    earned: Math.round(earned * 10) / 10,
    max: counted.length,
    questions: results,
  }
}
