import { prisma } from './db/index.js'
import { getIo } from './socket.js'
import { logger } from './utils/logger.js'

const SESSION_TIMEOUT_MS = 100 * 60 * 1000 // 100 minutes

export function startScheduler() {
  setInterval(async () => {
    try {
      const cutoff = new Date(Date.now() - SESSION_TIMEOUT_MS)
      const expired = await prisma.session.findMany({
        where: { status: 'OPEN', openedAt: { lte: cutoff } },
        select: { id: true, title: true },
      })

      for (const session of expired) {
        await prisma.session.update({
          where: { id: session.id },
          data: { status: 'CLOSED', closedAt: new Date() },
        })
        getIo().to(session.id).emit('session_status', { status: 'CLOSED' })
        logger.info(`Auto-closed session "${session.title}" (${session.id}) after 100 minutes`)
      }
    } catch (err) {
      logger.error('Scheduler error:', err)
    }
  }, 60_000)
}
