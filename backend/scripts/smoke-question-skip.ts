/**
 * Smoke test for skipping a question — the one cut for time while its QR code stayed
 * in the deck.
 *
 * A few students answer it anyway. Before skipping existed, those strays made the
 * question count as presented, so everyone who did as told took a zero on it, it sat
 * in the list as work to grade, and the strays read as participation. What needs
 * proving is that a skip undoes all of that everywhere a grade or a count is shown,
 * that it refuses new answers, that it survives a close-and-reopen, and that unskipping
 * puts everything back.
 *
 * It also pins the fix that came with it: every grade path now asks one helper whether
 * a question was put to a student's section. The gradebook used to count any answer in
 * the class once the section had run the session at all, so a question asked only in
 * section B was a zero for section A there but not on the session page.
 *
 * Two classes. "One" mirrors a class taught as one Pulse section across two lectures.
 * "Split" has sections A and B, with a question asked only in B.
 *
 * Usage:
 *   E2E_BASE=http://localhost:3010 npx tsx scripts/smoke-question-skip.ts
 *
 * Requires a server pointed at the same database this script connects to, and
 * cleans up everything it creates.
 */

import 'dotenv/config'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { prisma } from '../src/db/index.js'
import { config } from '../src/config/index.js'

const BASE = process.env.E2E_BASE ?? 'http://localhost:3001'
const RUN_ID = Date.now().toString(36)
const TAG = `smoke-skip-${RUN_ID}`

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++
    console.log(`  PASS  ${name}`)
  } else {
    failed++
    failures.push(name + (detail ? ` — ${detail}` : ''))
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title: string) {
  console.log(`\n=== ${title} ===`)
}

const tokenFor = (id: string, role: 'professor' | 'student') =>
  jwt.sign({ sub: id, role }, config.jwtSecret, { expiresIn: '1h' })

async function call(
  method: string,
  path: string,
  token: string | null,
  body?: unknown
): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* CSV */ }
  return { status: res.status, json, text }
}

async function freeQuestionCode(): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const c = String(Math.floor(Math.random() * 10000)).padStart(4, '0')
    if (!(await prisma.question.findUnique({ where: { accessCode: c } }))) return c
  }
  throw new Error('No free access code available — the 4-digit namespace may be full')
}

const suffix = RUN_ID.slice(-4).toUpperCase().replace(/[IO01]/g, 'X')

// ─── Fixture ──────────────────────────────────────────────────────────────────

async function createFixture() {
  const hash = await bcrypt.hash(`pw-${RUN_ID}-x`, 4)
  const prof = await prisma.professor.create({
    data: { email: `${TAG}@example.invalid`, name: `Smoke Skip Prof ${RUN_ID}`, passwordHash: hash },
  })
  const other = await prisma.professor.create({
    data: { email: `${TAG}-other@example.invalid`, name: `Smoke Skip Other ${RUN_ID}`, passwordHash: hash },
  })
  const student = (n: string) => prisma.student.create({
    data: { netId: `sk${n}${RUN_ID.slice(-5)}`, email: `${TAG}-${n}@example.invalid`, passwordHash: hash },
  })

  // "One": a single Pulse section, the way a class gets set up when two real
  // lectures share it.
  const one = await prisma.class.create({
    data: { professorId: prof.id, name: `Smoke Skip One ${RUN_ID}`, joinCode: `K1${suffix}` },
  })
  const S = await prisma.section.create({ data: { classId: one.id, name: 'S', joinCode: `KS${suffix}` } })
  const s = [await student('s1'), await student('s2'), await student('s3'), await student('s4')]
  for (const st of s) {
    await prisma.enrollment.create({ data: { studentId: st.id, classId: one.id, sectionId: S.id } })
  }
  const oneSess = await prisma.session.create({
    data: { classId: one.id, title: `Smoke Skip One ${RUN_ID}`, accessCode: await freeQuestionCode() },
  })
  const q1 = await prisma.question.create({
    data: { sessionId: oneSess.id, text: 'Asked', type: 'MULTIPLE_CHOICE', options: ['A', 'B'], correctAnswer: 'B', order: 0, accessCode: await freeQuestionCode() },
  })
  const q2 = await prisma.question.create({
    data: { sessionId: oneSess.id, text: 'Cut for time', type: 'MULTIPLE_CHOICE', options: ['A', 'B'], correctAnswer: 'B', order: 1, accessCode: await freeQuestionCode() },
  })

  // "Split": sections A and B, properly set up.
  const split = await prisma.class.create({
    data: { professorId: prof.id, name: `Smoke Skip Split ${RUN_ID}`, joinCode: `K2${suffix}` },
  })
  const A = await prisma.section.create({ data: { classId: split.id, name: 'A', joinCode: `KA${suffix}` } })
  const B = await prisma.section.create({ data: { classId: split.id, name: 'B', joinCode: `KB${suffix}` } })
  const a = [await student('a1'), await student('a2')]
  const b = [await student('b1'), await student('b2')]
  for (const st of a) await prisma.enrollment.create({ data: { studentId: st.id, classId: split.id, sectionId: A.id } })
  for (const st of b) await prisma.enrollment.create({ data: { studentId: st.id, classId: split.id, sectionId: B.id } })
  const splitSess = await prisma.session.create({
    data: { classId: split.id, title: `Smoke Skip Split ${RUN_ID}`, accessCode: await freeQuestionCode() },
  })
  const p1 = await prisma.question.create({
    data: { sessionId: splitSess.id, text: 'Asked in both', type: 'MULTIPLE_CHOICE', options: ['A', 'B'], correctAnswer: 'B', order: 0, accessCode: await freeQuestionCode() },
  })
  const p2 = await prisma.question.create({
    data: { sessionId: splitSess.id, text: 'Asked only in B', type: 'MULTIPLE_CHOICE', options: ['A', 'B'], correctAnswer: 'B', order: 1, accessCode: await freeQuestionCode() },
  })

  return { prof, other, one, S, s, oneSess, q1, q2, split, A, B, a, b, splitSess, p1, p2 }
}

