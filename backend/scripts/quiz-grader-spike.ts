/**
 * Quiz grader — Phase 0 feasibility spike (docs/quiz-grader/PLAN.md).
 *
 * Crops every slot of a filled paper quiz, skips blank ones, has Claude read the rest,
 * scores the reads in code against the pathway key, and — given the instructor's hand
 * grades — reports how often the two agree, what it cost, and how long it took.
 *
 * Name and NetID crops are saved locally for you to match papers to students but are
 * never sent to the model; only the answer crops are.
 *
 * No database, no server. Inputs are copier scans: PDFs (one quiz per page) or page
 * images. Phone photos only work if a scanner app has already flattened and cropped
 * them to the page edge; marker-based alignment is Phase 3.
 *
 * Usage (from backend/):
 *   npx tsx scripts/quiz-grader-spike.ts --in <file or folder> --dry-run
 *       Crops and blank detection only, no API calls. Writes overlay images so you can
 *       check the boxes land on the blanks, and a hand-grades template CSV to fill in.
 *   ANTHROPIC_API_KEY=... npx tsx scripts/quiz-grader-spike.ts --in <file or folder> --grades grades.csv
 *
 * Call it with npx as above rather than `npm run quiz-grader:spike --`: PowerShell
 * drops the `--`, and npm then takes --version for itself and just prints its version.
 *       Full run. Reads are cached in <out>/cache, so a re-run only pays for new pages.
 *
 * Options:
 *   --assessment glycolysis-quiz   which seed assessment (docs/quiz-grader/seed/assessments)
 *   --version A                    quiz version all pages are on
 *   --template-page N              page of the blank PDF for that version (default: version's position)
 *   --out quiz-spike-out           output directory
 *   --limit N                      only the first N pages
 *   --model-text / --model-structure   override MODEL_TEXT / MODEL_STRUCTURE
 *
 * Each page is lined up against the blank form before cropping — shift, scale (94-106%)
 * and tilt (up to 1.5°) — and the run prints how far off each page was. A match under 60%
 * means the page did not line up: fed in very crooked, another version, or another quiz.
 * Set QG_DEBUG=1 to print each slot's handwriting pixel count.
 *
 * Requires poppler's `pdftoppm` on PATH for PDFs.
 */
import 'dotenv/config'
import { execFileSync } from 'child_process'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import Anthropic from '@anthropic-ai/sdk'
import sharp from 'sharp'
import {
  parseAssessment,
  parseLayout,
  parsePathwayKey,
  slotsForVersion,
  type Box,
  type GradedSlot,
} from '../src/quizGrader/content.js'
import { gradePage, type SlotResult } from '../src/quizGrader/grade.js'
import {
  readStructureRegions,
  readTextRegions,
  DEFAULT_MODEL_STRUCTURE,
  DEFAULT_MODEL_TEXT,
  type ReadCache,
  type Region,
  type StructureRead,
  type TextRead,
  type Usage,
} from '../src/quizGrader/reader.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const CONTENT = path.resolve(here, '..', '..', 'docs', 'quiz-grader')

/** Every page is resampled to letter at 200 dpi, so boxes map to the same pixels. */
const W = 1700
const H = 2200
const DPI = 200
/** Extra margin around each box, as a fraction of the page, for writing that strays. */
const MARGIN = 0.006
/**
 * A slot is blank when the scan has barely more ink than the template: fewer than
 * BLANK_MIN_PIXELS extra dark pixels, or BLANK_MIN_SHARE of the crop if that is more.
 * Kept low on purpose — a missed answer silently scores 0, while a false "not blank"
 * only costs one cheap read. Three letters of "TPI" are only ~150 pixels at 200 dpi.
 */
const BLANK_MIN_PIXELS = 60
const BLANK_MIN_SHARE = 0.0006
/**
 * What counts as ink: darker than this, or than 35 below the page's paper colour if the
 * scanner made the paper grey. Pencil sits around 130-200, so mid-grey (128) misses it.
 */
