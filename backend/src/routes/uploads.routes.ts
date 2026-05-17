import { Router, Request, Response, NextFunction } from 'express'
import multer from 'multer'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'
import crypto from 'crypto'
import { requireProfessor } from '../middleware/auth.middleware.js'
import { config } from '../config/index.js'

const router = Router()

const uploadDir = path.isAbsolute(config.uploadDir)
  ? config.uploadDir
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', config.uploadDir)

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

router.post(
  '/uploads/image',
  requireProfessor,
  (req: Request, res: Response, next: NextFunction) => {
    upload.single('image')(req, res, (err) => {
      if (err) return next(err)
      if (!req.file) {
        res.status(400).json({ error: 'No file uploaded' })
        return
      }
      res.json({ url: `/uploads/${req.file.filename}` })
    })
  }
)

export default router
