import { useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { io, type Socket } from 'socket.io-client'
import { api, getProfessorToken } from '@/api/client'
import { apiError } from '@/lib/errors'
import ResultsSummary from '@/components/ResultsSummary'
import ThemeBars from '@/components/ThemeBars'
import PresenceGrid from '@/components/PresenceGrid'
import AnswersArriving from '@/components/AnswersArriving'
import CloseCountdown from '@/components/CloseCountdown'
import PulseMark from '@/components/ui/PulseMark'
import LiveDot from '@/components/ui/LiveDot'
import type { QuestionWithResponses, ThemeSet } from 'shared'

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
  /** Absent for FREE_TEXT — the server does not send answer text to the projector. */
  responseText?: string
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
  /** null when live theming is off for this question, not merely unstarted. */
  themes: ThemeSet | null
  /** Whether this question closes itself once answers stop arriving. */
  autoCloseOn: boolean
  /** Epoch ms deadline. null when untimed, or timed but not yet answered. */
  closesAt: number | null
  /** Length of the window `closesAt` ends, so the bar can seek into its drain. */
  closeWindowMs: number | null
}

interface LiveSession {
  id: string
  title: string
  className: string
  enrolledCount: number
  questions: LiveQuestion[]
}

type Phase = 'loading' | 'no-session' | 'live' | 'unauthorised' | 'error'

// A steady short heartbeat rather than one long timer. Chromium throttles timers hard in
// backgrounded frames, and a slide show backgrounds this one — but the Phase 0 spike showed
// a 1s interval keeps firing there, so the heartbeat stays short and decides for itself
// when a fetch is due.
const HEARTBEAT = 1000
const NO_SESSION_POLL = 5000
const LIVE_POLL = 6000
// With the socket down the poll is the only source of updates, so it tightens.
const DEGRADED_POLL = 2500
// How long to wait before re-opening a socket the server closed on us. See the disconnect
// handler: socket.io will not do it, and nothing else brings live updates back.
const SOCKET_REARM = 3000
// A question stops being the one the room is looking at long before the session closes:
// the professor moves on, and the object would otherwise hold a result from twenty minutes
// ago on the wall as though answers were still coming in. Seven minutes is longer than any
// gap between answers to a question that is genuinely open, and shorter than the stretch of
// lecture that follows one. Nothing has to be dismissed — the next answer undoes it.
const IDLE_MS = 7 * 60 * 1000
// Everything else here moves when data arrives. Going idle is defined by data *not*
// arriving, so it needs a clock of its own — an interval rather than one long timer, for
// the reason the heartbeat gives above. Coarse, because all it decides is one boolean.
const IDLE_TICK = 5000
// Lectures here run to roughly 800, and at 60 dots per row that is a block a room can
// read rather than a wall. The bar is now a guard against a roster far outside anything
// a hall holds, not a limit real classes cross.
const PRESENCE_LIMIT = 1000

