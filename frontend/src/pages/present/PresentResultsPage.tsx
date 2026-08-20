import { useEffect, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'
import { api, getProfessorToken } from '@/api/client'
import ResultsSummary from '@/components/ResultsSummary'
import PulseMark from '@/components/ui/PulseMark'
import LiveDot from '@/components/ui/LiveDot'
import type { QuestionWithResponses } from 'shared'

/**
 * Room-facing live results, rendered inside a PowerPoint content add-in on a slide.
 *
 * Two properties drive the design.
 *
 * Zero configuration: it asks the server "what is open right now?" rather than being bound
 * to a question. Opening a session is the professor's only action, and the slide follows
 * the class automatically — whichever question is receiving answers is the one shown,
 * because the students' scans are what say where the lecture is.
 *
 * Never blank: this is projected in a lecture hall, so every state paints something
 * readable. A dropout keeps the last known counts on screen rather than clearing them.
 *
 * Aggregate only. The /addin/live payload carries no student identity at all, and
 * ResultsSummary renders counts and distributions for every question type — including
 * FREE_TEXT, which shows totals rather than anyone's words.
 */

interface LiveResponse {
  id: string
  responseText: string
  wordCount: number
  isFlagged: boolean
  submittedAt: string
  aiScore: number | null
}

interface LiveQuestion {
  id: string
  title: string | null
  text: string
  type: string
  options: string[] | null
  order: number
  correctAnswer: string | null
  responses: LiveResponse[]
}

interface LiveSession {
  id: string
  title: string
  className: string
  enrolledCount: number
  questions: LiveQuestion[]
}

type Phase = 'loading' | 'no-session' | 'live' | 'unauthorised' | 'error'

const NO_SESSION_POLL = 8000
const LIVE_POLL = 30000
// When the socket is down the poll is the only source of updates, so it has to be quick
// enough to still feel live on a projector.
const DEGRADED_POLL = 4000

export default function PresentResultsPage() {
  const [phase, setPhase] = useState<Phase>('loading')
  const [session, setSession] = useState<LiveSession | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const [message, setMessage] = useState('')

  const socketRef = useRef<Socket | null>(null)
  const joinedRef = useRef<string | null>(null)
  const connectedRef = useRef(false)
  const sessionIdRef = useRef<string | null>(null)

  // ── Load whatever is currently open ──────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    let timer: number

    async function load() {
      try {
        const res = await api.get('/addin/live')
        if (cancelled) return
        const data = res.data.data as { session: LiveSession | null; activeQuestionId: string | null }

        if (!data.session) {
          setSession(null)
          sessionIdRef.current = null
          setPhase('no-session')
        } else {
          setSession(data.session)
          sessionIdRef.current = data.session.id
          // Always take the server's answer. It is derived from the most recent response, so
          // it is authoritative; the socket only fills the gaps between polls. An earlier
          // version kept the existing value once set, which pinned the display to the first
          // question forever whenever the socket was not delivering.
          setActiveId(data.activeQuestionId)
          setPhase('live')
        }
      } catch (err) {
        if (cancelled) return
        const status = (err as { response?: { status?: number } })?.response?.status
        if (status === 401) {
          setPhase('unauthorised')
        } else {
          // Keep any results already on screen; only report the trouble.
          setMessage('Reconnecting…')
          if (!session) setPhase('error')
        }
      } finally {
        if (!cancelled) {
          // Cadence from refs, so it reflects the live socket state rather than whatever
          // was captured when this effect was created.
          const delay = !sessionIdRef.current
            ? NO_SESSION_POLL
            : connectedRef.current ? LIVE_POLL : DEGRADED_POLL
          timer = window.setTimeout(load, delay)
        }
      }
    }

    load()
    return () => { cancelled = true; window.clearTimeout(timer) }
    // Runs once: the loop re-arms itself and reads current state from refs, so it must not
    // be torn down and rebuilt every time the session object changes identity.
  }, [])

  // ── Live updates ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!session?.id) return

    if (!socketRef.current) {
      const socket = io({ path: '/socket.io', auth: { token: getProfessorToken() } })
      socketRef.current = socket

      socket.on('connect', () => {
        connectedRef.current = true
        setConnected(true)
        setMessage('')
        if (joinedRef.current) socket.emit('join_session', joinedRef.current)
      })
      socket.on('disconnect', () => {
        connectedRef.current = false
        setConnected(false)
        setMessage('Reconnecting…')
      })
      socket.on('connect_error', (err) => {
        connectedRef.current = false
        setConnected(false)
        // The server drops sockets with no valid token, which looks identical to being
        // offline unless it is called out. Polling still works, so results stay current.
        setMessage(/auth|token|unauthor/i.test(err.message) ? 'Sign-in expired' : 'Reconnecting…')
      })

      socket.on('new_response', (payload: {
        questionId: string
        response: { id: string; responseText: string; wordCount: number; isFlagged: boolean; submittedAt: string; aiScore: number | null }
      }) => {
        // The socket payload also carries the student; deliberately not destructured or
        // stored, so identity cannot reach the projector even by accident.
        const { id, responseText, wordCount, isFlagged, submittedAt, aiScore } = payload.response
        setActiveId(payload.questionId)
        setSession((prev) => {
          if (!prev) return prev
          return {
            ...prev,
            questions: prev.questions.map((q) =>
              q.id !== payload.questionId || q.responses.some((r) => r.id === id)
                ? q
                : { ...q, responses: [{ id, responseText, wordCount, isFlagged, submittedAt, aiScore }, ...q.responses] }
            ),
          }
        })
      })
    }

    const socket = socketRef.current
    if (joinedRef.current && joinedRef.current !== session.id) {
      socket.emit('leave_session', joinedRef.current)
    }
    joinedRef.current = session.id
    socket.emit('join_session', session.id)
  }, [session?.id])

  useEffect(() => () => { socketRef.current?.disconnect() }, [])

  // ── Render ───────────────────────────────────────────────────────────────────

  const question = session?.questions.find((q) => q.id === activeId) ?? session?.questions[0]
  const answered = question?.responses.length ?? 0
  const enrolled = session?.enrolledCount ?? 0
  const pct = enrolled > 0 ? Math.round((answered / enrolled) * 100) : 0

  return (
    <div
      className="pulse-dark flex flex-col bg-surface text-ink"
      style={{ minHeight: '100vh', fontFamily: 'var(--font-ui)', padding: 'clamp(12px, 3vw, 28px)' }}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <PulseMark size={18} color="var(--signal-bright)" />
          <span className="text-muted truncate" style={{ fontSize: 'clamp(10px, 1.6vw, 14px)' }}>
            {session ? `${session.className} · ${session.title}` : 'Pulse'}
          </span>
        </div>
        {phase === 'live' && (
          <div className="flex items-center gap-1.5 shrink-0">
            {connected ? <LiveDot /> : <span className="w-1.5 h-1.5 rounded-full bg-warn" />}
            <span
              className="font-bold uppercase tracking-widest"
              style={{ fontSize: 'clamp(9px, 1.2vw, 11px)', color: connected ? 'var(--signal)' : 'var(--warn)' }}
            >
              {connected ? 'Live' : (message || 'Reconnecting')}
            </span>
          </div>
        )}
      </div>

      {phase === 'live' && question ? (
        <>
          {/* Question */}
          <p
            className="font-semibold leading-snug mt-3 shrink-0"
            style={{ fontSize: 'clamp(15px, 2.8vw, 30px)' }}
          >
            {question.text}
          </p>

          {/* Counter + participation */}
          <div className="flex items-end justify-between gap-4 mt-4 shrink-0">
            <div className="flex items-baseline gap-2">
              <span
                className="font-mono font-bold leading-none"
                style={{ fontSize: 'clamp(38px, 9vw, 96px)', letterSpacing: '-0.02em' }}
              >
                {answered}
              </span>
              {enrolled > 0 && (
                <span className="font-mono font-semibold text-muted" style={{ fontSize: 'clamp(14px, 3vw, 32px)' }}>
                  / {enrolled}
                </span>
              )}
            </div>
            {enrolled > 0 && (
              <div className="text-right shrink-0">
                <p
                  className="font-mono font-bold leading-none"
                  style={{ fontSize: 'clamp(18px, 4vw, 44px)', color: 'var(--signal-bright)' }}
                >
                  {pct}%
                </p>
                <p className="text-muted" style={{ fontSize: 'clamp(9px, 1.4vw, 13px)' }}>answered</p>
              </div>
            )}
          </div>

          {enrolled > 0 && (
            <div className="h-2 rounded-full bg-surface-2 overflow-hidden mt-3 shrink-0">
              <div
                className="h-full rounded-full transition-all duration-500 ease-out"
                style={{ width: `${pct}%`, background: 'var(--signal-bright)' }}
              />
            </div>
          )}

          {/* Distribution. Safe for every type — ResultsSummary renders counts, never
              individual responses, and the payload carries no student identity. */}
          <div className="flex-1 overflow-y-auto mt-5 min-h-0">
            {answered === 0 ? (
              <p className="text-muted text-center py-6" style={{ fontSize: 'clamp(12px, 2vw, 18px)' }}>
                Waiting for the room…
              </p>
            ) : (
              <ResultsSummary question={question as unknown as QuestionWithResponses} />
            )}
          </div>
        </>
      ) : (
        <Placeholder phase={phase} message={message} />
      )}
    </div>
  )
}

/** Every non-live state still paints something legible — a blank projector is the worst outcome. */
function Placeholder({ phase, message }: { phase: Phase; message: string }) {
  const copy: Record<Phase, { head: string; sub: string }> = {
    loading: { head: 'Connecting…', sub: 'Looking for an open session' },
    'no-session': { head: 'No session open', sub: 'Open a session in Pulse and results will appear here' },
    unauthorised: { head: 'Not signed in', sub: 'Sign in from the Pulse task pane, then reopen this slide' },
    error: { head: 'Cannot reach Pulse', sub: message || 'Retrying…' },
    live: { head: '', sub: '' },
  }
  const { head, sub } = copy[phase]
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center gap-2">
      <p className="font-semibold" style={{ fontSize: 'clamp(16px, 3vw, 28px)' }}>{head}</p>
      <p className="text-muted" style={{ fontSize: 'clamp(11px, 1.8vw, 15px)' }}>{sub}</p>
    </div>
  )
}
