import 'dotenv/config'
import { createServer } from 'http'
import { Server } from 'socket.io'
import app from './app.js'
import { config } from './config/index.js'
import { initIo } from './socket.js'
import { logger } from './utils/logger.js'
import { installProcessHandlers } from './utils/reporting.js'
import { startScheduler } from './scheduler.js'
import { warmFromDb, startClockSweep } from './services/clock.service.js'
import { prisma } from './db/index.js'

// Before anything that can throw off the request path — the clock sweep, the
// scheduler, warmFromDb — so a rejection during boot is reported rather than lost.
installProcessHandlers()

const httpServer = createServer(app)

const io = new Server(httpServer, {
  cors: config.isDev ? { origin: config.frontendUrl, credentials: true } : {},
})

initIo(io)
startScheduler()
startClockSweep()
// Rebuilt from Response.submittedAt, so a restart mid-lecture does not silently
// un-time every question. Not awaited: the server must boot either way.
void warmFromDb()

httpServer.listen(config.port, () => {
  logger.info(`Server running on port ${config.port} [${config.nodeEnv}]`)
})

async function shutdown(signal: string) {
  logger.info(`${signal} received — shutting down`)
  httpServer.close(async () => {
    await io.close()
    await prisma.$disconnect()
    logger.info('Shutdown complete')
    process.exit(0)
  })
}

process.once('SIGTERM', () => shutdown('SIGTERM'))
process.once('SIGINT', () => shutdown('SIGINT'))
