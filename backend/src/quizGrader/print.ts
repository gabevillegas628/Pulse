/**
 * Print-ready quiz pages: the blank form, shrunk slightly, with an ArUco marker in each
 * corner.
 *
 * The markers are what lets a phone photo taken at an angle be flattened exactly
 * (Phase 6): four known points are all a perspective correction needs. Copier scans do
 * not need them — those are lined up against the form's printed lines — but a page with
 * markers works both ways, and a page without them still works the old way.
 *
 * The form is scaled about the page centre to clear the corners, so a point on the
 * printed page is not where it was on the original PDF. Layout boxes stay in the
 * original's coordinates; `printedToSource` converts, and `markerCentres` says where the
 * markers are in those same coordinates for whoever detects them.
 */
import { PDFDocument, rgb } from 'pdf-lib'

/**
 * The form's size on the printed page, about the centre. 0.90 clears the corners even on
 * forms printed edge to edge (the TCA quiz's "Name:" sits 0.3" from the top).
 *
 * Do not change it once quizzes have been printed: a page's markers are read against
 * this number, so pages printed under the old value would be flattened to the wrong size.
 */
export const PRINT_SCALE = 0.9
const INCH = 72
/** Marker edge, and its distance from the paper's edge: inside any printer's margin. */
export const MARKER_SIZE_IN = 0.4
export const MARKER_INSET_IN = 0.22

/**
 * ArUco DICT_4X4_50, ids 0-3: the 4×4 data bits inside a one-cell black border, rows top
 * to bottom, 1 = white. Copied from OpenCV's own dictionary (cv2.aruco, 5.0), so any
 * standard ArUco detector — OpenCV in Python, or js-aruco2 in a phone browser — reads
 * them. Order on the page: 0 top-left, 1 top-right, 2 bottom-right, 3 bottom-left.
 */
export const MARKERS: Record<number, string[]> = {
  0: ['1011', '0101', '0011', '0010'],
  1: ['0000', '1111', '1001', '1010'],
  2: ['0011', '0011', '0010', '1101'],
  3: ['1001', '1001', '0100', '0110'],
}
export const MARKER_IDS = { topLeft: 0, topRight: 1, bottomRight: 2, bottomLeft: 3 } as const

/** A point on the printed page → the same point on the original form, as page fractions. */
export const printedToSource = (f: number) => 0.5 + (f - 0.5) / PRINT_SCALE
export const sourceToPrinted = (f: number) => 0.5 + (f - 0.5) * PRINT_SCALE

/**
 * Where each marker's centre falls, in the original form's page fractions (outside 0–1,
 * since the markers sit in the margin the shrink made). Width and height in inches.
 */
export function markerCentres(widthIn: number, heightIn: number): Record<number, [number, number]> {
  const c = MARKER_INSET_IN + MARKER_SIZE_IN / 2
  const fx = (x: number) => printedToSource(x / widthIn)
  const fy = (y: number) => printedToSource(y / heightIn)
  return {
    [MARKER_IDS.topLeft]: [fx(c), fy(c)],
    [MARKER_IDS.topRight]: [fx(widthIn - c), fy(c)],
    [MARKER_IDS.bottomRight]: [fx(widthIn - c), fy(heightIn - c)],
    [MARKER_IDS.bottomLeft]: [fx(c), fy(heightIn - c)],
  }
}

/**
 * The given pages of a blank form (1-based, in order), each shrunk onto its own page with
 * the four corner markers.
 */
export async function printablePdf(formPdf: Uint8Array, pages: number[]): Promise<Uint8Array> {
  const src = await PDFDocument.load(formPdf)
  const count = src.getPageCount()
  for (const n of pages) if (n < 1 || n > count) throw new Error(`The form PDF has ${count} page(s); there is no page ${n}`)

  const out = await PDFDocument.create()
  const embedded = await out.embedPdf(src, pages.map((n) => n - 1))
  for (const form of embedded) {
    const { width, height } = form
    const page = out.addPage([width, height])
    page.drawPage(form, {
      x: (width * (1 - PRINT_SCALE)) / 2,
      y: (height * (1 - PRINT_SCALE)) / 2,
      xScale: PRINT_SCALE,
      yScale: PRINT_SCALE,
    })
    const size = MARKER_SIZE_IN * INCH
    const inset = MARKER_INSET_IN * INCH
    // PDF origin is bottom-left; these are each marker's top-left corner.
    const corners: Record<number, [number, number]> = {
      [MARKER_IDS.topLeft]: [inset, height - inset],
      [MARKER_IDS.topRight]: [width - inset - size, height - inset],
      [MARKER_IDS.bottomRight]: [width - inset - size, inset + size],
      [MARKER_IDS.bottomLeft]: [inset, inset + size],
    }
    for (const [id, [left, top]] of Object.entries(corners)) drawMarker(page, MARKERS[Number(id)]!, left, top, size)
  }
  return out.save()
}

function drawMarker(page: ReturnType<PDFDocument['addPage']>, bits: string[], left: number, top: number, size: number) {
  const cell = size / 6
  const black = rgb(0, 0, 0)
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 6; c++) {
      const border = r === 0 || r === 5 || c === 0 || c === 5
      const white = !border && bits[r - 1]![c - 1] === '1'
      // A hair of overlap so no anti-aliased seam shows between neighbouring cells.
      if (!white) page.drawRectangle({ x: left + c * cell, y: top - (r + 1) * cell, width: cell + 0.05, height: cell + 0.05, color: black })
    }
  }
}
