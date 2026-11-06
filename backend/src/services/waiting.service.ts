/**
 * Students who scanned a session's code before it was open — "the room is waiting".
 *
 * The usual way a lecture goes wrong at the start is the professor forgetting to open the
 * session. Students scan, are told "not open yet", and nothing on the slide says so. But a
 * scan already names the session (every code belongs to one question, every question to
 * one session) and the student's enrollment names their section. So the refusal is the
 * signal: it is remembered here, and the Live Results object offers a one-tap start.
 *
 * It only ever suggests. Nothing here opens a run; the professor picks the section.
 *
 * Deliberately in memory, like clock.service.ts. A waiting student is only interesting for
 * a few minutes, and after a restart the student page retries and puts them back.
 * Single-process only, for the same reason as the clocks.
 */

/** A student is forgotten this long after their last refused scan. */
export const WAITING_TTL_MS = 10 * 60 * 1000

interface Waiter {
  /** Their enrollment's section in that class, or null when they have none on record. */
  sectionId: string | null
  at: number
}

// sessionId → studentId → waiter. One entry per student per session, so rescanning
// refreshes them rather than counting them twice.
const waiting = new Map<string, Map<string, Waiter>>()

function prune(now: number) {
  for (const [sessionId, students] of waiting) {
    for (const [studentId, w] of students) {
      if (now - w.at > WAITING_TTL_MS) students.delete(studentId)
    }
    if (students.size === 0) waiting.delete(sessionId)
  }
}

/** A student scanned a code for this session and no run would take them. */
export function noteWaiting(sessionId: string, sectionId: string | null, studentId: string, now = Date.now()) {
  prune(now)
  let students = waiting.get(sessionId)
  if (!students) waiting.set(sessionId, (students = new Map()))
  students.set(studentId, { sectionId, at: now })
}

/** A student got in somewhere, so they are no longer waiting for anything. */
export function noteAdmitted(studentId: string) {
  for (const [sessionId, students] of waiting) {
    students.delete(studentId)
    if (students.size === 0) waiting.delete(sessionId)
  }
}

/**
 * A run opened. Everyone it now admits stops waiting: its own section, and students with
 * no section on record (who are admitted by any run). A run for the whole class admits all.
 */
export function noteOpened(sessionId: string, sectionId: string | null) {
  const students = waiting.get(sessionId)
  if (!students) return
  for (const [studentId, w] of students) {
    if (sectionId === null || w.sectionId === null || w.sectionId === sectionId) students.delete(studentId)
  }
  if (students.size === 0) waiting.delete(sessionId)
}

export interface WaitingSession {
  sessionId: string
  total: number
  /** Waiting students per section id; null collects those with no section on record. */
  bySection: Map<string | null, number>
  lastAt: number
}

/** Everyone currently waiting, busiest session first. Counts only — never who. */
export function waitingSnapshot(now = Date.now()): WaitingSession[] {
  prune(now)
  const out: WaitingSession[] = []
  for (const [sessionId, students] of waiting) {
    const bySection = new Map<string | null, number>()
    let lastAt = 0
    for (const w of students.values()) {
      bySection.set(w.sectionId, (bySection.get(w.sectionId) ?? 0) + 1)
      if (w.at > lastAt) lastAt = w.at
    }
    out.push({ sessionId, total: students.size, bySection, lastAt })
  }
  return out.sort((a, b) => b.total - a.total || b.lastAt - a.lastAt)
}

/** Tests only. */
export function resetWaiting() {
  waiting.clear()
}
