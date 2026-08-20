/**
 * Minimal API client for the add-in.
 *
 * Deliberately not axios: the task pane is a separate tiny bundle and this is the only
 * networking it does. Mirrors the token handling in frontend/src/api/client.ts.
 *
 * SECURITY: the professor token lives in the task pane's localStorage and NEVER in
 * document settings or shape tags — a .pptx gets shared with TAs and students.
 */

const TOKEN_KEY = 'pulse_addin_professor_token'

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token)
  else localStorage.removeItem(TOKEN_KEY)
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken()
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  })

  const body = await res.json().catch(() => null)
  if (!res.ok) {
    if (res.status === 401) setToken(null)
    throw new ApiError(body?.error ?? `Request failed (${res.status})`, res.status)
  }
  return body.data as T
}

const get = <T>(path: string) => request<T>(path)
const post = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body) })

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ClassSummary {
  id: string
  name: string
  description: string | null
}

export interface SessionSummary {
  id: string
  title: string
  status: string
  isLive: boolean
  _count: { questions: number }
}

export interface QuestionSummary {
  id: string
  title: string | null
  text: string
  type: string
  order: number
  accessCode: string
  qrDataUrl?: string
}

export type VerifyResult =
  | { code: string; status: 'not_found' }
  | {
      code: string
      status: 'ok'
      question: { id: string; title: string | null; text: string; type: string; order: number }
      class: { id: string; name: string }
      session: { id: string; title: string; status: string; isLive: boolean } | null
      assignment: { id: string; title: string; status: string } | null
    }

export interface RebindMapping {
  fromCode: string
  fromQuestion: { id: string; title: string | null; text: string }
  sessionTitle: string
  to: { questionId: string; currentCode: string; title: string | null; text: string } | null
  reason?: string
}

// ─── Calls ────────────────────────────────────────────────────────────────────

export const listClasses = () =>
  get<{ classes: ClassSummary[] }>('/classes').then((d) => d.classes)

export const listSessions = (classId: string) =>
  get<{ sessions: SessionSummary[] }>(`/classes/${classId}/sessions`).then((d) => d.sessions)

export const getSession = (sessionId: string) =>
  get<{ session: { id: string; title: string; questions: QuestionSummary[] } }>(
    `/sessions/${sessionId}`
  ).then((d) => d.session)

export const verifyCodes = (codes: string[]) =>
  post<{ results: VerifyResult[] }>('/addin/verify', { codes }).then((d) => d.results)

export const adoptCode = (questionId: string, code: string) =>
  post<{ changed: boolean; accessCode: string }>('/addin/adopt-code', { questionId, code })

export const getQuestionQr = (questionId: string) =>
  get<{ accessCode: string; qrDataUrl: string }>(`/addin/questions/${questionId}/qr`)

export const proposeRebind = (fromClassId: string, toClassId: string) =>
  post<{
    from: { id: string; name: string }
    to: { id: string; name: string }
    mappings: RebindMapping[]
    matched: number
    unmatched: number
  }>('/addin/rebind', { fromClassId, toClassId })
