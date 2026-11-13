/**
 * Scanned quiz pages: where their files live, how the vision service is called, and how a
 * page gets from "uploaded" to "aligned, version known, boxes cropped".
 *
 * Files are student work. They sit under `<UPLOAD_DIR>/.quiz-scans/`, a dot-directory that
 * the public /uploads static route never serves (app.ts also blocks it outright), and are
 * read back only through the professor-authenticated routes in quizScans.routes.ts.
 */
import fs from 'fs/promises'
import { openAsBlob } from 'fs'
import path from 'path'
import { Prisma } from '@prisma/client'
import { prisma } from '../db/index.js'
import { config } from '../config/index.js'
import { uploadDir } from '../utils/uploads.js'
import { logger } from '../utils/logger.js'
import { assessmentSchema, layoutSchema, pathwayKeySchema, slotsForVersion, versionPage } from './content.js'
import { parseSource } from './store.js'

export const SCAN_ROOT = path.join(uploadDir, '.quiz-scans')

const ID = /^[a-z0-9]+$/i
export function pageDir(batchId: string, index: number): string {
  if (!ID.test(batchId) || !Number.isInteger(index) || index < 0) throw new Error('Bad page path')
  return path.join(SCAN_ROOT, batchId, String(index))
}
export const batchDir = (batchId: string) => {
  if (!ID.test(batchId)) throw new Error('Bad batch path')
  return path.join(SCAN_ROOT, batchId)
}

/** The page as uploaded: PNG for a PDF page, JPEG for a photo. Null if not fetched yet. */
export async function originalFile(batchId: string, index: number): Promise<string | null> {
  for (const ext of ['png', 'jpg']) {
    const f = path.join(pageDir(batchId, index), `original.${ext}`)
    if (await fs.stat(f).then(() => true, () => false)) return f
  }
  return null
}

// ── Vision service ─────────────────────────────────────────────────────────────

export const visionConfigured = () => Boolean(config.visionUrl && config.visionToken)

export class VisionError extends Error {
  constructor(message: string, public status?: number) { super(message) }
}

