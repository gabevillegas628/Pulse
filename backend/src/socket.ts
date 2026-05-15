import { Server } from 'socket.io'

let io: Server

export function initIo(server: Server): void {
  io = server
  io.on('connection', (socket) => {
    socket.on('join_session', (sessionId: string) => {
      socket.join(sessionId)
    })
    socket.on('leave_session', (sessionId: string) => {
      socket.leave(sessionId)
    })
  })
}

export function getIo(): Server {
  if (!io) throw new Error('Socket.io not initialized')
  return io
}
