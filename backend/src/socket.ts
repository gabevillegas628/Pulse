import { Server } from 'socket.io'
import jwt from 'jsonwebtoken'
import { config } from './config/index.js'
import { prisma } from './db/index.js'
import { ownedSession } from './utils/ownership.js'

let io: Server

interface HandshakePayload {
  sub: string
  role: string
}

type JoinAck = (result: { professor: boolean }) => void

export function initIo(server: Server): void {
  io = server
  io.on('connection', (socket) => {
    const token = socket.handshake.auth?.token
    if (!token) {
      socket.disconnect()
      return
    }

    let claims: HandshakePayload
    try {
      claims = jwt.verify(token, config.jwtSecret) as HandshakePayload
    } catch {
      socket.disconnect()
      return
    }

    // The ack is optional and the app's own clients don't pass one — it reports
    // whether the professor room was actually joined, which is otherwise only
    // observable by waiting to see whether an event turns up. That makes the
    // ownership check assertable directly instead of on a timer.
    socket.on('join_session', async (sessionId: string, ack?: JoinAck) => {
      socket.join(sessionId)
      if (claims.role !== 'professor') {
        ack?.({ professor: false })
        return
      }

      // The professor room carries netIDs and answer text as they arrive, so the
      // question is not "is this a professor" but "is this session theirs". It used
      // to be the former, which was indistinguishable while one account existed and
      // a live feed of somebody else's lecture the moment a second one did.
      //
      // The lookup costs a round trip on a join, which happens once when a projector
      // opens rather than per event, and the room is only worth joining if the answer
      // is yes.
      const owned = await prisma.session.findFirst({
        where: { id: sessionId, ...ownedSession({ id: claims.sub }) },
        select: { id: true },
      })
      if (owned) socket.join(`${sessionId}:professor`)
      ack?.({ professor: Boolean(owned) })
    })

    socket.on('leave_session', (sessionId: string) => {
      socket.leave(sessionId)
      socket.leave(`${sessionId}:professor`)
    })
  })
}

export function getIo(): Server {
  if (!io) throw new Error('Socket.io not initialized')
  return io
}
