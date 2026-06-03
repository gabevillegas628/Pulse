import express from 'express'
import helmet from 'helmet'
import cors from 'cors'
import compression from 'compression'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { createProxyMiddleware } from 'http-proxy-middleware'
import { config } from './config/index.js'
import { errorMiddleware } from './middleware/error.middleware.js'
import { requireAnyAuth } from './middleware/auth.middleware.js'
import rateLimit from 'express-rate-limit'
import authRoutes from './routes/auth.routes.js'
import classRoutes from './routes/classes.routes.js'
import sessionRoutes from './routes/sessions.routes.js'
import questionRoutes from './routes/questions.routes.js'
import gradingRoutes from './routes/grading.routes.js'
import extensionRoutes from './routes/extensions.routes.js'
import responseRoutes from './routes/responses.routes.js'
import uploadRoutes from './routes/uploads.routes.js'
import textbookRoutes from './routes/textbook.routes.js'

const app = express()

app.use(helmet({
  contentSecurityPolicy: config.isDev ? false : {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-eval'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      fontSrc: ["'self'", 'data:'],
      connectSrc: [
        "'self'",
        'https://api.github.com',
        'https://raw.githubusercontent.com',
      ],
    },
  },
}))
app.use(compression())

const rawIndigoUrl = process.env.INDIGO_SERVICE_URL ?? 'http://indigoservice.railway.internal'
try {
  const parsed = new URL(rawIndigoUrl)
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error()
} catch {
  throw new Error(`Invalid INDIGO_SERVICE_URL: "${rawIndigoUrl}" — must be a valid http/https URL`)
}
const indigoTarget = rawIndigoUrl

const indigoLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
})

app.use('/api/indigo', requireAnyAuth, indigoLimiter)
app.use(createProxyMiddleware({
  pathFilter: '/api/indigo',
  target: indigoTarget,
  changeOrigin: true,
  pathRewrite: { '^/api/indigo': '/v2' },
  on: { error: (_err, _req, res) => { const r = res as express.Response; if (!r.headersSent) r.status(502).json({ error: 'Indigo service unavailable' }) } },
}))

app.use(express.json())

if (config.isDev) {
  app.use(cors({ origin: config.frontendUrl, credentials: true }))
} else {
  app.set('trust proxy', 1)
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const uploadDir = path.isAbsolute(config.uploadDir)
  ? config.uploadDir
  : path.resolve(__dirname, '..', '..', config.uploadDir)

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true })
}

app.use('/uploads', express.static(uploadDir))

app.use('/api/auth', authRoutes)
app.use('/api/classes', classRoutes)
app.use('/api', sessionRoutes)
app.use('/api', questionRoutes)
app.use('/api', gradingRoutes)
app.use('/api', extensionRoutes)
app.use('/api', responseRoutes)
app.use('/api', uploadRoutes)
app.use('/api', textbookRoutes)

// Serve frontend in production
if (!config.isDev) {
  const frontendDist = path.join(__dirname, '..', '..', 'frontend', 'dist')
  app.use(express.static(frontendDist))
  app.get('*', (_req, res) => {
    res.sendFile(path.join(frontendDist, 'index.html'))
  })
}

app.use(errorMiddleware)

export default app
