import { createServer } from 'http'
import { Server } from 'socket.io'
import app from './app.js'
import { config } from './config/index.js'
import { initIo } from './socket.js'
import { logger } from './utils/logger.js'

const httpServer = createServer(app)

const io = new Server(httpServer, {
  cors: config.isDev ? { origin: config.frontendUrl, credentials: true } : {},
})

initIo(io)

httpServer.listen(config.port, () => {
  logger.info(`Server running on port ${config.port} [${config.nodeEnv}]`)
})
