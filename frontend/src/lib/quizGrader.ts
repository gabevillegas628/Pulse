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
  /** text: the NetID as the vision service's own handwriting model read it (never Claude). */
  slots: { id: string; ink: number; blank: boolean; text?: string; textScore?: number | null }[] | null
  error: string | null
  gradeStatus: GradeStatus
  gradeError: string | null
  pointsAuto: number | null
  /** After review decisions; toReview counts boxes still undecided. */
  pointsFinal?: number | null
  maxPoints: number | null
  toReview: number | null
}

export type GradeStatus = 'NONE' | 'PENDING' | 'GRADING' | 'GRADED' | 'FAILED'

/** One answer box on one paper, scored. */
export interface SlotResult {
  slotId: string
  kind: 'enzyme' | 'name' | 'cofactors' | 'structure'
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
  /** The score after review: this paper's decision, else its group's, else automatic. */
  points: number
  source: 'paper' | 'group' | 'auto'
  open: boolean
  override: { points: number; note: string | null } | null
  decision: { points: number } | null
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

// ── A quiz: settings, answer key and blank form, edited together ─────────────

export type ReviewPolicy = 'always' | 'low_confidence' | 'never'
export type StepSelection = 'all' | number[]

/** A quiz's settings file as the editor holds it: the raw YAML parse. */
export interface RawAssessment {
  assessment: string
  title?: string
  key: string
  layout: string
  defaults: {
    points: { enzyme?: number; name?: number; cofactors?: number; structure?: number; [k: string]: unknown }
    partial_credit?: { cofactors?: boolean; structure?: boolean; [k: string]: unknown }
    structure_review?: ReviewPolicy
    text_review?: ReviewPolicy
    [k: string]: unknown
  }
  grade?: { enzymes?: StepSelection; cofactors?: StepSelection; names?: 'all' | string[]; [k: string]: unknown }
  versions: Record<string, { structures?: string[]; page?: number; [k: string]: unknown }>
  [k: string]: unknown
}

export interface QuizContentDetailWithPdf extends QuizContentDetail { hasPdf: boolean }

export interface QuizBundle {
  quiz: QuizContentDetailWithPdf
  key: QuizContentDetailWithPdf | null
  layout: QuizContentDetailWithPdf | null
  /** Other quizzes using the same answer key or blank form: edits reach them too. */
  sharedKey: string[]
  sharedLayout: string[]
}

export type ItemKind = 'identity' | 'enzyme' | 'cofactors' | 'name' | 'structure'

/** Something on the form a box can be drawn for, derived from the answer key. */
export interface GradableItem {
  ref: string
  kind: ItemKind
  /** Heading it is listed under: "Student", "Step 3", "Glucose 6-phosphate". */
  group: string
  label: string
  /** The slot id a new box gets. */
  slotId: string
  slotType: SlotType
  stepNo?: string
  intermediate?: string
}

export const KIND_COLOUR: Record<ItemKind, string> = {
  identity: '#6b7280',
  enzyme: '#2563eb',
  name: '#0891b2',
  cofactors: '#0d9488',
  structure: '#c026d3',
}

export const KIND_LABEL_ITEM: Record<ItemKind, string> = {
  identity: 'Student',
  enzyme: 'Enzyme',
  name: 'Name',
  cofactors: 'Cofactors',
  structure: 'Structure',
}

export const byStepNo = ([a]: [string, unknown], [b]: [string, unknown]) => Number(a) - Number(b)

/** Everything on a form that could have a box, in reading order: student, steps, intermediates. */
export function gradableItems(key: RawKey): GradableItem[] {
  const name = (id: string) => key.intermediates[id]?.name || id
  const items: GradableItem[] = [
    { ref: 'student.name', kind: 'identity', group: 'Student', label: 'Name', slotId: 'name', slotType: 'identity' },
    { ref: 'student.netid', kind: 'identity', group: 'Student', label: 'NetID', slotId: 'netid', slotType: 'identity' },
  ]
  for (const [no, step] of Object.entries(key.steps).sort(byStepNo)) {
    const group = `Step ${no}: ${step.from.map(name).join(' + ') || '?'} → ${step.to.map(name).join(' + ') || '?'}`
    items.push({ ref: `step.${no}.enzyme`, kind: 'enzyme', group, label: 'Enzyme', slotId: `s${no}_enzyme`, slotType: 'text', stepNo: no })
    if (step.cofactors) items.push({ ref: `step.${no}.cofactors`, kind: 'cofactors', group, label: 'Cofactors', slotId: `s${no}_cofactors`, slotType: 'cofactor_set', stepNo: no })
  }
  for (const [id, it] of Object.entries(key.intermediates)) {
    items.push({ ref: `intermediate.${id}.name`, kind: 'name', group: it.name || id, label: 'Written name', slotId: `${id}_name`, slotType: 'text', intermediate: id })
    items.push({ ref: `intermediate.${id}`, kind: 'structure', group: it.name || id, label: 'Structure', slotId: `int_${id}`, slotType: 'structure', intermediate: id })
  }
  return items
}

const selects = (sel: StepSelection | undefined, no: string) => sel === undefined || sel === 'all' || sel.includes(Number(no))

/**
 * Whether an item is graded, before boxes: names, enzymes and cofactors by the quiz's
 * grade settings; structures by version. The server applies the same rule
 * (slotsForVersion), and also needs the box drawn.
 */
export function isGraded(a: RawAssessment, item: GradableItem): boolean | string[] {
  const g = a.grade ?? {}
  if (item.kind === 'identity') return false
  if (item.kind === 'enzyme') return selects(g.enzymes, item.stepNo!)
  if (item.kind === 'cofactors') return selects(g.cofactors, item.stepNo!)
  if (item.kind === 'name') return g.names === undefined || g.names === 'all' || g.names.includes(item.intermediate!)
  return Object.entries(a.versions).filter(([, v]) => (v.structures ?? []).includes(item.intermediate!)).map(([k]) => k)
}

/** Turn grading of a name, enzyme or cofactor box on or off, keeping "all" when it is all. */
export function setGraded(a: RawAssessment, key: RawKey, item: GradableItem, on: boolean) {
  a.grade ??= {}
  if (item.kind === 'name') {
    const all = Object.keys(key.intermediates)
    const now = new Set(a.grade.names === undefined || a.grade.names === 'all' ? all : a.grade.names)
    if (on) now.add(item.intermediate!); else now.delete(item.intermediate!)
    a.grade.names = all.every((id) => now.has(id)) ? 'all' : all.filter((id) => now.has(id))
    return
  }
  const field = item.kind === 'enzyme' ? 'enzymes' : 'cofactors'
  const all = Object.keys(key.steps).map(Number).sort((x, y) => x - y)
  const sel = a.grade[field]
  const now = new Set(sel === undefined || sel === 'all' ? all : sel)
  if (on) now.add(Number(item.stepNo)); else now.delete(Number(item.stepNo))
  a.grade[field] = all.every((n) => now.has(n)) ? 'all' : all.filter((n) => now.has(n))
}

export const POINT_DEFAULTS = { enzyme: 1, name: 1, cofactors: 1, structure: 2 } as const
export const pointsFor = (a: RawAssessment, kind: Exclude<ItemKind, 'identity'>) => a.defaults.points[kind] ?? POINT_DEFAULTS[kind]

/** The three files of a quiz, as one draft the quiz page edits. */
export interface QuizDraft { quiz: RawAssessment; key: RawKey; layout: RawLayout }
export type EditDraft = (fn: (d: QuizDraft) => void) => void

/** An intermediate id from its name: "Fructose 1,6-bisphosphate" → "fructose_16_bisphosphate". */
export function idFromName(name: string, taken: Iterable<string>): string {
  const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'intermediate'
  const used = new Set(taken)
  let id = base
  for (let n = 2; used.has(id); n++) id = `${base}_${n}`
  return id
}

// ── Why a box is in review, in words ─────────────────────────────────────────

export type ReasonKind = 'spelling' | 'near' | 'unsure' | 'missed' | 'illegible' | 'side' | 'extra' | 'always' | 'error'

/** The tally's words, plural: "5 near-spellings". */
export const REASON_TALLY: Record<ReasonKind, string> = {
  spelling: 'near-spellings',
  near: 'almost-matches',
  unsure: 'unsure readings',
  missed: 'read as empty, but written in',
  illegible: 'unreadable',
  side: 'unclear arrow sides',
  extra: 'unlisted cofactors',
  always: 'always reviewed',
  error: 'not read',
}

/** Which kind of reason a stored review reason is (the grader's own wording, see scoring.ts). */
export function reasonKind(r: string): ReasonKind {
  if (r.startsWith('inexact')) return 'spelling'
  if (r.startsWith('close to')) return 'near'
  if (r.startsWith('confidence')) return 'unsure'
  if (r.startsWith('read as blank')) return 'missed'
  if (r === 'illegible') return 'illegible'
  if (r.startsWith('cofactor side') || r.startsWith('on both sides')) return 'side'
  if (r.startsWith('unexpected')) return 'extra'
  if (r.startsWith('policy')) return 'always'
  return 'error'
}

/** One reason as a sentence: what the grader noticed, so the person knows what to look at. */
export function explainReason(r: string, closest?: string): string {
  const after = (prefix: string) => r.slice(prefix.length).trim()
  switch (reasonKind(r)) {
    case 'spelling': return `Not spelled like any accepted answer. Closest: “${closest ?? after('inexact match to').replace(/^"|"$/g, '')}”. A typo, or a different word?`
    case 'near': return `Close to${closest ? ` “${closest}”` : ' an accepted answer'}, but not close enough to count on its own.`
    case 'unsure': return 'The model was not sure it read the handwriting right. Check the reading matches what is written.'
    case 'missed': return 'Read as empty, but there is ink in the box. It may be another answer sharing the box, or writing the model missed.'
    case 'illegible': return 'The model could not read the handwriting.'
    case 'side': return r.startsWith('on both sides')
      ? `${after('on both sides:')} was read at both ends of the arrow.`
      : 'Could not tell which end of the arrow a cofactor was written at.'
    case 'extra': return `Also wrote ${after('unexpected:')}, which the key does not list, and the answer is missing a cofactor. A misread?`
    case 'always': return 'This quiz reviews every answer of this kind (Scoring tab).'
    default: return 'The model did not return a reading for this box.'
  }
}