async function cleanup() {
  await prisma.response.deleteMany({ where: { student: { email: { startsWith: TAG } } } })
  await prisma.enrollment.deleteMany({ where: { student: { email: { startsWith: TAG } } } })
  await prisma.student.deleteMany({ where: { email: { startsWith: TAG } } })
  await prisma.class.deleteMany({ where: { professor: { email: { startsWith: TAG } } } })
  await prisma.professor.deleteMany({ where: { email: { startsWith: TAG } } })
}

// ─── Readers ──────────────────────────────────────────────────────────────────

type F = Awaited<ReturnType<typeof createFixture>>

/** One student's [earned, max] for one session, from every place a grade is shown. */
async function gradesEverywhere(f: F, profToken: string, classId: string, sessionId: string, st: { id: string; netId: string }) {
  const sToken = tokenFor(st.id, 'student')
  const book = await call('GET', `/api/classes/${classId}/grades/json`, profToken)
  const row = book.json?.data?.students?.find((r: any) => r.studentId === st.id)
  const cell = row?.scores?.find((c: any) => c.sessionId === sessionId)

  const csv = await call('GET', `/api/classes/${classId}/grades`, profToken)
  const csvRow = csv.text.split('\n').find((l) => l.startsWith(st.netId + ','))?.split(',') ?? []
  // NetID, Section, <session>, Participation Total, Participation Max, ...
  const csvCell = [Number(csvRow[2]), Number(csvRow[4])]

  const sessCsv = await call('GET', `/api/sessions/${sessionId}/export`, profToken)
  const sessRow = sessCsv.text.split('\n').find((l) => l.startsWith(st.netId + ','))?.split(',') ?? []
  const sessCounted = sessRow.slice(1, -2).filter((v) => v !== '—').length

  const mine = await call('GET', `/api/student/classes/${classId}/grades`, sToken)
  const mineCell = mine.json?.data?.sessions?.find((x: any) => x.id === sessionId)

  const detail = await call('GET', `/api/student/sessions/${sessionId}/grades`, sToken)

  const activity = await call('GET', `/api/classes/${classId}/students/${st.id}/activity`, profToken)
  const act = activity.json?.data?.sessions?.find((x: any) => x.id === sessionId)
  const actCounted = act?.questions?.filter((q: any) => q.counted).length ?? -1

  return {
    gradebook: [cell?.earned, cell?.max],
    classCsv: csvCell,
    sessionCsvCounted: sessCounted,
    studentList: [mineCell?.earned, mineCell?.max],
    studentDetail: [detail.json?.data?.session?.earned, detail.json?.data?.session?.max],
    activityCounted: actCounted,
  }
}

function agree(label: string, g: Awaited<ReturnType<typeof gradesEverywhere>>, earned: number, max: number) {
  const want = JSON.stringify([earned, max])
  check(`${label}: gradebook ${want}`, JSON.stringify(g.gradebook) === want, JSON.stringify(g.gradebook))
  check(`${label}: class CSV ${want}`, JSON.stringify(g.classCsv) === want, JSON.stringify(g.classCsv))
  check(`${label}: session CSV counts ${max}`, g.sessionCsvCounted === max, String(g.sessionCsvCounted))
  check(`${label}: student's grade list ${want}`, JSON.stringify(g.studentList) === want, JSON.stringify(g.studentList))
  check(`${label}: student's session page ${want}`, JSON.stringify(g.studentDetail) === want, JSON.stringify(g.studentDetail))
  check(`${label}: professor's student report counts ${max}`, g.activityCounted === max, String(g.activityCounted))
}

