import axios from 'axios'

export const api = axios.create({ baseURL: '/api' })

/** The header the server renews a professor token on. See auth.middleware.ts. */
const RENEWED_TOKEN_HEADER = 'x-pulse-token'

const PROFESSOR_KEY = 'professor_token'
// Pages rendered inside PowerPoint share an origin with the task pane, which is where the
// professor signed in — the browser's own professor_token is in a different storage
// partition and will not be there.
const ADDIN_PROFESSOR_KEY = 'pulse_addin_professor_token'
const STUDENT_KEY = 'student_token'

/** Whichever token a request would carry, professor taking precedence on shared pages. */
function readAuthToken(): string | null {
  return (
    localStorage.getItem(PROFESSOR_KEY) ??
    localStorage.getItem(ADDIN_PROFESSOR_KEY) ??
    localStorage.getItem(STUDENT_KEY)
  )
}

/**
 * Store a token the server renewed, under the key the request read from.
 *
 * Deliberately not always `professor_token`: writing there from an add-in surface would
 * have PowerPoint quietly adopt the browser's key and leave the add-in's own untouched and
 * expiring. Re-running the read precedence names the key that was actually sent.
 */
function storeRenewedToken(token: string): void {
  if (localStorage.getItem(PROFESSOR_KEY)) localStorage.setItem(PROFESSOR_KEY, token)
  else if (localStorage.getItem(ADDIN_PROFESSOR_KEY)) localStorage.setItem(ADDIN_PROFESSOR_KEY, token)
}

api.interceptors.request.use((config) => {
  const token = readAuthToken()
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

type AuthHandler = () => void
let onAuthExpired: AuthHandler | null = null
let onAuthRecovered: AuthHandler | null = null
// Whether the last word from the server was a 401, so recovery fires on the transition
// rather than on every successful response.
let authExpired = false

export function setAuthExpiredHandler(handler: AuthHandler) {
  onAuthExpired = handler
}

/** Called when a request succeeds after a 401 — auth is working again. */
export function setAuthRecoveredHandler(handler: AuthHandler) {
  onAuthRecovered = handler
}

api.interceptors.response.use(
  (res) => {
    const renewed = res.headers?.[RENEWED_TOKEN_HEADER]
    if (typeof renewed === 'string' && renewed) storeRenewedToken(renewed)
    // Nothing else takes the expired flag down. Without this the "Session expired" prompt
    // outlives the problem it was reporting: an add-in object whose sibling signed back in,
    // or whose token was renewed, would keep the dialog up while its polls quietly worked.
    if (authExpired) {
      authExpired = false
      onAuthRecovered?.()
    }
    return res
  },
  (err) => {
    if (err.response?.status === 401) {
      // A 401 for a token storage has already moved past is an obsolete answer — a renewal
      // landed, or another add-in object sharing this storage signed back in, while this
      // request was in flight. Acting on it would sign everyone out on stale news.
      const failed = String(err.config?.headers?.Authorization ?? '').replace(/^Bearer /, '')
      if (failed && failed !== readAuthToken()) return Promise.reject(err)

      authExpired = true
      const isLoginRoute = window.location.pathname === '/login'
      if (!isLoginRoute && onAuthExpired) {
        onAuthExpired()
      } else if (!isLoginRoute) {
        localStorage.removeItem(PROFESSOR_KEY)
        localStorage.removeItem(STUDENT_KEY)
        window.location.href = '/login'
      }
    }
    return Promise.reject(err)
  }
)

export function setProfessorToken(token: string | null): void {
  if (token) {
    localStorage.setItem(PROFESSOR_KEY, token)
    return
  }
  localStorage.removeItem(PROFESSOR_KEY)
  // The add-in key goes too. Leaving it meant getProfessorToken() kept handing a token
  // already known to be dead to the socket, which then failed every reconnect attempt with
  // "Sign-in expired" and no way out of it but a manual sign-in on that object.
  localStorage.removeItem(ADDIN_PROFESSOR_KEY)
}

export function setStudentToken(token: string | null): void {
  if (token) localStorage.setItem(STUDENT_KEY, token)
  else localStorage.removeItem(STUDENT_KEY)
}

export function getProfessorToken(): string | null {
  // Same precedence as the request interceptor, minus the student key. Socket auth reads
  // this, so missing the add-in fallback silently kills all live updates.
  return localStorage.getItem(PROFESSOR_KEY) ?? localStorage.getItem(ADDIN_PROFESSOR_KEY)
}

export function getStudentToken(): string | null {
  return localStorage.getItem(STUDENT_KEY)
}
