import express from 'express'
import helmet from 'helmet'
import cors from 'cors'
import compression from 'compression'
import path from 'path'
import { fileURLToPath } from 'url'
import { config } from './config/index.js'
import { errorMiddleware } from './middleware/error.middleware.js'
import authRoutes from './routes/auth.routes.js'
import classRoutes from './routes/classes.routes.js'
import sessionRoutes from './routes/sessions.routes.js'
import responseRoutes from './routes/responses.routes.js'

const app = express()

app.use(helmet({ contentSecurityPolicy: config.isDev ? false : undefined }))
app.use(compression())
app.use(express.json())

if (config.isDev) {
  app.use(cors({ origin: config.frontendUrl, credentials: true }))
} else {
  app.set('trust proxy', 1)
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

app.use('/api/auth', authRoutes)
app.use('/api/classes', classRoutes)
app.use('/api', sessionRoutes)
app.use('/api', responseRoutes)

// Serve frontend in production
if (!config.isDev) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const frontendDist = path.join(__dirname, '..', '..', 'frontend', 'dist')
  app.use(express.static(frontendDist))
  app.get('*', (_req, res) => {
    res.sendFile(path.join(frontendDist, 'index.html'))
  })
}

app.use(errorMiddleware)

export default app