const INK_MAX = 200
/** Below this share of the blank form's printed lines found on the scan, warn. */
const MIN_MATCH = 0.6

/** $ per million tokens, input / output. Update from the pricing page if these move. */
const PRICES: Record<string, [number, number]> = {
  'claude-haiku-5-5': [0.1, 0.5],
  'claude-sonnet-5-5': [2, 10],
  'claude-opus-5-5': [4, 20],
  'claude-haiku-4-5': [1, 5],
}

// ── CLI ────────────────────────────────────────────────────────────────────────

function args() {
  const a = process.argv.slice(2)
  const get = (name: string) => {
    const i = a.indexOf(`--${name}`)
    return i >= 0 ? a[i + 1] : undefined
  }
  const input = get('in')
  if (!input) {
    console.error('Missing --in <a scanned PDF or image, or a folder of them>. See the header of this file.')
    process.exit(2)
  }
  return {
    input: path.resolve(input),
    out: path.resolve(get('out') ?? 'quiz-spike-out'),
    assessment: get('assessment') ?? 'glycolysis-quiz',
    version: get('version') ?? 'A',
    templatePage: get('template-page') ? Number(get('template-page')) : undefined,
    grades: get('grades') ? path.resolve(get('grades')!) : undefined,
    limit: get('limit') ? Number(get('limit')) : Infinity,
    dryRun: a.includes('--dry-run'),
    modelText: get('model-text') ?? process.env.MODEL_TEXT ?? DEFAULT_MODEL_TEXT,
    modelStructure: get('model-structure') ?? process.env.MODEL_STRUCTURE ?? DEFAULT_MODEL_STRUCTURE,
  }
}

// ── Images ─────────────────────────────────────────────────────────────────────

function pdfToPngs(pdf: string, outPrefix: string, page?: number) {
  const range = page ? ['-f', String(page), '-l', String(page), '-singlefile'] : []
  execFileSync('pdftoppm', ['-r', String(DPI), '-gray', '-png', ...range, pdf, outPrefix])
}

const SCAN_RE = /\.(pdf|png|jpe?g|tiff?)$/i

/**
 * Every input page as a W×H greyscale PNG under <out>/pages, named by source and page.
 * `input` is a folder of scans or a single scan file.
 */
async function collectPages(input: string, out: string, limit: number): Promise<{ id: string; file: string }[]> {
  const dir = path.join(out, 'pages')
  await fs.mkdir(dir, { recursive: true })
  const pages: { id: string; file: string }[] = []
  const single = (await fs.stat(input)).isFile()
  const folder = single ? path.dirname(input) : input
  const files = single ? [path.basename(input)] : (await fs.readdir(input)).filter((f) => SCAN_RE.test(f)).sort()
  if (single && !SCAN_RE.test(input)) throw new Error(`${input} is not a PDF, PNG, JPEG or TIFF`)

  for (const f of files) {
    if (pages.length >= limit) break
    const src = path.join(folder, f)
    const stem = path.parse(f).name.replace(/[^\w.-]/g, '_')

    if (/\.pdf$/i.test(f)) {
      const tmp = path.join(dir, `.raw-${stem}`)
      pdfToPngs(src, tmp)
      const rendered = (await fs.readdir(dir)).filter((r) => r.startsWith(`.raw-${stem}-`)).sort()
      for (const [i, r] of rendered.entries()) {
        const id = `${stem}-p${i + 1}`
        const file = path.join(dir, `${id}.png`)
        await sharp(path.join(dir, r)).resize(W, H, { fit: 'fill' }).greyscale().png().toFile(file)
        await fs.rm(path.join(dir, r))
        if (pages.length < limit) pages.push({ id, file })
      }
    } else {
      const file = path.join(dir, `${stem}.png`)
      await sharp(src).rotate().resize(W, H, { fit: 'fill' }).greyscale().png().toFile(file)
      pages.push({ id: stem, file })
    }
  }
  return pages
}

