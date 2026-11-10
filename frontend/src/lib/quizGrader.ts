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
  saveBlob(filename, new Blob([text], { type }))
}

/** Hand the browser a file to save. */
export function saveBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
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

/** Download an assessment's print-ready PDF: one version, or every version. */
export async function downloadPrintable(api: { get: (url: string, cfg: object) => Promise<{ data: unknown }> }, id: string, slug: string, version?: string) {
  const r = await api.get(`/quiz-grader/content/${id}/print${version ? `?version=${encodeURIComponent(version)}` : ''}`, { responseType: 'blob' })
  saveBlob(`${slug}${version ? `-${version}` : ''}.pdf`, r.data as Blob)
}

// ── Scans ──────────────────────────────────────────────────────────────────────

export type PageStatus = 'PENDING' | 'PROCESSING' | 'DONE' | 'NEEDS_VERSION' | 'FAILED'

export interface QuizBatch {
  id: string
  assessmentId: string
  fileName: string
  pageCount: number
  createdAt: string
  counts: Partial<Record<PageStatus, number>>
}

export interface QuizPage {
  id: string
  batchId: string
  index: number
  status: PageStatus
  version: string | null
  versionForced: string | null
  method: string | null
  markers: number | null
  match: number | null
  fits: Record<string, number> | null
  slots: { id: string; ink: number; blank: boolean }[] | null
  error: string | null
  gradeStatus: GradeStatus
  gradeError: string | null
  pointsAuto: number | null
  maxPoints: number | null
  toReview: number | null
}

export type GradeStatus = 'NONE' | 'PENDING' | 'GRADING' | 'GRADED' | 'FAILED'

/** One answer box on one paper, scored. */
export interface SlotResult {
  slotId: string
  kind: 'enzyme' | 'cofactors' | 'structure'
  status: 'blank' | 'read' | 'illegible' | 'error'
  blankBy: 'ink' | 'model' | null
  transcription: string | null
  groupKey: string | null
  detail: {
    match: { verdict: string; alias: string; distance: number } | null
    cofactors: { text: string; side: string }[] | null
    features: { feature: string; present: boolean; confidence: number }[] | null
    description: string | null
  }
  confidence: number
  pointsAuto: number
  maxPoints: number
  needsReview: boolean
  reviewReasons: string[]
}

/** How a box was read, in a few words. */
export function describeRead(r: SlotResult): string {
  if (r.status === 'blank') return r.blankBy === 'ink' ? 'empty (not sent)' : 'read as empty'
  if (r.status !== 'read') return r.status
  if (r.kind === 'cofactors') return (r.detail.cofactors ?? []).map((c) => `${c.text} ${c.side === 'in' ? '→ in' : c.side === 'out' ? '→ out' : '(?)'}`).join(', ') || 'nothing'
  if (r.kind === 'structure') return r.detail.description ?? 'drawing'
  return `“${r.transcription ?? ''}”`
}

export const STATUS_LABEL: Record<PageStatus, string> = {
  PENDING: 'Queued',
  PROCESSING: 'Processing',
  DONE: 'Ready',
  NEEDS_VERSION: 'Needs version',
  FAILED: 'Failed',
}

/** Pages still on their way through the pipeline. */
export const inFlight = (c: QuizBatch['counts']) => (c.PENDING ?? 0) + (c.PROCESSING ?? 0)