async function vision(pathname: string, init: RequestInit = {}, timeoutMs = 120_000): Promise<Response> {
  if (!visionConfigured()) throw new VisionError('The vision service is not set up (VISION_URL, VISION_TOKEN).')
  let res: Response
  try {
    res = await fetch(`${config.visionUrl}${pathname}`, {
      ...init,
      headers: { ...(init.headers ?? {}), 'X-Vision-Token': config.visionToken },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    throw new VisionError(`The vision service did not answer: ${(e as Error).message}`)
  }
  if (!res.ok) {
    const detail = await res.json().then((j: { detail?: string }) => j.detail, () => undefined)
    throw new VisionError(detail ?? `Vision service error ${res.status}`, res.status)
  }
  return res
}

export async function visionHealthy(): Promise<boolean> {
  try {
    const r = await fetch(`${config.visionUrl}/health`, { signal: AbortSignal.timeout(5000) })
    return r.ok && ((await r.json()) as { configured?: boolean }).configured === true
  } catch {
    return false
  }
}

/** Hand an uploaded file to the vision service; it splits PDFs into pages. */
export async function createDocument(file: string, name: string): Promise<{ id: string; pages: number }> {
  const form = new FormData()
  form.append('file', await openAsBlob(file), name)
  const r = await vision('/documents', { method: 'POST', body: form }, 600_000)
  return (await r.json()) as { id: string; pages: number }
}

/** One page of a document the vision service holds, as an image. */
export async function documentPage(id: string, index: number): Promise<{ bytes: Buffer; name: string }> {
  const r = await vision(`/documents/${id}/pages/${index}`)
  return { bytes: Buffer.from(await r.arrayBuffer()), name: r.headers.get('content-type')?.includes('png') ? 'page.png' : 'page.jpg' }
}

/** Line one page image up with the blank form and cut out the given boxes. */
export async function processImage(
  image: { bytes: Buffer; name: string },
  formPdf: Uint8Array,
  spec: { versions: { name: string; page: number; boxes: { id: string; box: number[] }[] }[]; version: string | null },
): Promise<ProcessResult> {
  const form = new FormData()
  form.append('page', new Blob([new Uint8Array(image.bytes)]), image.name)
  form.append('form', new Blob([new Uint8Array(formPdf)], { type: 'application/pdf' }), 'form.pdf')
  form.append('spec', JSON.stringify(spec))
  return (await (await vision('/process', { method: 'POST', body: form })).json()) as ProcessResult
}

export async function deleteDocument(id: string): Promise<void> {
  await vision(`/documents/${id}`, { method: 'DELETE' }).catch(() => undefined)
}

// ── What a page is graded against ──────────────────────────────────────────────

interface Spec {
  versions: { name: string; page: number; boxes: { id: string; box: number[] }[] }[]
  form: Uint8Array
}

/**
 * The assessment's versions, each with its PDF page and the boxes to crop (every slot that
 * version uses, names included: crops stay in Pulse), and the layout's blank form.
 */
export async function specFor(assessmentId: string): Promise<Spec> {
  const a = await prisma.quizContent.findUniqueOrThrow({ where: { id: assessmentId }, select: { source: true, professorId: true } })
  const assessment = assessmentSchema.parse(parseSource(a.source))
  const find = (kind: 'KEY' | 'LAYOUT', slug: string) =>
    prisma.quizContent.findUnique({ where: { professorId_kind_slug: { professorId: a.professorId, kind, slug } } })
  const [keyRow, layoutRow] = await Promise.all([find('KEY', assessment.key), find('LAYOUT', assessment.layout)])
  if (!keyRow) throw new Error(`No answer key named "${assessment.key}"`)
  if (!layoutRow) throw new Error(`No layout named "${assessment.layout}"`)
  if (!layoutRow.pdf) throw new Error(`Layout "${assessment.layout}" has no blank PDF`)
  const key = pathwayKeySchema.parse(parseSource(keyRow.source))
  const layout = layoutSchema.parse(parseSource(layoutRow.source))
  return {
    form: layoutRow.pdf,
    versions: Object.keys(assessment.versions).map((name) => ({
      name,
      page: versionPage(assessment, name),
      boxes: slotsForVersion(assessment, layout, key, name).map((g) => ({ id: g.slot.id, box: g.slot.box! })),
    })),
  }
}

export interface ProcessResult {
  method: string
  markers: number
  match: number
  fits: Record<string, number>
  version: string | null
  version_detected: string | null
  aligned: string
  crops: { id: string; png: string; ink: number; blank: boolean }[]
}

// ── The worker ─────────────────────────────────────────────────────────────────

const MAX_ATTEMPTS = 3
/** A page claimed longer ago than this was dropped by a restart; it goes back in the queue. */
const STALE_MS = 5 * 60_000
const CONCURRENCY = 2

/** Fetch, align and crop one page. Throws on failure; the caller records it. */
async function processPage(pageId: string): Promise<void> {
  const page = await prisma.quizPage.findUniqueOrThrow({ where: { id: pageId }, include: { batch: true } })
  const dir = pageDir(page.batchId, page.index)
  await fs.mkdir(dir, { recursive: true })

  let original = await originalFile(page.batchId, page.index)
  if (!original) {
    if (!page.batch.visionDocId) throw new Error('The upload is gone; upload this file again.')
    let r: Response
    try {
      r = await vision(`/documents/${page.batch.visionDocId}/pages/${page.index}`)
    } catch (e) {
      if (e instanceof VisionError && e.status === 404) throw new Error('The upload expired before this page was read; upload the file again.')
      throw e
    }
    original = path.join(dir, r.headers.get('content-type')?.includes('png') ? 'original.png' : 'original.jpg')
    await fs.writeFile(original, Buffer.from(await r.arrayBuffer()))
  }

  const spec = await specFor(page.batch.assessmentId)
  const form = new FormData()
  form.append('page', await openAsBlob(original), path.basename(original))
  form.append('form', new Blob([new Uint8Array(spec.form)], { type: 'application/pdf' }), 'form.pdf')
  form.append('spec', JSON.stringify({ versions: spec.versions, version: page.versionForced }))
  const result = (await (await vision('/process', { method: 'POST', body: form })).json()) as ProcessResult

  await fs.writeFile(path.join(dir, 'aligned.png'), Buffer.from(result.aligned, 'base64'))
  // Clear crops from an earlier run (its version may have had other boxes).
  for (const f of await fs.readdir(dir)) if (f.startsWith('crop-')) await fs.rm(path.join(dir, f))
  for (const c of result.crops) {
    if (!/^[\w-]+$/.test(c.id)) continue
    await fs.writeFile(path.join(dir, `crop-${c.id}.png`), Buffer.from(c.png, 'base64'))
  }
  // A re-processed page's old scores no longer describe its crops.
  await prisma.quizSlotResult.deleteMany({ where: { pageId: page.id } })
  await prisma.quizPage.update({
    where: { id: page.id },
    data: {
      // Queue it for the grader (grading.ts) once it is lined up and its version known.
      gradeStatus: result.version && config.anthropicApiKey ? 'PENDING' : 'NONE',
      gradeAttempts: 0,
      gradeError: null,
      reads: Prisma.DbNull,
      usage: Prisma.DbNull,
      pointsAuto: null,
      maxPoints: null,
      toReview: null,
      status: result.version ? 'DONE' : 'NEEDS_VERSION',
      version: result.version,
      method: result.method,
      markers: result.markers,
      match: result.match,
      fits: result.fits,
      slots: result.crops.map(({ id, ink, blank }) => ({ id, ink, blank })),
      error: null,
      claimedAt: null,
    },
  })
}

/** Once every page of a batch has its image, the vision service can forget the upload. */
async function releaseDocument(batchId: string): Promise<void> {
  const batch = await prisma.quizBatch.findUnique({ where: { id: batchId } })
  if (!batch?.visionDocId) return
  for (let i = 0; i < batch.pageCount; i++) if (!(await originalFile(batchId, i))) return
  await deleteDocument(batch.visionDocId)
  await prisma.quizBatch.update({ where: { id: batchId }, data: { visionDocId: null } })
}

async function claim(): Promise<string | null> {
  await prisma.quizPage.updateMany({
    where: { status: 'PROCESSING', claimedAt: { lt: new Date(Date.now() - STALE_MS) } },
    data: { status: 'PENDING', claimedAt: null },
  })
  const next = await prisma.quizPage.findFirst({ where: { status: 'PENDING' }, orderBy: [{ createdAt: 'asc' }, { index: 'asc' }], select: { id: true } })
  if (!next) return null
  // Only one worker wins a page, even if two loops race to it.
  const won = await prisma.quizPage.updateMany({
    where: { id: next.id, status: 'PENDING' },
    data: { status: 'PROCESSING', claimedAt: new Date(), attempts: { increment: 1 } },
  })
  return won.count ? next.id : null
}

async function runOne(): Promise<boolean> {
  const id = await claim()
  if (!id) return false
  try {
    await processPage(id)
  } catch (e) {
    const page = await prisma.quizPage.findUnique({ where: { id }, select: { attempts: true, batchId: true } })
    const message = e instanceof Error ? e.message : String(e)
    const giveUp = !page || page.attempts >= MAX_ATTEMPTS || /upload (is gone|expired)|no blank PDF|No (answer key|layout)/i.test(message)
    logger.warn('quiz page failed', { pageId: id, attempts: page?.attempts, giveUp, error: message })
    await prisma.quizPage.update({
      where: { id },
      data: giveUp ? { status: 'FAILED', error: message, claimedAt: null } : { status: 'PENDING', error: message, claimedAt: null },
    }).catch(() => undefined)
  }
  const page = await prisma.quizPage.findUnique({ where: { id }, select: { batchId: true } })
  if (page) await releaseDocument(page.batchId).catch(() => undefined)
  return true
}

let started = false

/**
 * Process queued pages in the background, a couple at a time. Pages are claimed in the
 * database, so a restart loses nothing: an unfinished claim goes back to the queue.
 */
export function startQuizWorker(): void {
  if (started || !visionConfigured()) return
  started = true
  const loop = async () => {
    for (;;) {
      let worked = false
      try {
        worked = await runOne()
      } catch (e) {
        logger.error('quiz worker loop error', { error: (e as Error).message })
      }
      await new Promise((r) => setTimeout(r, worked ? 50 : 2000))
    }
  }
  for (let i = 0; i < CONCURRENCY; i++) void loop()
  logger.info('Quiz scan worker started')
}

/** Remove a batch's files. Best-effort: a stray file is wasted disk, not an error. */
export async function removeBatchFiles(batchId: string): Promise<void> {
  await fs.rm(batchDir(batchId), { recursive: true, force: true }).catch(() => undefined)
}
