import { Router, Request, Response, NextFunction } from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { z } from 'zod'
import { requireProfessor } from '../middleware/auth.middleware.js'
import { AppError } from '../middleware/error.middleware.js'
import { uploadDir, uploadPathSchema, deleteUploadIfUnreferenced } from '../utils/uploads.js'

const router = Router()

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true })
}

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
const MAX_SIZE_BYTES = 5 * 1024 * 1024

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    const name = crypto.randomBytes(16).toString('hex')
    cb(null, `${name}${ext}`)
  },
})

const upload = multer({
  storage,
  limits: { fileSize: MAX_SIZE_BYTES },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_TYPES.includes(file.mimetype)) {
      cb(null, true)
    } else {
      cb(new Error('Only jpg, png, gif, and webp images are allowed'))
    }
  },
})

/**
 * Multer's refusals are user mistakes, not server faults.
 *
 * Both arrive here as ordinary Errors, which the error middleware can only read as a
 * 500 — so a professor who picked a 12 MB photo was told "Internal server error" and
 * had nothing to act on. Translating them keeps the actual reason on screen.
 */
function asUploadError(err: unknown): AppError {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return new AppError('Image must be 5 MB or smaller', 400)
    return new AppError('Could not read that upload', 400)
  }
  if (err instanceof Error) return new AppError(err.message, 400)
  return new AppError('Upload failed', 400)
}

router.post(
  '/uploads/image',
  requireProfessor,
  (req: Request, res: Response, next: NextFunction) => {
    upload.single('image')(req, res, (err) => {
      if (err) return next(asUploadError(err))
      if (!req.file) {
        res.status(400).json({ error: 'No file uploaded' })
        return
      }
      res.json({ url: `/uploads/${req.file.filename}` })
    })
  }
)

/**
 * Drop an image nothing points at — the file left behind when a professor attaches one
 * and then cancels the dialog, or swaps it for another before saving.
 *
 * Safe to call with any upload path: deleteUploadIfUnreferenced counts questions first,
 * so a path that belongs to a saved question survives the call. That count is also what
 * keeps this from being a way to delete someone else's image, since the only files it
 * will touch are ones no question in the database claims.
 */
router.delete('/uploads/image', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { url } = z.object({ url: uploadPathSchema }).parse(req.body)
    await deleteUploadIfUnreferenced(url)
    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

export default router