// ── Alignment ──────────────────────────────────────────────────────────────────

/**
 * Where the blank form sits on a scan. A form pixel t maps to the scan at
 *   centre + rotate(theta) · s · (t − centre) + (dx, dy)
 * Rotating about the page centre keeps the shift and the tilt from trading off.
 */
interface Align {
  s: number
  /** Degrees, clockwise on screen. */
  theta: number
  dx: number
  dy: number
  /** Share of the form's printed lines found on the scan at that placement. */
  match: number
}

/** A greyscale page as raw bytes, W×H, one byte per pixel. */
type Raw = Uint8Array

async function toRaw(png: Buffer, w = W, h = H): Promise<Raw> {
  const { data } = await sharp(png).resize(w, h, { fit: 'fill' }).greyscale().raw().toBuffer({ resolveWithObject: true })
  return new Uint8Array(data)
}

const fromRaw = (raw: Raw, w = W, h = H) => sharp(Buffer.from(raw), { raw: { width: w, height: h, channels: 1 } })

/** Pixels darker than `max`, grown by `r` in every direction. */
function darkMask(raw: Raw, w: number, h: number, max: number, r = 0): Uint8Array {
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (raw[y * w + x]! >= max) continue
      for (let j = Math.max(0, y - r); j <= Math.min(h - 1, y + r); j++)
        for (let i = Math.max(0, x - r); i <= Math.min(w - 1, x + r); i++) out[j * w + i] = 1
    }
  return out
}

const range = (from: number, to: number, step: number) =>
  Array.from({ length: Math.round((to - from) / step) + 1 }, (_, i) => Number((from + i * step).toFixed(4)))

/**
 * Find the placement that best lays the blank form's printed lines over the scan,
 * coarse to fine: 1/8 size over the whole plausible range, then 1/2, then full size.
 * Handwriting barely matters — the score only asks whether each printed-line pixel of
 * the form lands on ink, and pencil washes out when the image is shrunk.
 */
async function alignToTemplate(template: Buffer, page: Buffer): Promise<Align> {
  const level = async (factor: number, dark: number, everyNth: number) => {
    const w = Math.round(W / factor)
    const h = Math.round(H / factor)
    const t = darkMask(await toRaw(template, w, h), w, h, dark)
    const hit = darkMask(await toRaw(page, w, h), w, h, dark, 1)
    const xs: number[] = []
    const ys: number[] = []
    let k = 0
    for (let i = 0; i < t.length; i++) if (t[i] && k++ % everyNth === 0) { xs.push(i % w); ys.push(Math.floor(i / w)) }
    return { factor, w, h, xs, ys, hit }
  }

  type Level = Awaited<ReturnType<typeof level>>
  const search = (L: Level, thetas: number[], scales: number[], dxs: number[], dys: number[]) => {
    const cx = L.w / 2
    const cy = L.h / 2
    let best: Align = { s: 1, theta: 0, dx: 0, dy: 0, match: -1 }
    let bestCost = Infinity
    for (const theta of thetas) {
      const cos = Math.cos((theta * Math.PI) / 180)
      const sin = Math.sin((theta * Math.PI) / 180)
      for (const s of scales) {
        const px = L.xs.map((x, k) => cx + s * (cos * (x - cx) - sin * (L.ys[k]! - cy)))
        const py = L.xs.map((x, k) => cy + s * (sin * (x - cx) + cos * (L.ys[k]! - cy)))
        for (const dy of dys)
          for (const dx of dxs) {
            let n = 0
            for (let k = 0; k < px.length; k++) {
              const x = Math.round(px[k]! + dx)
              const y = Math.round(py[k]! + dy)
              if (x >= 0 && y >= 0 && x < L.w && y < L.h && L.hit[y * L.w + x]) n++
            }
            const match = px.length ? n / px.length : 0
            // On a tie, prefer the placement closest to "the scanner did nothing".
            const cost = Math.abs(theta) * 10 + Math.abs(s - 1) * 100 + Math.abs(dx) + Math.abs(dy)
            if (match > best.match || (match === best.match && cost < bestCost)) {
              best = { s, theta, dx, dy, match }
              bestCost = cost
            }
          }
      }
    }
    return best
  }

  // Coarse: ±1.5°, 94-106% (copier reduce/enlarge), ±26 px at 1/8 size ≈ ±1 inch.
  const L8 = await level(8, 170, 1)
  const a = search(L8, range(-1.5, 1.5, 0.25), range(0.94, 1.06, 0.02), range(-26, 26, 1), range(-26, 26, 1))
  const L2 = await level(2, 120, 2)
  const b = search(L2, range(a.theta - 0.25, a.theta + 0.25, 0.125), range(a.s - 0.02, a.s + 0.02, 0.005),
    range(4 * a.dx - 6, 4 * a.dx + 6, 1), range(4 * a.dy - 6, 4 * a.dy + 6, 1))
  const L1 = await level(1, 110, 4)
  const c = search(L1, range(b.theta - 0.1, b.theta + 0.1, 0.05), range(b.s - 0.004, b.s + 0.004, 0.002),
    range(2 * b.dx - 3, 2 * b.dx + 3, 1), range(2 * b.dy - 3, 2 * b.dy + 3, 1))
  return c
}

