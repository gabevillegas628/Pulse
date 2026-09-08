/**
 * Smoke test for joining a class by code — the straggler's door.
 *
 * Everyone else is enrolled as a side effect of answering, which needs a
 * professor to be showing a code. A student who made an account at home has no
 * code to scan, and until this route was wired up had no way into a class at
 * all. What needs proving is that the door opens for them, that it refuses the
 * one code that would let them in and then strand them, and that a professor
 * can undo a join without destroying anything.
 *
 * The stranding case is the reason this file exists. Every open-run check reads
 * `sectionId === null || sectionId === mine`, so a student who joins a sectioned
 * class by its class-wide code lands unassigned and is refused by every
 * section-targeted run — enrolled, listed on the roster, and unable to answer.
 * The server rejects that code rather than hand out the disappointment later.
 *
 * Two classes: one plain, one split into sections. One student walks both doors.
 *
 * Usage:
 *   npx tsx scripts/smoke-join.ts
 *   E2E_BASE=http://localhost:3010 npx tsx scripts/smoke-join.ts
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
const TAG = `smoke-join-${RUN_ID}`

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
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

async function freeQuestionCode(): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const c = String(Math.floor(Math.random() * 10000)).padStart(4, '0')
    if (!(await prisma.question.findUnique({ where: { accessCode: c } }))) return c
  }
  throw new Error('No free access code available — the 4-digit namespace may be full')
}

// Join codes are uppercase, six characters, no I/O/0/1. The fixture codes have to
// live in the same namespace the route looks up, and be unique across the run.
const suffix = RUN_ID.slice(-4).toUpperCase().replace(/[IO01]/g, 'X')
const PLAIN_CODE = `JP${suffix}`
const SECTIONED_CODE = `JS${suffix}`
const SECTION_A_CODE = `SA${suffix}`

// ─── Fixture ──────────────────────────────────────────────────────────────────

async function createFixture() {
  const hash = await bcrypt.hash(`pw-${RUN_ID}-x`, 4)

  const prof = await prisma.professor.create({
    data: { email: `${TAG}@example.invalid`, name: `Smoke Join Prof ${RUN_ID}`, passwordHash: hash },
  })
  const other = await prisma.professor.create({
    data: { email: `${TAG}-other@example.invalid`, name: `Smoke Join Other ${RUN_ID}`, passwordHash: hash },
  })
  const student = await prisma.student.create({
    data: {
      netId: `sj${RUN_ID.slice(-6)}`,
      email: `${TAG}-student@example.invalid`,
      passwordHash: hash,
    },
  })

  const plain = await prisma.class.create({
    data: { professorId: prof.id, name: `Smoke Join Plain ${RUN_ID}`, joinCode: PLAIN_CODE },
  })
  const sectioned = await prisma.class.create({
    data: { professorId: prof.id, name: `Smoke Join Sectioned ${RUN_ID}`, joinCode: SECTIONED_CODE },
  })
  const sectionA = await prisma.section.create({
    data: { classId: sectioned.id, name: '001', joinCode: SECTION_A_CODE },
  })

  // A question in the plain class, so the removal test has a response to preserve.
  const sess = await prisma.session.create({
    data: { classId: plain.id, title: `Smoke Join Session ${RUN_ID}`, accessCode: await freeQuestionCode(), status: 'OPEN' },
  })
  const question = await prisma.question.create({
    data: { sessionId: sess.id, text: 'Does the door open?', type: 'FREE_TEXT', order: 1, accessCode: await freeQuestionCode() },
  })

  return { prof, other, student, plain, sectioned, sectionA, sess, question }
}

async function cleanup() {
  await prisma.response.deleteMany({ where: { student: { email: `${TAG}-student@example.invalid` } } })
  await prisma.enrollment.deleteMany({ where: { student: { email: `${TAG}-student@example.invalid` } } })
  await prisma.student.deleteMany({ where: { email: `${TAG}-student@example.invalid` } })
  await prisma.class.deleteMany({ where: { professor: { email: { startsWith: TAG } } } })
  await prisma.professor.deleteMany({ where: { email: { startsWith: TAG } } })
}

// ─── Run ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Smoke: join by code  (${BASE})`)
  const f = await createFixture()
  const studentToken = tokenFor(f.student.id, 'student')
  const profToken = tokenFor(f.prof.id, 'professor')
  const otherToken = tokenFor(f.other.id, 'professor')

  try {
    section('1. A class with no sections')

    const bad = await call('POST', '/api/student/enroll', studentToken, { joinCode: 'ZZZZZZ' })
    check('unknown code is refused', bad.status === 404, `status ${bad.status}`)

    const joined = await call('POST', '/api/student/enroll', studentToken, { joinCode: PLAIN_CODE })
    check('class code enrolls the student', joined.status === 200, `status ${joined.status}`)
    check(
      'the response names the class',
      joined.json?.data?.enrollment?.class?.name === f.plain.name,
      JSON.stringify(joined.json?.data?.enrollment?.class ?? null)
    )

    const enrollment = await prisma.enrollment.findUnique({
      where: { studentId_classId: { studentId: f.student.id, classId: f.plain.id } },
    })
    check('the enrolment exists', !!enrollment)

    const again = await call('POST', '/api/student/enroll', studentToken, { joinCode: PLAIN_CODE })
    check('joining twice is not an error', again.status === 200, `status ${again.status}`)

    section('2. What the student actually types')

    // The code is read off a slide or pasted from an announcement. Neither of these
    // is a different code, and neither should be a "not found".
    const messy = await call('POST', '/api/student/enroll', studentToken, {
      joinCode: `  ${PLAIN_CODE.toLowerCase()}  `,
    })
    check('lowercase and surrounding space still match', messy.status === 200, `status ${messy.status}`)

    section('3. A class split into sections')

    const strand = await call('POST', '/api/student/enroll', studentToken, { joinCode: SECTIONED_CODE })
    check('the class-wide code is refused', strand.status === 409, `status ${strand.status}`)
    check(
      'the refusal says to ask for the section code',
      typeof strand.json?.error === 'string' && /section/i.test(strand.json.error),
      strand.json?.error
    )
    const stranded = await prisma.enrollment.findUnique({
      where: { studentId_classId: { studentId: f.student.id, classId: f.sectioned.id } },
    })
    check('and no enrolment was created', stranded === null)

    const bySection = await call('POST', '/api/student/enroll', studentToken, { joinCode: SECTION_A_CODE })
    check('the section code enrolls the student', bySection.status === 200, `status ${bySection.status}`)
    const assigned = await prisma.enrollment.findUnique({
      where: { studentId_classId: { studentId: f.student.id, classId: f.sectioned.id } },
    })
    check(
      'and assigns the section, which is the whole point',
      assigned?.sectionId === f.sectionA.id,
      `sectionId ${assigned?.sectionId ?? 'null'}`
    )

    section('4. The way back out')

    // An answer, so removal has something it could destroy and must not.
    await prisma.sessionRun.create({ data: { sessionId: f.sess.id, status: 'OPEN' } })
    const run = await prisma.sessionRun.findFirst({ where: { sessionId: f.sess.id } })
    await prisma.response.create({
      data: {
        questionId: f.question.id,
        studentId: f.student.id,
        runId: run!.id,
        responseText: 'yes',
        wordCount: 1,
        isDraft: false,
      },
    })

    const notMine = await call('DELETE', `/api/classes/${f.plain.id}/enrollments/${f.student.id}`, otherToken)
    check("another professor's class is not theirs to edit", notMine.status === 404, `status ${notMine.status}`)

    const removed = await call('DELETE', `/api/classes/${f.plain.id}/enrollments/${f.student.id}`, profToken)
    check('the professor can remove the student', removed.status === 200, `status ${removed.status}`)
    const gone = await prisma.enrollment.findUnique({
      where: { studentId_classId: { studentId: f.student.id, classId: f.plain.id } },
    })
    check('the enrolment is gone', gone === null)

    const answer = await prisma.response.findUnique({
      where: { questionId_studentId: { questionId: f.question.id, studentId: f.student.id } },
    })
    check('the answer is kept', !!answer, 'a mistaken removal must not cost a semester')

    const twice = await call('DELETE', `/api/classes/${f.plain.id}/enrollments/${f.student.id}`, profToken)
    check('removing again says so rather than pretending', twice.status === 404, `status ${twice.status}`)

    const rejoined = await call('POST', '/api/student/enroll', studentToken, { joinCode: PLAIN_CODE })
    check('the student can rejoin', rejoined.status === 200, `status ${rejoined.status}`)
    const history = await prisma.response.findUnique({
      where: { questionId_studentId: { questionId: f.question.id, studentId: f.student.id } },
    })
    check('and their history is waiting for them', !!history)
  } finally {
    await cleanup()
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failures.length) {
    console.log('\nFailures:')
    for (const f of failures) console.log(`  - ${f}`)
  }
  await prisma.$disconnect()
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(async (err) => {
  console.error(err)
  await cleanup().catch(() => {})
  await prisma.$disconnect()
  process.exit(1)
})