export default function PresentResultsPage() {
  const [phase, setPhase] = useState<Phase>('loading')
  const [session, setSession] = useState<LiveSession | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const [message, setMessage] = useState('')
  const [idle, setIdle] = useState(false)

  const socketRef = useRef<Socket | null>(null)
  const joinedRef = useRef<string | null>(null)
  const connectedRef = useRef(false)
  const sessionIdRef = useRef<string | null>(null)
  const fetchRef = useRef<() => void>(() => {})

  // The last moment the room did anything. Taken across the whole session rather than off
  // the question on screen, though the two agree — the server picks the active question by
  // exactly this measure. A number, so the clock below re-arms when an answer lands and not
  // every time a poll hands back an equal-but-new session object.
  const lastAnswerAt = session
    ? Math.max(0, ...session.questions.map((q) =>
        q.responses[0] ? new Date(q.responses[0].submittedAt).getTime() : 0))
    : 0

  // ── Deciding the room has moved on ───────────────────────────────────────────
  useEffect(() => {
    // Setting the same boolean is dropped before a render is scheduled, so this ticks for
    // free until the moment it flips. flushSync then, for the reason it is used everywhere
    // else on this page: an unfocused add-in frame does not reliably paint a state update,
    // and this is the one transition with neither a user action nor inbound data to force
    // one — the whole point is that nothing is happening.
    const check = () =>
      flushSync(() => setIdle(lastAnswerAt > 0 && Date.now() - lastAnswerAt > IDLE_MS))
    check()
    const id = window.setInterval(check, IDLE_TICK)
    return () => window.clearInterval(id)
  }, [lastAnswerAt])

  // ── Load whatever is currently open ──────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    let inFlight = false
    let lastFetch = 0

    async function fetchNow() {
      if (inFlight || cancelled) return
      inFlight = true
      try {
        const res = await api.get('/addin/live')
        if (cancelled) return
        const data = res.data.data as { session: LiveSession | null; activeQuestionId: string | null }

        // flushSync, because React's asynchronous commit does not reliably run in an
        // unfocused add-in frame: state updated but the DOM did not, until a click forced
        // a synchronous flush. Committing here keeps the projector honest without a poke.
        flushSync(() => {
          if (!data.session) {
            setSession(null)
            sessionIdRef.current = null
            setPhase('no-session')
          } else {
            setSession(data.session)
            sessionIdRef.current = data.session.id
            // Always take the server's answer. It is derived from the most recent response,
            // so it is authoritative; the socket only fills the gaps between polls.
            setActiveId(data.activeQuestionId)
            setPhase('live')
          }
        })
      } catch (err) {
        if (cancelled) return
        const status = (err as { response?: { status?: number } })?.response?.status
        flushSync(() => {
          if (status === 401) {
            setPhase('unauthorised')
          } else {
            // Keep any results already on screen; only report the trouble.
            setMessage('Reconnecting…')
            if (!sessionIdRef.current) setPhase('error')
          }
        })
      } finally {
        inFlight = false
        lastFetch = Date.now()
      }
    }

    const id = window.setInterval(() => {
      if (cancelled) return
      const due = !sessionIdRef.current
        ? NO_SESSION_POLL
        : connectedRef.current ? LIVE_POLL : DEGRADED_POLL
      if (Date.now() - lastFetch >= due) void fetchNow()
    }, HEARTBEAT)

    // Socket handlers refetch through this, so a run opening or closing is picked up the
    // moment the server says so rather than on the next tick.
    fetchRef.current = () => { void fetchNow() }

    void fetchNow()
    return () => { cancelled = true; window.clearInterval(id) }
    // Runs once: the heartbeat reads current state from refs, so it must not be torn down
    // and rebuilt whenever the session object changes identity.
  }, [])

  // ── Live updates ─────────────────────────────────────────────────────────────
  // The socket is opened on mount, not once a session exists. Waiting meant that with
  // nothing open there was no connection at all, leaving a throttled timer as the only way
  // to notice a session starting — which is why the object needed poking to wake up.
  useEffect(() => {
    // auth as a function, not a value: socket.io re-invokes it before every connection
    // attempt, so a reconnect after a renewed token or a fresh sign-in carries the new one.
    // Passing the object froze whatever was in storage at mount, which is what left live
    // updates dead after signing back in — the poll recovered and the socket never did.
    const socket = io({ path: '/socket.io', auth: (cb) => cb({ token: getProfessorToken() }) })
    socketRef.current = socket

    socket.on('connect', () => {
      connectedRef.current = true
      flushSync(() => { setConnected(true); setMessage('') })
      // Re-join after a reconnect; room membership does not survive the drop.
      if (joinedRef.current) socket.emit('join_session', joinedRef.current)
      fetchRef.current()
    })
    socket.on('disconnect', (reason) => {
      connectedRef.current = false
      flushSync(() => { setConnected(false); setMessage('Reconnecting…') })
      // The server rejects a bad token by calling disconnect() on the socket, and socket.io
      // treats that reason as final: ondisconnect() destroys the subscription first, so the
      // client never retries. An expired token therefore left this object sitting on the
      // word "Reconnecting…" for the rest of the lecture with nothing behind it.
      //
      // Re-arm it here. `auth` is a callback, so each attempt carries whatever token is in
      // storage by then, which means a renewal — or a sign-in on any surface sharing this
      // storage — revives the socket without anyone touching this object.
      if (reason === 'io server disconnect') {
        window.setTimeout(() => {
          if (socketRef.current === socket) socket.connect()
        }, SOCKET_REARM)
      }
    })
    socket.on('connect_error', (err) => {
      connectedRef.current = false
      // The server drops sockets with no valid token, which looks identical to being
      // offline unless it is called out. Polling still works, so results stay current.
      const why = /auth|token|unauthor/i.test(err.message) ? 'Sign-in expired' : 'Reconnecting…'
      flushSync(() => { setConnected(false); setMessage(why) })
    })

    // A run opening or closing changes what should be on screen; refetch immediately.
    socket.on('run_status', () => fetchRef.current())

    // A question closing reveals its answer key, which the payload withholds while the
    // question is open. Refetch rather than derive it: the server decides what may be
    // shown, and the projector should never be the thing holding it back.
    socket.on('question_closed', () => fetchRef.current())
    socket.on('question_reopened', () => fetchRef.current())

    // Themes rebuild themselves as answers are classified. Aggregate only — the payload
    // carries counts and labels, never a response or a student.
    socket.on('themes_updated', (payload: ThemeSet & { questionId: string; runId: string }) => {
      const { questionId, runId: _runId, ...themes } = payload
      // flushSync for the same reason as below: an unfocused add-in frame does not
      // reliably commit, and bars that stop growing are worse than bars that never start.
      flushSync(() => {
        setSession((prev) => {
          if (!prev) return prev
          return {
            ...prev,
            questions: prev.questions.map((q) => (q.id === questionId ? { ...q, themes } : q)),
          }
        })
      })
    })

    socket.on('new_response', (payload: {
      questionId: string
      response: { id: string; responseText: string; wordCount: number; isFlagged: boolean; submittedAt: string; aiScore: number | null }
      // The reset, carried alongside the answer that caused it. Waiting for the next poll
      // would put the bar's jump up to six seconds after the answer that bought the time,
      // which is long enough to break the connection the room is meant to draw.
      closesAt: number | null
      closeWindowMs: number | null
    }) => {
      // The socket payload also carries the student; deliberately not destructured or
      // stored, so identity cannot reach the projector even by accident.
      const { id, responseText, wordCount, isFlagged, submittedAt, aiScore } = payload.response
      // Synchronous commit: without it the answer lands in state but never reaches the
      // screen until the object is clicked.
      flushSync(() => {
        setActiveId(payload.questionId)
        setSession((prev) => {
          if (!prev) return prev
          return {
            ...prev,
            questions: prev.questions.map((q) => {
              if (q.id !== payload.questionId || q.responses.some((r) => r.id === id)) return q
              // `/addin/live` strips answer text for FREE_TEXT; the socket does not, so
              // drop it here too or a dropped connection would quietly reintroduce what
              // the endpoint refuses to send. Nothing on this page renders it: free text
              // shows as counts and themes.
              const keepText = q.type !== 'FREE_TEXT'
              const next: LiveResponse = {
                id,
                ...(keepText ? { responseText } : {}),
                wordCount,
                isFlagged,
                submittedAt,
                aiScore,
              }
              return {
                ...q,
                responses: [next, ...q.responses],
                // Only when the server sent one: an untimed question must not acquire a
                // deadline, and a null here would wipe a good one.
                ...(payload.closesAt != null
                  ? { closesAt: payload.closesAt, closeWindowMs: payload.closeWindowMs }
                  : {}),
              }
            }),
          }
        })
      })
    })

    return () => { socket.disconnect(); socketRef.current = null }
  }, [])

  // Follow the open session into its room as it changes.
  useEffect(() => {
    const socket = socketRef.current
    if (!socket || !session?.id) return
    if (joinedRef.current && joinedRef.current !== session.id) {
      socket.emit('leave_session', joinedRef.current)
    }
    joinedRef.current = session.id
    socket.emit('join_session', session.id)
  }, [session?.id])

  // ── Render ───────────────────────────────────────────────────────────────────

  const question = session?.questions.find((q) => q.id === activeId) ?? session?.questions[0]
  const answered = question?.responses.length ?? 0
  const enrolled = session?.enrolledCount ?? 0
  const pct = enrolled > 0 ? Math.round((answered / enrolled) * 100) : 0
  // Themes take over the free-text panel once they exist. A failed set falls back to the
  // plain counts, which are still correct — never a blank projector.
  const showThemes = !!question?.themes && question.themes.status !== 'FAILED'
  const themes = question?.themes
  // Before any category exists there is nothing for ThemeBars to draw, and the wait splits
  // in two: the room is still answering, or the model is reading what it already has.
  // `need` rides along only while the server is counting toward the threshold, so its
  // absence is itself the signal that counting is over — no need to restate the number here.
  const pendingThemes = showThemes && themes!.categories.length === 0
  const sorting = pendingThemes && (themes!.need == null || themes!.total >= themes!.need)

  return (
    <div
      className="pulse-dark flex flex-col bg-surface text-ink"
      style={{ minHeight: '100vh', fontFamily: 'var(--font-ui)', padding: 'clamp(12px, 3vw, 52px)' }}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <PulseMark size={18} color="var(--signal-bright)" />
          <span className="text-muted truncate" style={{ fontSize: 'clamp(10px, 1.6vw, 28px)' }}>
            {session ? `${session.className} · ${session.title}` : 'Pulse'}
          </span>
        </div>
        {phase === 'live' && (
          <div className="flex items-center gap-1.5 shrink-0">
            {connected ? <LiveDot /> : <span className="w-1.5 h-1.5 rounded-full bg-warn" />}
            <span
              className="font-bold uppercase tracking-widest"
              style={{ fontSize: 'clamp(9px, 1.2vw, 20px)', color: connected ? 'var(--signal)' : 'var(--warn)' }}
            >
              {connected ? 'Live' : (message || 'Reconnecting')}
            </span>
          </div>
        )}
      </div>

      {phase === 'live' && question && !idle ? (
        <>
          {/* Question */}
          <p
            className="font-semibold leading-snug mt-3 shrink-0"
            style={{ fontSize: 'clamp(15px, 2.8vw, 54px)' }}
          >
            {question.text}
          </p>

          {/* The close countdown, once the question has a deadline. It has none until the
              first answer lands, so the bar appearing is itself the room being told what
              starts the clock — and every answer after that snaps it back to full. */}
          {question.autoCloseOn && question.closesAt != null && question.closeWindowMs != null && (
            <CloseCountdown
              closesAt={question.closesAt}
              windowMs={question.closeWindowMs}
              onExpire={() => fetchRef.current()}
            />
          )}

          {/* Counter + participation */}
          <div className="flex items-end justify-between gap-4 mt-4 shrink-0">
            <div className="flex items-baseline gap-2">
              <span
                // Remounting on a new total is what re-fires the pop. The animation is
                // declarative once it starts, so the count kicks without a frame loop for
                // the slide show to throttle. inline-block because transforms do not
                // apply to inline boxes.
                key={answered}
                className={`font-mono font-bold leading-none inline-block ${answered > 0 ? 'count-pop' : ''}`}
                style={{ fontSize: 'clamp(38px, 9vw, 170px)', letterSpacing: '-0.02em' }}
              >
                {answered}
              </span>
              {enrolled > 0 && (
                <span className="font-mono font-semibold text-muted" style={{ fontSize: 'clamp(14px, 3vw, 56px)' }}>
                  / {enrolled}
                </span>
              )}
            </div>
            {enrolled > 0 && (
              <div className="text-right shrink-0">
                <p
                  className="font-mono font-bold leading-none"
                  style={{ fontSize: 'clamp(18px, 4vw, 76px)', color: 'var(--signal-bright)' }}
                >
                  {pct}%
                </p>
                <p className="text-muted" style={{ fontSize: 'clamp(9px, 1.4vw, 26px)' }}>answered</p>
              </div>
            )}
          </div>

          {/* Participation, as one dot per student where that is legible. A bar creeping
              by a percent is easy to miss from the back of a hall; a dot lighting up is
              not, and it is the same fact told in a way the room reads as its own. */}
          {enrolled > 0 && (
            <div className="mt-3 shrink-0">
              {enrolled <= PRESENCE_LIMIT ? (
                <PresenceGrid answered={answered} enrolled={enrolled} />
              ) : (
                <div className="h-2 rounded-full bg-surface-2 overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-500 ease-out"
                    style={{ width: `${pct}%`, background: 'var(--signal-bright)' }}
                  />
                </div>
              )}
            </div>
          )}

          {/* Distribution. Safe for every type — ResultsSummary renders counts, never
              individual responses, and the payload carries no student identity. */}
          <div className="flex-1 overflow-y-auto mt-5 min-h-0">
            {answered === 0 ? (
              <p className="text-muted text-center py-6" style={{ fontSize: 'clamp(12px, 2vw, 30px)' }}>
                Waiting for the room…
              </p>
            ) : pendingThemes ? (
              <AnswersArriving
                wordCounts={question.responses.map((r) => r.wordCount)}
                sorting={sorting}
              />
            ) : showThemes ? (
              <ThemeBars
                variant="stage"
                categories={question.themes!.categories}
                classified={question.themes!.classified}
                total={question.themes!.total}
                status={question.themes!.status}
                need={question.themes!.need}
              />
            ) : (
              <>
                <ResultsSummary question={question as unknown as QuestionWithResponses} variant="stage" />
                {/* Themes gave up. Counts are still true, so show those and say why the
                    rest is missing rather than leaving a gap nobody can interpret. */}
                {question.themes?.status === 'FAILED' && (
                  <p className="text-muted" style={{ fontSize: 'clamp(9px, 1.3vw, 22px)' }}>
                    Themes unavailable
                  </p>
                )}
              </>
            )}
          </div>
        </>
      ) : phase === 'live' && question && idle ? (
        <Waiting question={question} answered={answered} />
      ) : (
        <Placeholder phase={phase} message={message} />
      )}
    </div>
  )
}