// ─── Run ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Smoke: question skip  (${BASE})`)
  const f = await createFixture()
  const prof = tokenFor(f.prof.id, 'professor')
  const other = tokenFor(f.other.id, 'professor')
  const st = (x: { id: string }) => tokenFor(x.id, 'student')
  const answer = (x: { id: string }, questionId: string, responseText = 'B') =>
    call('POST', '/api/responses', st(x), { questionId, responseText })
  const skip = (questionId: string, sessionId: string, sectionId: string | null, skipped: boolean, token = prof) =>
    call('PUT', `/api/sessions/${sessionId}/questions/${questionId}/skip`, token, { sectionId, skipped })

  try {
    section('1. One section: a lecture where Q2 got cut')

    const run1 = await call('POST', `/api/sessions/${f.oneSess.id}/runs`, prof, { sectionId: f.S.id })
    check('the run opens', run1.status === 201 || run1.status === 200, `status ${run1.status} ${run1.text.slice(0, 120)}`)
    const runId = run1.json?.data?.run?.id ?? (await prisma.sessionRun.findFirst({ where: { sessionId: f.oneSess.id, status: 'OPEN' } }))?.id

    for (const x of f.s.slice(0, 3)) {
      const r = await answer(x, f.q1.id)
      check(`${x.netId} answers Q1`, r.status === 201, `status ${r.status}`)
    }
    // s4 answers only the question the room was told to ignore.
    const stray = await answer(f.s[3], f.q2.id)
    check('a stray answer to Q2 lands before the skip', stray.status === 201, `status ${stray.status}`)

    await call('PATCH', `/api/sessions/${f.oneSess.id}/runs/${runId}`, prof, { status: 'CLOSED' })

    section('2. Before skipping, the stray costs everyone')
    agree('s1 (did as told)', await gradesEverywhere(f, prof, f.one.id, f.oneSess.id, f.s[0]), 1, 2)
    agree('s4 (the stray)', await gradesEverywhere(f, prof, f.one.id, f.oneSess.id, f.s[3]), 1, 2)

    section('3. The skip route guards itself')
    const foreign = await skip(f.q2.id, f.oneSess.id, f.A.id, true)
    check('a section from another class is refused', foreign.status === 404, `status ${foreign.status}`)
    const notMine = await skip(f.q2.id, f.oneSess.id, f.S.id, true, other)
    check("another professor's question is refused", notMine.status === 404, `status ${notMine.status}`)

    section('4. Skip Q2')
    const sk = await skip(f.q2.id, f.oneSess.id, f.S.id, true)
    check('skip succeeds', sk.status === 200, `status ${sk.status} ${sk.text.slice(0, 120)}`)
    const twice = await skip(f.q2.id, f.oneSess.id, f.S.id, true)
    check('skipping twice is not an error', twice.status === 200, `status ${twice.status}`)
    const rows = await prisma.questionSkip.count({ where: { questionId: f.q2.id } })
    check('and leaves one row, not two', rows === 1, String(rows))

    const detail = await call('GET', `/api/sessions/${f.oneSess.id}`, prof)
    const q2Detail = detail.json?.data?.session?.questions?.find((q: any) => q.id === f.q2.id)
    check('the session page receives the skip', JSON.stringify(q2Detail?.skips) === JSON.stringify([{ sectionId: f.S.id }]), JSON.stringify(q2Detail?.skips))
    check('and still has the stray answer to show', q2Detail?.responses?.length === 1)

    agree('s1 after skip', await gradesEverywhere(f, prof, f.one.id, f.oneSess.id, f.s[0]), 1, 1)
    agree('s4 after skip', await gradesEverywhere(f, prof, f.one.id, f.oneSess.id, f.s[3]), 0, 1)

    const roster = await call('GET', `/api/classes/${f.one.id}/enrollments`, prof)
    const s4Stats = roster.json?.data?.enrollments?.find((e: any) => e.student.id === f.s[3].id)?.stats
    check('roster: the stray is not a response', s4Stats?.totalResponses === 0, JSON.stringify(s4Stats))
    check('roster: nor a session participated in', s4Stats?.sessionsParticipated === 0, JSON.stringify(s4Stats))

    const list = await call('GET', `/api/classes/${f.one.id}/sessions`, prof)
    const listed = list.json?.data?.sessions?.find((x: any) => x.id === f.oneSess.id)
    check('session list: 3 respondents, not 4', listed?.respondentCount === 3, String(listed?.respondentCount))

    const classes = await call('GET', '/api/classes', prof)
    const card = (classes.json?.data?.classes ?? []).find((c: any) => c.id === f.one.id)
    check('class card: participation 3 of 4', card?.participationRate === 0.75, String(card?.participationRate))

    section('5. A reopen of the same section stays skipped')
    const run2 = await call('POST', `/api/sessions/${f.oneSess.id}/runs`, prof, { sectionId: f.S.id })
    check('second lecture opens', run2.status === 201 || run2.status === 200, `status ${run2.status}`)
    const refused = await answer(f.s[1], f.q2.id)
    check('a new answer to Q2 is refused', refused.status === 409 && refused.json?.code === 'QUESTION_SKIPPED',
      `status ${refused.status} ${refused.text.slice(0, 120)}`)
    const byCode = await call('GET', `/api/questions/by-code/${f.q2.accessCode}`, st(f.s[1]))
    check('so is looking it up by code', byCode.status === 409, `status ${byCode.status}`)
    const page = await call('GET', `/api/student/questions/${f.q2.id}`, st(f.s[1]))
    check('so is opening it from the QR', page.status === 409, `status ${page.status}`)
    check('and the refusal says why', /skipped/i.test(page.json?.error ?? ''), page.json?.error)
    const fine = await answer(f.s[3], f.q1.id)
    check('Q1 still takes answers', fine.status === 201, `status ${fine.status}`)
    const run2Id = (await prisma.sessionRun.findFirst({ where: { sessionId: f.oneSess.id, status: 'OPEN' } }))!.id
    await call('PATCH', `/api/sessions/${f.oneSess.id}/runs/${run2Id}`, prof, { status: 'CLOSED' })

    section('6. Unskip puts everything back')
    const un = await skip(f.q2.id, f.oneSess.id, f.S.id, false)
    check('unskip succeeds', un.status === 200 && JSON.stringify(un.json?.data?.skips) === '[]', un.text.slice(0, 120))
    agree('s1 after unskip', await gradesEverywhere(f, prof, f.one.id, f.oneSess.id, f.s[0]), 1, 2)
    // s4 now has Q1 from lecture two and the restored stray on Q2.
    agree('s4 after unskip', await gradesEverywhere(f, prof, f.one.id, f.oneSess.id, f.s[3]), 2, 2)

    section('7. Split class: a question asked only in B')
    const ra = await call('POST', `/api/sessions/${f.splitSess.id}/runs`, prof, { sectionId: f.A.id })
    const raId = ra.json?.data?.run?.id ?? (await prisma.sessionRun.findFirst({ where: { sessionId: f.splitSess.id, status: 'OPEN' } }))!.id
    check('A answers P1', (await answer(f.a[0], f.p1.id)).status === 201)
    await call('PATCH', `/api/sessions/${f.splitSess.id}/runs/${raId}`, prof, { status: 'CLOSED' })
    const rb = await call('POST', `/api/sessions/${f.splitSess.id}/runs`, prof, { sectionId: f.B.id })
    const rbId = rb.json?.data?.run?.id ?? (await prisma.sessionRun.findFirst({ where: { sessionId: f.splitSess.id, status: 'OPEN' } }))!.id
    check('B answers P1', (await answer(f.b[0], f.p1.id)).status === 201)
    check('B answers P2', (await answer(f.b[0], f.p2.id)).status === 201)
    await call('PATCH', `/api/sessions/${f.splitSess.id}/runs/${rbId}`, prof, { status: 'CLOSED' })

    // a2 was absent from A; P2 was never put to A, so it is not in a2's max anywhere.
    agree('a2 (section A)', await gradesEverywhere(f, prof, f.split.id, f.splitSess.id, f.a[1]), 0, 1)
    agree('b2 (section B)', await gradesEverywhere(f, prof, f.split.id, f.splitSess.id, f.b[1]), 0, 2)

    section('8. Split class: skipping in A leaves B alone')
    const skA = await skip(f.p1.id, f.splitSess.id, f.A.id, true)
    check('skip P1 for A', skA.status === 200, `status ${skA.status}`)
    agree('a1 (answered, then skipped)', await gradesEverywhere(f, prof, f.split.id, f.splitSess.id, f.a[0]), 0, 0)
    agree('b1 (B unaffected)', await gradesEverywhere(f, prof, f.split.id, f.splitSess.id, f.b[0]), 2, 2)
  } finally {
    await cleanup()
  }

  const leftover = await prisma.professor.count({ where: { email: { startsWith: TAG } } })
  check('cleanup left nothing behind', leftover === 0, String(leftover))

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log('\nFailures:')
    for (const x of failures) console.log(`  - ${x}`)
    process.exitCode = 1
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
