import path from 'path'
import fs from 'fs/promises'
import { fileURLToPath } from 'url'
import { z } from 'zod'
import { prisma } from '../db/index.js'
import { config } from '../config/index.js'
import { logger } from './logger.js'

/**
 * Where uploaded images live, resolved once.
 *
 * A relative UPLOAD_DIR is read from the backend package root, not the process cwd —
 * the server is started from several places (tsx from backend/, node dist/ from the
 * image, scripts from the repo root) and the files have to land in the same directory
 * every time. In production this is an absolute path on a mounted volume, so the
 * resolve branch never runs there.
 */
export const uploadDir = path.isAbsolute(config.uploadDir)
  ? config.uploadDir
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', config.uploadDir)

/** Exactly what POST /uploads/image mints: 32 hex characters and a known extension. */
export const UPLOAD_PATH_RE = /^\/uploads\/[0-9a-f]{32}\.(jpe?g|png|gif|webp)$/

/**
 * An image reference the app itself produced.
 *
 * Question.imageUrl is interpolated straight into an <img src>, so the column must not
 * be a free-text URL field: accepting one would let a stored value point at another
 * origin — a tracking pixel served to a whole lecture, or a javascript: scheme in a
 * browser careless enough to run it. Matching the exact shape the upload route mints
 * is both the validation and the guarantee the file is ours to delete later.
 */
export const uploadPathSchema = z
  .string()
  .regex(UPLOAD_PATH_RE, 'Image must be an uploaded file reference')

/**
 * Delete the file behind an upload path, but only once no question points at it.
 *
 * The reference count is the whole point. Class duplication copies imageUrl
 * field-for-field (classes.routes.ts), so the same file legitimately backs a question
 * in this term and its copy in the next one. Deleting the old question would otherwise
 * blank the diagram in a class the professor never touched.
 *
 * Best-effort by design: a file that cannot be removed is wasted disk, while an error
 * thrown here would fail a delete the professor already watched succeed. Callers run
 * this *after* the database write commits, so the row being removed no longer counts
 * itself.
 */
export async function deleteUploadIfUnreferenced(url: string | null | undefined): Promise<void> {
  if (!url || !UPLOAD_PATH_RE.test(url)) return

  try {
    const stillUsed = await prisma.question.count({ where: { imageUrl: url } })
    if (stillUsed > 0) return

    // The regex already rules out traversal, but the resolved path is what actually
    // gets unlinked — so that is what gets checked.
    const filePath = path.join(uploadDir, path.basename(url))
    if (path.dirname(path.resolve(filePath)) !== path.resolve(uploadDir)) return

    await fs.unlink(filePath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    logger.warn('Failed to remove unreferenced upload', { url, err })
  }
}
