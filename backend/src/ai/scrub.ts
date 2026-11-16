/**
 * Identifying details taken out of student answer text before it goes to a model.
 *
 * The model is sent answers by index, never with who wrote them, but a student can still
 * type identifying things into an answer: their own NetID, a classmate's email, an ID number.
 * This replaces those with placeholders in the copy sent to the model. The stored answer is
 * never changed, and results come back by index, so nothing downstream sees the difference.
 *
 * Pulse stores no student names. A name is recognised only where an email address spells it
 * out (first.last@...), and then only as the full name, both parts together: a lone first or
 * last name is too likely to be chemistry (a student surnamed Krebs, or Michaelis) to remove.
 *
 * Images (the quiz grader's answer crops) cannot be scrubbed this way. They are covered by
 * the reader's own guard: name and NetID boxes are never sent.
 */
import { prisma } from '../db/index.js'

export type Scrub = (text: string) => string

export interface Person {
  netId: string
  email: string
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
// A RUID is nine digits. Answers in this course have no reason to contain one.
const RUID = /(?<![\d.])\d{9}(?![\d.])/g
const PHONE = /(?<!\d)(?:\(\d{3}\)\s?|\d{3}[-.\s])\d{3}[-.\s]\d{4}(?!\d)/g

/**
 * A NetID worth matching: letters then digits, as Rutgers issues them. Anything else (a
 * test account called "admin") could be an ordinary word, and replacing it would change
 * what the answer says.
 */
const looksLikeNetId = (s: string) => /^[a-z]+\d+[a-z]?$/i.test(s) && s.length >= 3

/** "jane.doe" or "jane_doe" → ["jane", "doe"]; anything else, null. */
function nameFromEmail(email: string): [string, string] | null {
  const local = email.split('@')[0] ?? ''
  const m = /^([a-z]{2,})[._]([a-z]{2,})$/i.exec(local)
  return m ? [m[1]!, m[2]!] : null
}

export function makeScrubber(people: Person[]): Scrub {
  const netIds = [...new Set(people.map((p) => p.netId.trim()).filter(looksLikeNetId))]
  const names: string[] = []
  for (const p of people) {
    const n = nameFromEmail(p.email)
    if (!n) continue
    const [a, b] = n.map(escape) as [string, string]
    // "Jane Doe", "Doe, Jane", "Doe Jane", "jane.doe"
    names.push(`${a}[\\s._]+${b}`, `${b},?\\s+${a}`)
  }
  // Longest first, so a NetID that contains another is replaced whole.
  netIds.sort((x, y) => y.length - x.length)
  const netIdRe = netIds.length ? new RegExp(`\\b(?:${netIds.map(escape).join('|')})\\b`, 'gi') : null
  const nameRe = names.length ? new RegExp(`\\b(?:${names.join('|')})\\b`, 'gi') : null

  return (text) => {
    // Emails first: a NetID inside an address is removed with the address.
    let out = text.replace(EMAIL, '[email]')
    if (nameRe) out = out.replace(nameRe, '[name]')
    if (netIdRe) out = out.replace(netIdRe, '[netid]')
    return out.replace(RUID, '[id number]').replace(PHONE, '[phone]')
  }
}

const cache = new Map<string, { at: number; scrub: Scrub }>()
const CACHE_MS = 60_000

/**
 * A scrubber for one question's answers: everyone enrolled in its class, plus anyone who
 * has answered it (a student removed from the roster keeps their answers). Cached briefly,
 * since live themes classifies a question's answers every few seconds during class.
 */
export async function scrubberForQuestion(questionId: string): Promise<Scrub> {
  const hit = cache.get(questionId)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.scrub

  const q = await prisma.question.findUnique({
    where: { id: questionId },
    select: { session: { select: { classId: true } }, assignment: { select: { classId: true } } },
  })
  const classId = q?.session?.classId ?? q?.assignment?.classId
  const people = await prisma.student.findMany({
    where: {
      OR: [
        ...(classId ? [{ enrollments: { some: { classId } } }] : []),
        { responses: { some: { questionId } } },
      ],
    },
    select: { netId: true, email: true },
  })
  const scrub = makeScrubber(people)
  cache.set(questionId, { at: Date.now(), scrub })
  return scrub
}
