/**
 * Compare automatic scores with a professor's hand grades: the Phase 0 check, run on
 * pages graded in Pulse. Pure; the route feeds it rows from the database.
 *
 * The hand-grades CSV has a `page` column and one column per slot id, points in each cell
 * ("-" or empty: not graded). `page` is the page number in the upload ("3"), or anything
 * ending in it, like the spike's "testScans-p3".
 */
export interface ResultRow {
  pageIndex: number
  slotId: string
  kind: string
  status: string
  transcription: string | null
  pointsAuto: number
  needsReview: boolean
  reviewReasons: string[]
}

export interface Comparison {
  byKind: { kind: string; compared: number; agree: number; flagged: number; unflaggedAgree: number; unflagged: number; afterReview: number }[]
  disagreements: { page: number; slotId: string; read: string; auto: number; hand: number; flagged: string | null }[]
  unmatchedPages: string[]
}

export function parseCsv(src: string): Record<string, string>[] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++ }
      else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(cell); cell = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++
      row.push(cell); rows.push(row); row = []; cell = ''
    } else cell += c
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  const [head, ...body] = rows.filter((r) => r.some((c) => c.trim()))
  if (!head) return []
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim().replace(/^﻿/, ''), (r[i] ?? '').trim()])))
}

/** "testScans-p3", "p3", "3" → 3. */
export function pageNumber(label: string): number | null {
  const m = /(\d+)\s*$/.exec(label)
  return m ? Number(m[1]) : null
}

export function compare(results: ResultRow[], csv: string): Comparison {
  const hand = new Map<number, Record<string, string>>()
  const unmatchedPages: string[] = []
  for (const r of parseCsv(csv)) {
    const n = pageNumber(r.page ?? '')
    if (n == null) unmatchedPages.push(r.page ?? '(no page)')
    else hand.set(n, r)
  }
  const graded = new Set(results.map((r) => r.pageIndex + 1))
  for (const n of hand.keys()) if (!graded.has(n)) unmatchedPages.push(String(n))

  const compared = results.flatMap((r) => {
    const raw = hand.get(r.pageIndex + 1)?.[r.slotId]
    const h = raw === undefined || raw === '' || raw === '-' ? NaN : Number(raw)
    return Number.isNaN(h) ? [] : [{ r, hand: h, agrees: Math.abs(r.pointsAuto - h) < 0.01 }]
  })

  const byKind = ['enzyme', 'cofactors', 'structure'].map((kind) => {
    const xs = compared.filter((x) => x.r.kind === kind)
    const unflagged = xs.filter((x) => !x.r.needsReview)
    return {
      kind,
      compared: xs.length,
      agree: xs.filter((x) => x.agrees).length,
      flagged: xs.length - unflagged.length,
      unflagged: unflagged.length,
      unflaggedAgree: unflagged.filter((x) => x.agrees).length,
      afterReview: xs.filter((x) => x.agrees || x.r.needsReview).length,
    }
  }).filter((k) => k.compared)

  const disagreements = compared
    .filter((x) => !x.agrees)
    .sort((a, b) => Number(a.r.needsReview) - Number(b.r.needsReview) || a.r.pageIndex - b.r.pageIndex)
    .map((x) => ({
      page: x.r.pageIndex + 1,
      slotId: x.r.slotId,
      read: x.r.status === 'read' ? x.r.transcription ?? '' : `(${x.r.status})`,
      auto: x.r.pointsAuto,
      hand: x.hand,
      flagged: x.r.needsReview ? x.r.reviewReasons.join('; ') : null,
    }))

  return { byKind, disagreements, unmatchedPages }
}
