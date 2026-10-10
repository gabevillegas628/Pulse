import { unit as mathUnit } from 'mathjs'

function parseValueUnit(s: string): [number, string] {
  const m = s.trim().match(/^([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)\s*(.*)$/)
  if (!m) return [NaN, '']
  return [parseFloat(m[1]), m[2].trim()]
}

/**
 * Why a numeric answer key could never be matched, or null if it can.
 *
 * `withinTolerance` treats a unit mathjs cannot parse as a wrong answer, which is the
 * right call for a student's typo but a silent disaster in the key: "%" or "ppm" there
 * marks every response in the room wrong. So the key is refused when it is saved.
 * The unit field is checked on its own too — it is the label students see, so it has
 * to convert into the key's unit or answers typed as labelled will not grade.
 */
export function numericKeyProblem(correctAnswer: string | null, unit: string | null): string | null {
  let keyUnit = ''
  if (correctAnswer) {
    const [value, unitStr] = parseValueUnit(correctAnswer)
    if (isNaN(value)) return 'The correct answer must start with a number'
    keyUnit = unitStr
  }
  const label = unit?.trim() ?? ''
  for (const u of [keyUnit, label]) {
    if (!u) continue
    try {
      mathUnit(1, u)
    } catch {
      return `"${u}" isn't a unit Pulse can convert, so every answer would be marked wrong. Leave the unit blank and say it in the question instead.`
    }
  }
  if (keyUnit && label) {
    try {
      mathUnit(1, label).toNumber(keyUnit)
    } catch {
      return `The unit "${label}" doesn't convert to "${keyUnit}" in the correct answer`
    }
  }
  return null
}

/**
 * Whether a numeric answer falls inside the professor's own margin.
 *
 * Extracted so the projector can be told which answers group together without being told
 * what they group around: /present strips `correctAnswer` while a question can still be
 * answered, so the grouping has to be derived here and shipped as a flag.
 */
export function withinTolerance(
  responseText: string,
  correctAnswer: string | null,
  tolerance: number | null,
  unit: string | null
): boolean {
  if (!correctAnswer) return false
  const [correctVal, correctUnitStr] = parseValueUnit(correctAnswer)
  if (isNaN(correctVal)) return false
  const answerKeyUnit = correctUnitStr || unit || ''
  const [studentVal, studentUnitStr] = parseValueUnit(responseText)
  if (isNaN(studentVal)) return false
  const tol = tolerance ?? 0
  if (!answerKeyUnit) return Math.abs(studentVal - correctVal) <= tol
  if (!studentUnitStr) return false
  try {
    const converted = mathUnit(studentVal, studentUnitStr).toNumber(answerKeyUnit)
    return Math.abs(converted - correctVal) <= tol
  } catch {
    return false
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface QuestionGradeInput {
  id: string
  type: string
  correctAnswer: string | null
  tolerance?: number | null
  unit?: string | null
  /** Total responses across ALL students — used for the IN_CLASS "was it presented?" check */
  totalResponseCount: number
  /**
   * Responses from students in the same section across their relevant runs.
   * When provided, this replaces totalResponseCount for the "was it presented?" check,
   * preventing cross-section contamination in multi-section sessions.
   */
  sectionResponseCount?: number
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
  tolerance?: number | null,
  unit?: string | null
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
    return withinTolerance(response.responseText, correctAnswer, tolerance ?? null, unit ?? null) ? 1.0 : 0.0
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
 * - Any type: counted if any response has an aiScore (explicit professor action —
 *   covers "Give all full credit", manual score cycling, and AI grading)
 * - FREE_TEXT: counted only via the aiScore path above
 * - STRUCTURE: counted when AI-graded or correctAnswer is set
 * - All others: counted when correctAnswer is set
 */
function isGraded(
  qType: string,
  correctAnswer: string | null,
  hasAnyAiScore: boolean
): boolean {
  if (qType === 'RATING') return true
  if (hasAnyAiScore) return true
  if (qType === 'FREE_TEXT') return false
  if (qType === 'STRUCTURE') return correctAnswer !== null
  return correctAnswer !== null
}

// ─── Was it presented? ────────────────────────────────────────────────────────

/** A run, by the section it was opened for: null when it was opened for everyone. */
export interface RunSection {
  id: string
  sectionId: string | null
}

/**
 * How many of a question's answers show it was put to a student in `sectionId`.
 *
 * The one place every grade path decides this, so the gradebook, its CSV, the student
 * report and the student's own grade pages cannot disagree with the session page again.
 * They used to: the session page counted only the student's own section's answers, while
 * the others counted every answer in the class once that section had run the session at
 * all, so a question asked only in section B was a zero for section A in the gradebook.
 *
 * An answer counts when it arrived through one of `runs` (the caller decides which —
 * closed only, or open too), that run reached this section (it was opened for it, or for
 * everyone), and the run's section has not skipped the question.
 *
 * `answers` is one entry per response, or grouped rows carrying their count in `n`.
 */
export function sectionResponseCount(
  answers: Iterable<{ runId: string | null; n?: number }>,
  runs: RunSection[],
  sectionId: string | null,
  skippedSections: Array<string | null>,
): number {
  const counting = new Set(
    runs
      .filter((r) => r.sectionId === null || r.sectionId === sectionId)
      .filter((r) => !skippedSections.includes(r.sectionId))
      .map((r) => r.id),
  )
  let count = 0
  for (const a of answers) {
    if (a.runId !== null && counting.has(a.runId)) count += a.n ?? 1
  }
  return count
}

/** Whether a response arrived in a section that has since skipped its question. */
export function isSkippedAnswer(
  runId: string | null,
  runs: RunSection[],
  skippedSections: Array<string | null>,
): boolean {
  if (runId === null || skippedSections.length === 0) return false
  const run = runs.find((r) => r.id === runId)
  return !!run && skippedSections.includes(run.sectionId)
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
    // IN_CLASS: use section-scoped count when available to avoid cross-section contamination
    const presentedCount = q.sectionResponseCount ?? q.totalResponseCount
    const wasPresented = sessionType !== 'IN_CLASS' || presentedCount > 0
    const counted = graded && wasPresented
    const score = counted
      ? scoreResponse(q.type, q.correctAnswer, q.studentResponse, q.tolerance, q.unit)
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