/**
 * The room has moved on.
 *
 * Shown once answers stopped arriving long enough ago that leaving the results up would
 * claim something untrue. A count and a participation figure on a wall say *now*; a
 * question the class finished two slides back is the one thing this object exists to never
 * be wrong about, since nobody in the room can tell a live result from a stale one.
 *
 * The last question is demoted rather than thrown away. The professor may well still be
 * discussing it, and naming it is the difference between a screen that has lost the thread
 * and one holding a place. It comes back whole the moment somebody answers.
 */
function Waiting({ question, answered }: { question: LiveQuestion; answered: number }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center gap-2">
      <p className="font-semibold" style={{ fontSize: 'clamp(16px, 3vw, 56px)' }}>
        Waiting for responses…
      </p>
      <p className="text-muted" style={{ fontSize: 'clamp(11px, 1.8vw, 34px)' }}>
        Answers appear here as they arrive
      </p>
      <p
        className="text-muted truncate w-full"
        style={{ fontSize: 'clamp(9px, 1.3vw, 22px)', opacity: 0.55, marginTop: 'clamp(6px, 1vw, 18px)' }}
      >
        Last: {question.title || question.text} · {answered} {answered === 1 ? 'response' : 'responses'}
      </p>
    </div>
  )
}

/** Every non-live state still paints something legible — a blank projector is the worst outcome. */
function Placeholder({ phase, message }: { phase: Phase; message: string }) {
  // Signing in here rather than sending the user to the task pane. Depending on a
  // *different* add-in having signed in on a *matching* origin has no reason to hold:
  // localStorage is per-origin, so changing BASE_URL, or installing this object without
  // the task pane, silently strands it with no way forward from the slide.
  if (phase === 'unauthorised') return <SignIn />

  const copy: Record<Phase, { head: string; sub: string }> = {
    loading: { head: 'Connecting…', sub: 'Looking for an open session' },
    'no-session': { head: 'No session open', sub: 'Open a session in Pulse and results will appear here' },
    unauthorised: { head: '', sub: '' },
    error: { head: 'Cannot reach Pulse', sub: message || 'Retrying…' },
    live: { head: '', sub: '' },
  }
  const { head, sub } = copy[phase]
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center gap-2">
      <p className="font-semibold" style={{ fontSize: 'clamp(16px, 3vw, 56px)' }}>{head}</p>
      <p className="text-muted" style={{ fontSize: 'clamp(11px, 1.8vw, 34px)' }}>{sub}</p>
      <Origin />
    </div>
  )
}