/** Resample the scan into the blank form's coordinates, so every box lands on its blank. */
function warpToTemplate(page: Raw, a: Align): Raw {
  const out = new Uint8Array(W * H).fill(255)
  const cx = W / 2
  const cy = H / 2
  const cos = Math.cos((a.theta * Math.PI) / 180)
  const sin = Math.sin((a.theta * Math.PI) / 180)
  for (let ty = 0; ty < H; ty++)
    for (let tx = 0; tx < W; tx++) {
      const x = cx + a.s * (cos * (tx - cx) - sin * (ty - cy)) + a.dx
      const y = cy + a.s * (sin * (tx - cx) + cos * (ty - cy)) + a.dy
      const x0 = Math.floor(x)
      const y0 = Math.floor(y)
      if (x0 < 0 || y0 < 0 || x0 >= W - 1 || y0 >= H - 1) continue
      const fx = x - x0
      const fy = y - y0
      const i = y0 * W + x0
      out[ty * W + tx] = Math.round(
        page[i]! * (1 - fx) * (1 - fy) + page[i + 1]! * fx * (1 - fy) + page[i + W]! * (1 - fx) * fy + page[i + W + 1]! * fx * fy,
      )
    }
  return out
}

const mm = (px: number) => `${px >= 0 ? '+' : ''}${((px / DPI) * 25.4).toFixed(1)}mm`
const describeAlign = (a: Align) =>
  `shift ${mm(a.dx)} across, ${mm(a.dy)} down, tilt ${a.theta.toFixed(2)}°, scale ${(a.s * 100).toFixed(1)}%, match ${(a.match * 100).toFixed(0)}%`

// ── Ink ────────────────────────────────────────────────────────────────────────

function pixelRect(box: Box) {
  const [x, y, w, h] = box
  const left = Math.max(0, Math.floor((x - MARGIN) * W))
  const top = Math.max(0, Math.floor((y - MARGIN) * H))
  const right = Math.min(W, Math.ceil((x + w + MARGIN) * W))
  const bottom = Math.min(H, Math.ceil((y + h + MARGIN) * H))
  return { left, top, width: right - left, height: bottom - top }
}

/** The paper's grey level: the most common value among the lighter half of pixels. */
function paperLevel(raw: Raw): number {
  const hist = new Array<number>(256).fill(0)
  for (let i = 0; i < raw.length; i += 7) hist[raw[i]!]!++
  let best = 255
  for (let v = 128; v < 256; v++) if (hist[v]! > hist[best]!) best = v
  return best
}

