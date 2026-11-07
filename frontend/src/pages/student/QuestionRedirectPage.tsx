import { useEffect, useState } from 'react'
import { useNavigate, useParams, useLocation } from 'react-router-dom'
import { io, type Socket } from 'socket.io-client'
import { api, getStudentToken } from '@/api/client'
import { useStudentAuth } from '@/context/StudentAuthContext'
import StudentLayout from '@/components/layout/StudentLayout'

// While the session is not open yet, wait for the server to say it opened: the session's
// room gets a run_status the moment the professor starts it, so the phone moves on within
// about a second. The poll is the backup for a dropped connection, and each retry also keeps
// this student counted on the professor's slide. Spread out so a hall does not ask in step.
const RETRY_MS = 13000
const RETRY_JITTER_MS = 4000
// When the session opens every waiting phone retries at once, so spread that over a moment.
const OPENED_JITTER_MS = 500
// Matches how long the server remembers a waiting student.
const GIVE_UP_MS = 10 * 60 * 1000

export default function QuestionRedirectPage() {
  const { code } = useParams<{ code: string }>()
  const [error, setError] = useState('')
  const [waiting, setWaiting] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()
  const { isAuthenticated, isLoading: authLoading } = useStudentAuth()

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      navigate(`/login?next=${location.pathname}`, { replace: true })
    }
  }, [authLoading, isAuthenticated, navigate, location.pathname])

  useEffect(() => {
    if (!isAuthenticated || !code) return
    let cancelled = false
    let timer: number | undefined
    let socket: Socket | null = null
    const startedAt = Date.now()

    function retryIn(ms: number) {
      window.clearTimeout(timer)
      timer = window.setTimeout(attempt, ms)
    }

    // Opened once, on the first refusal. Joining the room again on reconnect, because room
    // membership does not survive a drop.
    function listen(sessionId: string) {
      if (socket) return
      socket = io({ path: '/socket.io', auth: { token: getStudentToken() } })
      socket.on('connect', () => socket?.emit('join_session', sessionId))
      socket.on('run_status', ({ status }: { status: string }) => {
        // Possibly another section's run, in which case the retry is refused and the wait
        // goes on — the server decides, not this page.
        if (status === 'OPEN') retryIn(Math.random() * OPENED_JITTER_MS)
      })
    }

    function attempt() {
      api
        .get(`/questions/by-code/${code}`)
        .then((r) => { if (!cancelled) navigate(`/q/${r.data.data.questionId}`, { replace: true }) })
        .catch((e: unknown) => {
          if (cancelled) return
          const res = (e as {
            response?: { status?: number; data?: { code?: string; error?: string; sessionId?: string } }
          })?.response
          if (res?.status === 409 && res.data?.code === 'SESSION_NOT_OPEN') {
            if (Date.now() - startedAt < GIVE_UP_MS) {
              setWaiting(true)
              if (res.data.sessionId) listen(res.data.sessionId)
              retryIn(RETRY_MS + Math.random() * RETRY_JITTER_MS)
            } else {
              setWaiting(false)
              setError('This session is not open yet')
              socket?.disconnect()
            }
          } else if (res?.status === 409) setError(res.data?.error ?? 'This session is not open yet')
          else if (res?.status === 404) setError('Question not found')
          else setError('Something went wrong')
        })
    }

    attempt()
    return () => { cancelled = true; window.clearTimeout(timer); socket?.disconnect() }
  }, [isAuthenticated, code, navigate])

  if (waiting && !error) {
    return (
      <StudentLayout>
        <div className="text-center mt-20">
          <p className="font-medium text-lg text-ink">Waiting for your instructor to start…</p>
          <p className="text-sm text-muted mt-2">Keep this page open. It will continue on its own.</p>
        </div>
      </StudentLayout>
    )
  }

  if (authLoading || (!error && isAuthenticated)) {
    return (
      <StudentLayout>
        <p className="text-gray-400 text-center mt-20">Loading…</p>
      </StudentLayout>
    )
  }

  return (
    <StudentLayout>
      <div className="text-center mt-20">
        <p className="text-red-500 font-medium text-lg">{error}</p>
        <button
          onClick={() => navigate('/student')}
          className="mt-4 text-sm text-gray-500 hover:text-gray-700"
        >
          Go home
        </button>
      </div>
    </StudentLayout>
  )
}
