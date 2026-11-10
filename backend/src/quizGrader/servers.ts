/**
 * Is this server's scan storage safe to use? Two ways it is not, both silent until a page
 * is opened and its images are missing:
 *
 *  - The disk does not outlast a deploy: on Railway, no volume is attached, or
 *    UPLOAD_DIR points outside it. Every redeploy then wipes the scans.
 *  - Another Pulse server works from the same database. The scan and grading queues
 *    are in the database but the images are on each server's own disk, so the two
 *    servers split a batch's pages between them, and each shows the other's as missing.
 *
 * Each server checks in to QuizServer every 30 seconds; the quiz pages show what is wrong.
 */
import { randomBytes } from 'crypto'
import os from 'os'
import path from 'path'
import { prisma } from '../db/index.js'
import { uploadDir } from '../utils/uploads.js'
import { logger } from '../utils/logger.js'

const SELF = randomBytes(8).toString('hex')
const BEAT_MS = 30_000
/** A server not seen for this long is gone (a finished deploy, a stopped service). */
const GONE_MS = 2 * BEAT_MS + 15_000

const env = process.env
const label = [env.RAILWAY_SERVICE_NAME, env.RAILWAY_ENVIRONMENT_NAME].filter(Boolean).join(' / ') || os.hostname()

/** Whether scans survive a redeploy here, and if not, why. Null when that cannot be told (not on Railway). */
export function storageProblem(dir = uploadDir, e: NodeJS.ProcessEnv = env): string | null {
  const onRailway = Boolean(e.RAILWAY_ENVIRONMENT_ID || e.RAILWAY_PROJECT_ID)
  if (!onRailway) return null
  const mount = e.RAILWAY_VOLUME_MOUNT_PATH
  if (!mount) return `No volume is attached to this service, so uploaded scans (in ${dir}) are erased by every redeploy. Attach a volume and set UPLOAD_DIR to a folder inside it.`
  const rel = path.relative(path.resolve(mount), path.resolve(dir))
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return `Uploads are saved to ${dir}, which is outside the volume mounted at ${mount}, so a redeploy erases them. Set UPLOAD_DIR to ${mount} (or a folder inside it).`
  }
  return null
}

async function beat(): Promise<void> {
  await prisma.quizServer.upsert({
    where: { id: SELF },
    create: { id: SELF, label, uploadDir, seenAt: new Date() },
    update: { seenAt: new Date() },
  })
  await prisma.quizServer.deleteMany({ where: { seenAt: { lt: new Date(Date.now() - 24 * 3600_000) } } })
}

let started = false
export function startServerHeartbeat(): void {
  if (started) return
  started = true
  const problem = storageProblem()
  if (problem) logger.error('quiz scan storage is not persistent', { problem })
  const run = () => void beat().catch((e) => logger.warn('quiz server heartbeat failed', { error: (e as Error).message }))
  run()
  setInterval(run, BEAT_MS).unref()
  // A clean shutdown drops this server at once, so a redeploy's overlap clears quickly.
  const leave = () => void prisma.quizServer.delete({ where: { id: SELF } }).catch(() => undefined)
  process.once('SIGTERM', leave)
  process.once('SIGINT', leave)
}

/** Everything wrong with where scans are kept, in sentences for the quiz pages. */
export async function scanStorageWarnings(): Promise<string[]> {
  const out: string[] = []
  const problem = storageProblem()
  if (problem) out.push(problem)
  const others = await prisma.quizServer.findMany({
    where: { id: { not: SELF }, seenAt: { gt: new Date(Date.now() - GONE_MS) } },
    select: { label: true },
  })
  if (others.length) {
    const names = [...new Set(others.map((o) => o.label))].join(', ')
    out.push(`Another Pulse server (${names}) is working from this database. Each server keeps the scans it processed on its own disk, so pages from new uploads end up split between them and some show as missing. Run one Pulse server per database, then upload affected scans again. (Right after a redeploy this can show for a minute while the old server stops.)`)
  }
  return out
}