/**
 * Handwriting pixels in a box: ink on the aligned scan that is not within a few pixels
 * of anything printed on the blank form. Printed lines never count, even when the
 * alignment is a pixel or two off.
 */
function newInk(page: Raw, printed: Uint8Array, rect: ReturnType<typeof pixelRect>, inkMax: number): number {
  let n = 0
  for (let y = rect.top; y < rect.top + rect.height; y++)
    for (let x = rect.left; x < rect.left + rect.width; x++) {
      const i = y * W + x
      if (page[i]! < inkMax && !printed[i]) n++
    }
  return n
}

async function overlay(page: Buffer, slots: GradedSlot[], blank: Set<string>, to: string) {
  const rects = slots
    .map((g) => {
      const r = pixelRect(g.slot.box!)
      const colour = blank.has(g.slot.id) ? '#999' : g.ref.kind === 'structure' ? '#c026d3' : '#2563eb'
      return `<rect x="${r.left}" y="${r.top}" width="${r.width}" height="${r.height}" fill="none" stroke="${colour}" stroke-width="4"/>
<text x="${r.left + 6}" y="${r.top + 26}" font-size="24" font-family="sans-serif" fill="${colour}">${g.slot.id}</text>`
    })
    .join('\n')
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${rects}</svg>`)
  // sharp resizes before it composites, so draw at full size first, then shrink.
  const drawn = await sharp(page).composite([{ input: svg }]).png().toBuffer()
  await sharp(drawn).resize(Math.round(W / 2)).png().toFile(to)
}

// ── Cache and CSV ──────────────────────────────────────────────────────────────

function fileCache(dir: string): ReadCache {
  return {
    async get(k) {
      try {
        return JSON.parse(await fs.readFile(path.join(dir, `${k}.json`), 'utf8'))
      } catch {
        return undefined
      }
    },
    async set(k, v) {
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, `${k}.json`), JSON.stringify(v))
    },
  }
}

const csvCell = (v: unknown) => {
  const s = v === undefined || v === null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function parseCsv(src: string): Record<string, string>[] {
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
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? '').trim()])))
}

// ── Main ───────────────────────────────────────────────────────────────────────

interface PageOutcome {
  id: string
  results: SlotResult[]
  seconds: number
  usage: Usage[]
}

async function main() {
  const opt = args()
  const assessment = parseAssessment(await fs.readFile(path.join(CONTENT, 'seed/assessments', `${opt.assessment}.yaml`), 'utf8'))
  const key = parsePathwayKey(await fs.readFile(path.join(CONTENT, 'seed/keys', `${assessment.key}.yaml`), 'utf8'))
  const layout = parseLayout(await fs.readFile(path.join(CONTENT, 'seed/layouts', `${assessment.layout}.yaml`), 'utf8'))
  const slots = slotsForVersion(assessment, layout, key, opt.version)
  const scored = slots.filter((g) => g.maxPoints > 0)

  await fs.mkdir(opt.out, { recursive: true })

  // The blank form for this version: the baseline for "is anything written here".
  const templatePage = opt.templatePage ?? Object.keys(assessment.versions).indexOf(opt.version) + 1
  const templatePrefix = path.join(opt.out, 'template')
  pdfToPngs(path.join(CONTENT, layout.page.source_pdf), templatePrefix, templatePage)
  const template = await sharp(`${templatePrefix}.png`).resize(W, H, { fit: 'fill' }).greyscale().png().toBuffer()
  // Everything printed on the form, grown by 4 px so a slightly-off alignment or a
  // thicker copier line still falls inside it.
  const printed = darkMask(await toRaw(template), W, H, 230, 4)

  const pages = await collectPages(opt.input, opt.out, opt.limit)
  if (!pages.length) throw new Error(`No PDFs or images found in ${opt.input}`)
  console.log(`${pages.length} page(s), version ${opt.version}, ${scored.length} scored slots each${opt.dryRun ? ' — dry run, no API calls' : ''}`)

  const client = opt.dryRun ? null : new Anthropic()
  const cache = fileCache(path.join(opt.out, 'cache'))
  const outcomes: PageOutcome[] = []

  for (const page of pages) {
    const started = Date.now()
    const pageDir = path.join(opt.out, 'pages', page.id)
    await fs.mkdir(pageDir, { recursive: true })
    const scanned = await fs.readFile(page.file)
    const align = await alignToTemplate(template, scanned)
    const raw = warpToTemplate(await toRaw(scanned), align)
    const img = await fromRaw(raw).png().toBuffer()
    await fs.writeFile(path.join(pageDir, 'aligned.png'), img)
    const inkMax = Math.min(INK_MAX, paperLevel(raw) - 35)
    const placed = describeAlign(align)
    if (align.match < MIN_MATCH) {
      console.log(`  ${page.id}: WARNING — only ${(align.match * 100).toFixed(0)}% of the form's lines found. Crooked, a different version, or not this quiz?`)
    }

    // Crop each distinct box once; slots that share a box share the crop.
    const byBox = new Map<string, { png: Buffer; slots: GradedSlot[] }>()
    const blank = new Set<string>()
    for (const g of slots) {
      const k = JSON.stringify(g.slot.box)
      let region = byBox.get(k)
      if (!region) {
        region = { png: await sharp(img).extract(pixelRect(g.slot.box!)).png().toBuffer(), slots: [] }
        byBox.set(k, region)
        await fs.writeFile(path.join(pageDir, `${g.slot.id}.png`), region.png)
      }
      region.slots.push(g)
      const r = pixelRect(g.slot.box!)
      const ink = newInk(raw, printed, r, inkMax)
      const need = Math.max(BLANK_MIN_PIXELS, BLANK_MIN_SHARE * r.width * r.height)
      if (process.env.QG_DEBUG) console.log(`    ${g.slot.id}: ${ink} handwriting px, blank below ${need.toFixed(0)}`)
      if (ink < need) blank.add(g.slot.id)
    }
    await overlay(img, slots, blank, path.join(pageDir, 'overlay.png'))

    if (!client) {
      console.log(`  ${page.id}: ${placed}; ${blank.size} of ${slots.length} slots look blank${blank.size ? ` (${[...blank].join(', ')})` : ''}`)
      continue
    }

    // Region ids name the first slot in them, which is also the crop's file name.
    const regions: Region[] = [...byBox.values()]
      .map((r) => ({ id: r.slots[0]!.slot.id, png: r.png, slots: r.slots.filter((s) => !blank.has(s.slot.id)) }))
      .filter((r) => r.slots.length)
    const textRegions = regions
      .map((r) => ({ ...r, slots: r.slots.filter((s) => s.ref.kind === 'enzyme' || s.ref.kind === 'cofactors') }))
      .filter((r) => r.slots.length)
    const structRegions = regions
      .map((r) => ({ ...r, slots: r.slots.filter((s) => s.ref.kind === 'structure') }))
      .filter((r) => r.slots.length)

    const usage: Usage[] = []
    const [text, struct] = await Promise.all([
      textRegions.length ? readTextRegions(client, key, textRegions, { model: opt.modelText, cache }) : null,
      structRegions.length ? readStructureRegions(client, structRegions, { model: opt.modelStructure, cache }) : null,
    ])
    if (text) usage.push(text.usage)
    if (struct) usage.push(struct.usage)

    const results = gradePage(slots, blank, text?.reads ?? new Map<string, TextRead>(), struct?.reads ?? new Map<string, StructureRead>())
    const seconds = (Date.now() - started) / 1000
    outcomes.push({ id: page.id, results, seconds, usage })
    await fs.writeFile(path.join(pageDir, 'results.json'), JSON.stringify(results, null, 2))
    const total = results.reduce((a, r) => a + r.pointsAuto, 0)
    console.log(`  ${page.id}: ${placed}; ${total}/${scored.reduce((a, g) => a + g.maxPoints, 0)}, ${results.filter((r) => r.needsReview).length} to review, ${seconds.toFixed(1)}s`)
  }

  if (opt.dryRun) {
    const header = ['page', ...scored.map((g) => g.slot.id)]
    const lines = [header.join(','), ...pages.map((p) => [p.id, ...scored.map(() => '')].join(','))]
    // Never overwrite a template someone may already have filled in with their grades.
    let template = path.join(opt.out, 'hand-grades-template.csv')
    if (await fs.stat(template).then(() => true, () => false)) template = path.join(opt.out, 'hand-grades-template.new.csv')
    await fs.writeFile(template, lines.join('\n') + '\n')
    console.log(`\nCheck ${path.join(opt.out, 'pages', '<page>', 'overlay.png')} — every box should sit on its blank.`)
    console.log(`Fill in ${template} with your points per slot, then run with --grades.`)
    return
  }

  // results.csv — one row per paper. No names: those were never read. Each paper's
  // name and NetID crops are in pages/<page>/ for matching by hand.
  const header = ['page', 'total', 'to_review', ...scored.map((g) => g.slot.id)]
  const rows = outcomes.map((o) => {
    const by = new Map(o.results.map((r) => [r.slotId, r]))
    return [
      o.id,
      o.results.reduce((a, r) => a + r.pointsAuto, 0),
      o.results.filter((r) => r.needsReview).length,
      ...scored.map((g) => by.get(g.slot.id)?.pointsAuto),
    ].map(csvCell).join(',')
  })
  await fs.writeFile(path.join(opt.out, 'results.csv'), [header.join(','), ...rows].join('\n') + '\n')

  const hand = opt.grades ? new Map(parseCsv(await fs.readFile(opt.grades, 'utf8')).map((r) => [r.page!, r])) : null
  await fs.writeFile(path.join(opt.out, 'report.md'), report(opt, outcomes, scored, hand))
  console.log(`\nWrote ${path.join(opt.out, 'report.md')} and results.csv`)
}

