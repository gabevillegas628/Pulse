import { prisma } from './db/index.js'
import { getIo } from './socket.js'
import { logger } from './utils/logger.js'

const SESSION_TIMEOUT_MS = 100 * 60 * 1000 // 100 minutes

export function startScheduler() {
  setInterval(async () => {
    try {
      const cutoff = new Date(Date.now() - SESSION_TIMEOUT_MS)
      const expiredRuns = await prisma.sessionRun.findMany({
        where: { status: 'OPEN', openedAt: { lte: cutoff } },
        select: { id: true, sessionId: true, sectionId: true, session: { select: { title: true } } },
      })

      for (const run of expiredRuns) {
        await prisma.sessionRun.update({
          where: { id: run.id },
          data: { status: 'CLOSED', closedAt: new Date() },
        })
        getIo().to(run.sessionId).emit('run_status', {
          runId: run.id,
          status: 'CLOSED',
          sectionId: run.sectionId,
        })
        logger.info(`Auto-closed run "${run.id}" for session "${run.session.title}" (${run.sessionId}) after 100 minutes`)
      }
    } catch (err) {
      logger.error('Scheduler error:', err)
    }
  }, 60_000)
}
