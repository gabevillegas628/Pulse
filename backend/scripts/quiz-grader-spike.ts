/**
 * Quiz grader — Phase 0 feasibility spike (docs/quiz-grader/PLAN.md).
 *
 * Crops every slot of a filled paper quiz, skips blank ones, has Claude read the rest,
 * scores the reads in code against the pathway key, and — given the instructor's hand
 * grades — reports how often the two agree, what it cost, and how long it took.
 *
 * No database, no server. Inputs are copier scans: PDFs (one quiz per page) or page
 * images. Phone photos only work if a scanner app has already flattened and cropped
 * them to the page edge; marker-based alignment is Phase 3.
 *
 * Usage (from backend/):
 *   npx tsx scripts/quiz-grader-spike.ts --in <dir> --dry-run
 *       Crops and blank detection only, no API calls. Writes overlay images so you can
 *       check the boxes land on the blanks, and a hand-grades template CSV to fill in.
 *   ANTHROPIC_API_KEY=... npx tsx scripts/quiz-grader-spike.ts --in <dir> --grades grades.csv
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
    console.error('Missing --in <dir of scanned PDFs or images>. See the header of this file.')
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

/** Every input page as a W×H greyscale PNG under <out>/pages, named by source and page. */
async function collectPages(input: string, out: string, limit: number): Promise<{ id: string; file: string }[]> {
  const dir = path.join(out, 'pages')
  await fs.mkdir(dir, { recursive: true })
  const pages: { id: string; file: string }[] = []
  const files = (await fs.readdir(input)).filter((f) => /\.(pdf|png|jpe?g|tiff?)$/i.test(f)).sort()

  for (const f of files) {
    if (pages.length >= limit) break
    const src = path.join(input, f)
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

function pixelRect(box: Box) {
  const [x, y, w, h] = box
  const left = Math.max(0, Math.floor((x - MARGIN) * W))
  const top = Math.max(0, Math.floor((y - MARGIN) * H))
  const right = Math.min(W, Math.ceil((x + w + MARGIN) * W))
  const bottom = Math.min(H, Math.ceil((y + h + MARGIN) * H))
  return { left, top, width: right - left, height: bottom - top }
}

/** Pixels darker than mid-grey. */
async function inkPixels(img: Buffer): Promise<number> {
  const { data } = await sharp(img).greyscale().raw().toBuffer({ resolveWithObject: true })
  let dark = 0
  for (const v of data) if (v < 128) dark++
  return dark
}

async function overlay(pageFile: string, slots: GradedSlot[], blank: Set<string>, to: string) {
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
  const drawn = await sharp(pageFile).composite([{ input: svg }]).png().toBuffer()
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
  const templateInk = new Map<string, number>()
  for (const g of slots) templateInk.set(g.slot.id, await inkPixels(await sharp(template).extract(pixelRect(g.slot.box!)).toBuffer()))

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
    const img = await fs.readFile(page.file)

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
      const extra = (await inkPixels(region.png)) - (templateInk.get(g.slot.id) ?? 0)
      if (extra < Math.max(BLANK_MIN_PIXELS, BLANK_MIN_SHARE * r.width * r.height)) blank.add(g.slot.id)
    }
    await overlay(page.file, slots, blank, path.join(pageDir, 'overlay.png'))

    if (!client) {
      console.log(`  ${page.id}: ${blank.size} of ${slots.length} slots look blank${blank.size ? ` (${[...blank].join(', ')})` : ''}`)
      continue
    }

    // Region ids name the first slot in them, which is also the crop's file name.
    const regions: Region[] = [...byBox.values()]
      .map((r) => ({ id: r.slots[0]!.slot.id, png: r.png, slots: r.slots.filter((s) => !blank.has(s.slot.id)) }))
      .filter((r) => r.slots.length)
    const textRegions = regions
      .map((r) => ({ ...r, slots: r.slots.filter((s) => s.ref.kind !== 'structure') }))
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
    console.log(`  ${page.id}: ${total}/${scored.reduce((a, g) => a + g.maxPoints, 0)}, ${results.filter((r) => r.needsReview).length} to review, ${seconds.toFixed(1)}s`)
  }

  if (opt.dryRun) {
    const header = ['page', ...scored.map((g) => g.slot.id)]
    const lines = [header.join(','), ...pages.map((p) => [p.id, ...scored.map(() => '')].join(','))]
    await fs.writeFile(path.join(opt.out, 'hand-grades-template.csv'), lines.join('\n') + '\n')
    console.log(`\nCheck ${path.join(opt.out, 'pages', '<page>', 'overlay.png')} — every box should sit on its blank.`)
    console.log(`Fill in ${path.join(opt.out, 'hand-grades-template.csv')} with your points per slot, then run with --grades.`)
    return
  }

  // results.csv — one row per paper, like the eventual export.
  const header = ['page', 'name', 'netid', 'total', 'to_review', ...scored.map((g) => g.slot.id)]
  const rows = outcomes.map((o) => {
    const by = new Map(o.results.map((r) => [r.slotId, r]))
    return [
      o.id,
      by.get('name')?.transcription,
      by.get('netid')?.transcription,
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
  if (r.status !== 'read') return `(${r.status})`
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

  const missedInk = compared.filter((x) => x.r.status === 'blank' && x.hand > 0)
  if (missedInk.length) {
    out.push('', `**Blank detection missed writing on ${missedInk.length} slot(s)** — scored 0 without a read but you gave points:`)
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