// ── Report ─────────────────────────────────────────────────────────────────────

function describeRead(r: SlotResult): string {
  if (r.status !== 'read') return `(${r.status}${r.blankBy === 'model' ? ': model saw nothing' : r.blankBy === 'ink' ? ': no ink, not read' : ''})`
  if (r.kind === 'cofactors') return r.cofactors!.map((c) => `${c.text}→${c.side}`).join(', ') || '(nothing)'
  if (r.kind === 'structure') return `${r.description} [${r.features!.map((f) => (f.present ? '✓' : '✗')).join('')}]`
  return `"${r.transcription}"${r.match ? ` ${r.match.verdict} ${r.match.alias} d=${r.match.distance}` : ''}`
}

function report(
  opt: ReturnType<typeof args>,
  outcomes: PageOutcome[],
  scored: GradedSlot[],
  hand: Map<string, Record<string, string>> | null,
): string {
  // Cached calls carry the usage from when they were first made, so the cost here is
  // what grading these pages costs, however many re-runs it took to get the report.
  const usage = outcomes.flatMap((o) => o.usage)
  const cachedCalls = usage.filter((u) => u.cached).length
  const cost = usage.reduce((a, u) => {
    const p = PRICES[u.model]
    return p ? a + (u.input_tokens * p[0] + u.output_tokens * p[1]) / 1e6 : a
  }, 0)
  const unpriced = [...new Set(usage.filter((u) => !PRICES[u.model]).map((u) => u.model))]
  const pages = outcomes.length
  const secs = outcomes.map((o) => o.seconds)
  const all = outcomes.flatMap((o) => o.results.filter((r) => r.maxPoints > 0).map((r) => ({ page: o.id, r })))

  const out: string[] = [
    `# Quiz grader spike — ${opt.assessment}, version ${opt.version}`,
    '',
    `- Pages: ${pages}; scored slots per page: ${scored.length}`,
    `- Models: text ${opt.modelText}, structures ${opt.modelStructure}`,
    `- Cost: $${cost.toFixed(4)} total, $${(cost / Math.max(1, pages)).toFixed(4)} per page` +
      (cachedCalls ? ` (${cachedCalls} of ${usage.length} calls came from the cache this run and were not billed again)` : '') +
      (unpriced.length ? ` — no price on file for ${unpriced.join(', ')}` : ''),
    `- Time: ${(secs.reduce((a, b) => a + b, 0) / Math.max(1, pages)).toFixed(1)}s per page on average, ${Math.max(0, ...secs).toFixed(1)}s slowest (text and structure calls run in parallel${cachedCalls ? '; cached pages are near-instant, so time a fresh --out' : ''})`,
    `- Flagged for review: ${all.filter((x) => x.r.needsReview).length} of ${all.length} slots`,
    '',
  ]

  if (!hand) {
    out.push('No hand grades given (--grades), so no agreement figures. Fill in hand-grades-template.csv from a --dry-run.')
    return out.join('\n') + '\n'
  }

  const compared = all
    .map((x) => {
      const raw = hand.get(x.page)?.[x.r.slotId]
      return raw === undefined || raw === '' ? null : { ...x, hand: Number(raw) }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null && !Number.isNaN(x.hand))
  const agrees = (x: { r: SlotResult; hand: number }) => Math.abs(x.r.pointsAuto - x.hand) < 0.01

  out.push('## Agreement with hand grades', '')
  out.push('"After review" counts a flagged slot as agreeing, since you would see and fix it. That is the figure the ≥ 98% target in SPEC.md is about. "Unflagged" is the one to worry about: those are wrong grades nobody would look at.', '')
  out.push('| slot type | compared | raw agreement | flagged | unflagged agreement | after review |')
  out.push('|---|---|---|---|---|---|')
  for (const kind of ['enzyme', 'cofactors', 'structure'] as const) {
    const xs = compared.filter((x) => x.r.kind === kind)
    if (!xs.length) continue
    const unflagged = xs.filter((x) => !x.r.needsReview)
    const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : '—')
    out.push(
      `| ${kind} | ${xs.length} | ${pct(xs.filter(agrees).length, xs.length)} | ${pct(xs.length - unflagged.length, xs.length)} | ${pct(unflagged.filter(agrees).length, unflagged.length)} | ${pct(xs.filter((x) => agrees(x) || x.r.needsReview).length, xs.length)} |`,
    )
  }

  // Only the ink check's blanks: the model's "blank" reads are ordinary disagreements.
  const missedInk = compared.filter((x) => x.r.blankBy === 'ink' && x.hand > 0)
  if (missedInk.length) {
    out.push('', `**The ink check skipped writing on ${missedInk.length} slot(s)** — never sent to the model, scored 0, but you gave points:`)
    for (const x of missedInk) out.push(`- ${x.page} ${x.r.slotId} (hand ${x.hand})`)
  }

  const wrong = compared.filter((x) => !agrees(x)).sort((a, b) => Number(a.r.needsReview) - Number(b.r.needsReview))
  out.push('', `## Disagreements (${wrong.length}) — unflagged first`, '')
  if (wrong.length) {
    out.push('| page | slot | read | auto | hand | flagged |', '|---|---|---|---|---|---|')
    for (const x of wrong.slice(0, 60)) {
      out.push(`| ${x.page} | [${x.r.slotId}](pages/${x.page}/) | ${describeRead(x.r).replace(/\|/g, '\\|')} | ${x.r.pointsAuto} | ${x.hand} | ${x.r.needsReview ? x.r.reviewReasons.join('; ') : '**no**'} |`)
    }
    if (wrong.length > 60) out.push('', `…and ${wrong.length - 60} more in pages/*/results.json.`)
  } else out.push('None.')

  const missing = all.length - compared.length
  if (missing) out.push('', `${missing} slot(s) had no hand grade and were left out of the comparison.`)
  return out.join('\n') + '\n'
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