/**
 * Which origin this object is actually running on.
 *
 * A content add-in already placed on a slide keeps the URL it was inserted with, so after a
 * BASE_URL change it can quietly run on the old host — which still serves, still renders, and
 * still reaches the API, but is a different origin and therefore sees none of the task pane's
 * sign-in. That failure is invisible without this line.
 */
function Origin() {
  return (
    <p className="text-muted" style={{ fontSize: 'clamp(8px, 1vw, 13px)', opacity: 0.5, marginTop: 4 }}>
      {window.location.origin}
    </p>
  )
}

/** Sign in from the slide itself, so this object never depends on another add-in's state. */
function SignIn() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const res = await api.post('/auth/professor/login', { email, password })
      const token = res.data?.data?.token
      if (!token) throw new Error('No token returned')
      // Same key the task pane uses, so signing in from either place fixes both when they
      // do share an origin.
      localStorage.setItem('pulse_addin_professor_token', token)
      // Reload rather than patching state: the socket was opened on mount without a token
      // and was dropped by the server, so it needs rebuilding anyway.
      window.location.reload()
    } catch (err) {
      setError(apiError(err, 'Sign in failed'))
      setBusy(false)
    }
  }

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 w-full">
      <p className="font-semibold" style={{ fontSize: 'clamp(14px, 2.4vw, 32px)' }}>Sign in to Pulse</p>
      <form onSubmit={submit} className="w-full flex flex-col gap-2" style={{ maxWidth: 320 }}>
        <input
          type="email" value={email} onChange={(e) => setEmail(e.target.value)}
          placeholder="Email" autoComplete="username" required
          className="w-full rounded-sm px-3 py-2 bg-surface-2 text-ink border border-hairline focus:outline-none focus:ring-2 focus:ring-signal"
          style={{ fontSize: 'clamp(11px, 1.5vw, 15px)' }}
        />
        <input
          type="password" value={password} onChange={(e) => setPassword(e.target.value)}
          placeholder="Password" autoComplete="current-password" required
          className="w-full rounded-sm px-3 py-2 bg-surface-2 text-ink border border-hairline focus:outline-none focus:ring-2 focus:ring-signal"
          style={{ fontSize: 'clamp(11px, 1.5vw, 15px)' }}
        />
        <button
          type="submit" disabled={busy}
          className="w-full rounded-sm px-3 py-2 font-bold text-white disabled:opacity-50"
          style={{ background: 'var(--signal)', fontSize: 'clamp(11px, 1.5vw, 15px)' }}
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {error && (
          <p className="text-center" style={{ color: 'var(--warn)', fontSize: 'clamp(10px, 1.3vw, 14px)' }}>
            {error}
          </p>
        )}
      </form>
      <Origin />
    </div>
  )
}
