/** Shapes of /api/quiz-grader responses. See backend/src/routes/quizGrader.routes.ts. */

export type QuizContentKind = 'KEY' | 'LAYOUT' | 'ASSESSMENT'

export const KIND_LABEL: Record<QuizContentKind, string> = {
  KEY: 'Answer key',
  LAYOUT: 'Layout',
  ASSESSMENT: 'Assessment',
}

export interface QuizContentSummary {
  id: string
  kind: QuizContentKind
  slug: string
  title: string
  updatedAt: string
  /** Schema problems: the file is not usable until these are fixed. */
  issues: string[]
  /** Cross-file gaps, like a layout with no boxes yet. Normal while setting up. */
  warnings: string[]
}

export interface QuizContentDetail extends QuizContentSummary {
  source: string
  /** The parsed YAML, exactly as written: no defaults filled in. */
  data: Record<string, unknown> | null
}

/** A pathway key as the editor holds it: the raw YAML parse, optional fields absent. */
export interface RawKey {
  pathway: string
  title: string
  intermediates: Record<string, RawIntermediate>
  steps: Record<string, RawStep>
  [k: string]: unknown
}
export interface RawIntermediate {
  name: string
  accept?: string[]
  features?: string[]
  feature_weights?: number[]
  [k: string]: unknown
}
export interface RawStep {
  from: string[]
  to: string[]
  enzyme: { accept: string[] }
  cofactors?: { in?: string[][]; out?: string[][]; optional?: string[] }
  [k: string]: unknown
}

/** Hand the browser a text file to save. */
export function saveText(filename: string, text: string, type = 'application/yaml') {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/** A layout as the editor holds it: the raw YAML parse. */
export type SlotType = 'text' | 'cofactor_set' | 'structure' | 'identity'
export type InEnd = 'top' | 'bottom' | 'left' | 'right'
export type Box = [number, number, number, number]
export interface RawSlot {
  id: string
  type: SlotType
  ref: string
  in_end?: InEnd | null
  box: Box | null
  [k: string]: unknown
}
export interface RawLayout {
  layout: string
  page: { size: string; source_pdf: string; [k: string]: unknown }
  slots: RawSlot[]
  [k: string]: unknown
}
