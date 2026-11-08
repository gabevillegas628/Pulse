/**
 * Deterministic scoring. The model only transcribes and answers yes/no feature
 * questions; every point awarded is decided here, from the key.
 */
import type { CofactorSpec, Intermediate, ReviewPolicy } from './content.js'

// ── Normalisation ──────────────────────────────────────────────────────────────

const GREEK: Record<string, string> = {
  α: 'alpha', β: 'beta', γ: 'gamma', δ: 'delta', ε: 'epsilon', κ: 'kappa',
}
const SUB_SUPER: Record<string, string> = {
  '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9',
  '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9',
  '⁺': '+', '₊': '+',
}

/**
 * Fold the ways one answer gets written into one string: case, spacing, hyphens,
 * commas, Greek letters, sub/superscripts, and charge signs. "Glyceraldehyde-3-P
 * dehydrogenase" and "glyceraldehyde 3 p dehydrogenase" normalise the same.
 *
 * `+` is dropped, so "NAD+" and "NAD" fold together; keys that must tell them apart
 * cannot, but none do — NADH stays distinct by its H.
 */
export function normalize(s: string): string {
  let out = s.normalize('NFKC').toLowerCase()
  out = out.replace(/[αβγδεκ]/g, (c) => GREEK[c] ?? c)
  out = out.replace(/[₀-₉⁰-⁹⁺₊¹²³]/g, (c) => SUB_SUPER[c] ?? c)
  // "3-P" is how half a class writes "3-phosphate", and as an edit it is 8 letters away.
  out = out.replace(/(\d)\s*-?\s*p(?![a-z])/g, '$1phosphate')
  return out.replace(/[^a-z0-9]/g, '')
}

/** Levenshtein distance divided by the longer length: 0 is identical, 1 is nothing shared. */
export function normalizedDistance(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length || !b.length) return 1
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[b.length]! / Math.max(a.length, b.length)
}

// ── Text (enzyme names) ────────────────────────────────────────────────────────

export interface TextMatch {
  verdict: 'exact' | 'fuzzy' | 'wrong'
  normalized: string
  /** The accepted form it was closest to. */
  alias: string
  distance: number
  /** Close enough to the threshold, on either side, that a person should look. */
  nearThreshold: boolean
}

export const DEFAULT_FUZZY_THRESHOLD = 0.2
/** How far either side of the threshold still counts as "near". */
const NEAR_BAND = 0.07

/**
 * Exact alias match, then nearest alias by normalised edit distance. Short aliases
 * (abbreviations like "PK") are exact-only: one wrong letter in a two-letter
 * abbreviation is a different enzyme, not a typo.
 */
export function matchText(transcription: string, accept: string[], threshold = DEFAULT_FUZZY_THRESHOLD): TextMatch {
  const norm = normalize(transcription)
  let best = { alias: accept[0] ?? '', distance: 1 }
  for (const alias of accept) {
    const a = normalize(alias)
    if (a === norm) return { verdict: 'exact', normalized: norm, alias, distance: 0, nearThreshold: false }
    if (a.length < 5) continue
    const d = normalizedDistance(norm, a)
    if (d < best.distance) best = { alias, distance: d }
  }
  const ok = best.distance <= threshold
  return {
    verdict: ok ? 'fuzzy' : 'wrong',
    normalized: norm,
    alias: best.alias,
    distance: Number(best.distance.toFixed(3)),
    nearThreshold: Math.abs(best.distance - threshold) <= NEAR_BAND,
  }
}

// ── Cofactors ──────────────────────────────────────────────────────────────────

export type Side = 'in' | 'out' | 'unclear'
export interface CofactorItem { text: string; side: Side }

export interface CofactorOptions {
  /** Points removed per written item that is neither required nor optional. */
  extraPenalty?: number
}

export interface CofactorResult {
  fraction: number
  satisfied: number
  total: number
  groups: { side: 'in' | 'out'; accept: string[]; status: 'ok' | 'wrong_side' | 'missing' }[]
  extras: string[]
  /** Something the model could not place on a side, which a person must judge. */
  unclearSide: boolean
}

/**
 * Each required group on each side is satisfied by any accepted form written on that
 * side. Partial credit is satisfied / total. A form written on the wrong side earns
 * nothing for its group. Optional items are ignored entirely.
 */
export function scoreCofactors(items: CofactorItem[], spec: CofactorSpec, opts: CofactorOptions = {}): CofactorResult {
  const read = items.map((i) => ({ ...i, norm: normalize(i.text) })).filter((i) => i.norm)
  const used = new Set<number>()
  const groups: CofactorResult['groups'] = []

  for (const side of ['in', 'out'] as const) {
    for (const group of spec[side]) {
      const forms = new Set(group.map(normalize))
      const hit = read.findIndex((r) => r.side === side && forms.has(r.norm))
      const misplaced = read.findIndex((r) => r.side !== side && forms.has(r.norm))
      if (hit >= 0) used.add(hit)
      if (misplaced >= 0) used.add(misplaced)
      groups.push({ side, accept: group, status: hit >= 0 ? 'ok' : misplaced >= 0 ? 'wrong_side' : 'missing' })
    }
  }

  const optional = new Set(spec.optional.map(normalize))
  const extras = read.filter((r, i) => !used.has(i) && !optional.has(r.norm)).map((r) => r.text)
  const satisfied = groups.filter((g) => g.status === 'ok').length
  const total = groups.length
  const base = total ? satisfied / total : 1
  const fraction = Math.max(0, base - (opts.extraPenalty ?? 0) * extras.length)

  return {
    fraction,
    satisfied,
    total,
    groups,
    extras,
    unclearSide: read.some((r) => r.side === 'unclear'),
  }
}

// ── Structures ─────────────────────────────────────────────────────────────────

/** Weighted share of the key's features the drawing was judged to have. */
export function scoreStructure(intermediate: Intermediate, answers: boolean[]): number {
  const n = intermediate.features.length
  if (!n) return 0
  const w = intermediate.feature_weights ?? intermediate.features.map(() => 1)
  const total = w.reduce((a, b) => a + b, 0)
  const got = w.reduce((a, wi, i) => a + (answers[i] ? wi : 0), 0)
  return total ? got / total : 0
}

// ── Review policy ──────────────────────────────────────────────────────────────

export const DEFAULT_CONFIDENCE_THRESHOLD = 0.8

/** Why a slot goes to the review queue; empty means its auto score stands. */
export function reviewReasons(
  policy: ReviewPolicy,
  signals: { confidence: number; nearThreshold?: boolean; unclearSide?: boolean; illegible?: boolean },
  confidenceThreshold = DEFAULT_CONFIDENCE_THRESHOLD,
): string[] {
  if (policy === 'never') return []
  if (policy === 'always') return ['policy: always']
  const reasons: string[] = []
  if (signals.illegible) reasons.push('illegible')
  if (signals.confidence < confidenceThreshold) reasons.push(`confidence ${signals.confidence.toFixed(2)}`)
  if (signals.nearThreshold) reasons.push('fuzzy match near threshold')
  if (signals.unclearSide) reasons.push('cofactor side unclear')
  return reasons
}

/** Round to the nearest hundredth so 1/3 credit compares cleanly against a hand grade. */
export const roundPoints = (p: number) => Math.round(p * 100) / 100
