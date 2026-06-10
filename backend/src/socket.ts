import { Server } from 'socket.io'
import jwt from 'jsonwebtoken'
import { config } from './config/index.js'

let io: Server

export function initIo(server: Server): void {
  io = server
  io.on('connection', (socket) => {
    const token = socket.handshake.auth?.token
    if (!token) {
      socket.disconnect()
      return
    }

    let role: string
    try {
      const decoded = jwt.verify(token, config.jwtSecret) as { role: string }
      role = decoded.role
    } catch {
      socket.disconnect()
      return
    }

    socket.on('join_session', (sessionId: string) => {
      socket.join(sessionId)
      if (role === 'professor') socket.join(`${sessionId}:professor`)
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
