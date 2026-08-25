/**
 * Smoke test for live AI themes (phase 1: bootstrap + persistence).
 *
 * The point of this script is that it needs no real students and no clicking. It
 * fabricates a class of 13 answers whose grouping is known in advance, runs the real
 * summarize route over HTTP, and checks both the shape of what comes back and whether
 * the clustering actually makes sense.
 *
 * The answers are built as three genuinely distinct framings of one question —
 * entropy, heat transfer, phase stability — plus two junk answers. That lets the test
 * assert semantics, not just that some JSON parsed: the entropy answers should end up
 * together, and "idk" should land in Forming rather than distorting a real category.
 *
 * Costs one Opus 5 call (~$0.01) and writes to whatever DATABASE_URL points at,
 * deleting everything it created afterwards.
 *
 * Usage:
 *   npm run test:smoke:themes            # against http://localhost:3001
 *   E2E_BASE=http://localhost:3010 npm run test:smoke:themes
 *
 * Requires a running server pointed at the same database this script connects to.
 */

import 'dotenv/config'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { prisma } from '../src/db/index.js'
import { config } from '../src/config/index.js'

const BASE = process.env.E2E_BASE ?? 'http://localhost:3001'
const RUN_ID = Date.now().toString(36)
const TAG = `smoke-${RUN_ID}`

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

interface Res<T> { status: number; body: T }

async function http<T = any>(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {}
): Promise<Res<T>> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  })
  const body = await res.json().catch(() => null)
  return { status: res.status, body: body as T }
}

const tokenFor = (id: string, role: 'professor' | 'student') =>
  jwt.sign({ sub: id, role }, config.jwtSecret, { expiresIn: '1h' })

async function freeCode(): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const c = String(Math.floor(Math.random() * 10000)).padStart(4, '0')
    if (!(await prisma.question.findUnique({ where: { accessCode: c } }))) return c
  }
  throw new Error('No free access code available — the 4-digit namespace may be full')
}

// ─── The fabricated class ─────────────────────────────────────────────────────

const QUESTION_TEXT = 'Why does an ice cube melt when you leave it out at room temperature?'

/**
 * Three coherent groups and two junk answers. `group` is what the test expects to hold
 * together — it is never sent to the model, only used to score the result.
 */
const ANSWERS: Array<{ group: 'entropy' | 'heat' | 'phase' | 'junk'; text: string }> = [
  { group: 'entropy', text: 'The entropy of liquid water is higher than ice, so melting increases the disorder of the system.' },
  { group: 'entropy', text: 'Melting is entropically favourable — the molecules gain a lot more freedom of motion in the liquid phase.' },
  { group: 'entropy', text: 'Because the increase in entropy outweighs the enthalpy cost once you are above the melting point.' },
  { group: 'entropy', text: 'Disorder increases when the rigid crystal lattice breaks apart, and that entropy change drives the process.' },

  { group: 'heat', text: 'Heat flows from the warm room into the ice because there is a temperature difference between them.' },
  { group: 'heat', text: 'The surroundings transfer thermal energy into the ice until it has enough to undergo the phase change.' },
  { group: 'heat', text: 'Energy moves from the warmer air into the colder ice, and that supplies the latent heat of fusion.' },
  { group: 'heat', text: 'The room is warmer than the cube, so heat is conducted into the ice through its surface.' },

  { group: 'phase', text: 'Room temperature is above zero degrees Celsius, which is the melting point of water ice.' },
  { group: 'phase', text: 'Ice is only the stable phase below its freezing point, and a room is much warmer than that.' },
  { group: 'phase', text: 'Because twenty degrees is higher than zero degrees so the solid phase is no longer stable.' },

  { group: 'junk', text: 'idk' },
  { group: 'junk', text: 'asdf' },
]

async function createFixture() {
  const hash = await bcrypt.hash(`pw-${RUN_ID}`, 4)

  const professor = await prisma.professor.create({
    data: { email: `${TAG}@example.invalid`, name: `Smoke ${RUN_ID}`, passwordHash: hash },
  })
  const cls = await prisma.class.create({
    data: {
      professorId: professor.id,
      name: `Smoke Class ${RUN_ID}`,
      joinCode: `SMK${RUN_ID.slice(-5).toUpperCase()}`,
    },
  })
  const session = await prisma.session.create({
    data: { classId: cls.id, title: `Smoke Session ${RUN_ID}`, accessCode: await freeCode(), status: 'OPEN' },
  })
  const question = await prisma.question.create({
    data: {
      sessionId: session.id,
      text: QUESTION_TEXT,
      type: 'FREE_TEXT',
      order: 0,
      accessCode: await freeCode(),
    },
  })
  const run = await prisma.sessionRun.create({
    data: { sessionId: session.id, status: 'OPEN' },
  })

  // One student per answer, so the unique [questionId, studentId] constraint holds.
  const students = []
  for (let i = 0; i < ANSWERS.length; i++) {
    const student = await prisma.student.create({
      data: {
        netId: `${TAG}-${i}`,
        email: `${TAG}-${i}@example.invalid`,
        passwordHash: hash,
      },
    })
    await prisma.enrollment.create({ data: { studentId: student.id, classId: cls.id } })
    const text = ANSWERS[i]!.text
    const wordCount = text.trim().split(/\s+/).filter(Boolean).length
    await prisma.response.create({
      data: {
        questionId: question.id,
        studentId: student.id,
        runId: run.id,
        responseText: text,
        wordCount,
        isFlagged: wordCount < 10,
        isDraft: false,
      },
    })
    students.push(student)
  }

  return { professor, cls, session, question, run, students }
}

async function destroyFixture(professorId: string, studentIds: string[]) {
  // Class → session → question → themeSet → categories all cascade from the professor;
  // responses and their theme assignments cascade from the students.
  await prisma.professor.delete({ where: { id: professorId } }).catch(() => {})
  for (const id of studentIds) {
    await prisma.student.delete({ where: { id } }).catch(() => {})
  }
}

// ─── Scoring helpers ──────────────────────────────────────────────────────────

/** Which category each answer ended up in, keyed by the answer's index in ANSWERS. */
async function assignmentsByAnswerIndex(questionId: string, studentIds: string[]) {
  const rows = await prisma.response.findMany({
    where: { questionId },
    select: { studentId: true, theme: { select: { categoryId: true, confidence: true } } },
  })
  const byStudent = new Map(rows.map((r) => [r.studentId, r.theme]))
  return studentIds.map((id) => byStudent.get(id) ?? null)
}

/** The largest number of a group's answers that share a single category. */
function cohesion(
  assignments: Array<{ categoryId: string } | null>,
  group: (typeof ANSWERS)[number]['group']
): { best: number; size: number } {
  const counts = new Map<string, number>()
  let size = 0
  ANSWERS.forEach((a, i) => {
    if (a.group !== group) return
    size++
    const cat = assignments[i]?.categoryId
    if (cat) counts.set(cat, (counts.get(cat) ?? 0) + 1)
  })
  return { best: Math.max(0, ...counts.values()), size }
}

// ─── The test ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('Pulse live-themes smoke test')
  console.log(`  server : ${BASE}`)
  console.log(`  run id : ${RUN_ID}`)
  console.log(`  answers: ${ANSWERS.length} (4 entropy, 4 heat, 3 phase, 2 junk)`)

  const health = await fetch(BASE).catch(() => null)
  if (!health) throw new Error(`No server at ${BASE}. Start one, or set E2E_BASE.`)

  const { professor, session, question, students } = await createFixture()
  const pTok = tokenFor(professor.id, 'professor')
  const studentIds = students.map((s) => s.id)
  console.log(`  fixture: question ${question.id}`)

  try {
    // ── 1. Bootstrap ──────────────────────────────────────────────────────────
    section('1. Bootstrap via the summarize route')
    const t0 = Date.now()
    const post = await http<any>('POST', `/api/sessions/${session.id}/questions/${question.id}/summarize`, { token: pTok })
    const elapsed = Date.now() - t0

    check('summarize returns 200', post.status === 200, `status ${post.status} ${JSON.stringify(post.body)?.slice(0, 200)}`)
    if (post.status !== 200) throw new Error('Bootstrap failed; the rest of the test cannot run')
    console.log(`  (took ${(elapsed / 1000).toFixed(1)}s)`)

    const themes = post.body?.data?.themes
    const categories: Array<any> = themes?.categories ?? []
    console.log('  categories returned:')
    for (const c of categories) console.log(`    ${String(c.count).padStart(3)}  ${c.label}${c.isOther ? '  (forming)' : ''}`)

    check('status is ACTIVE', themes?.status === 'ACTIVE', `got ${themes?.status}`)
    check('model is recorded', typeof themes?.model === 'string' && themes.model.length > 0, `got ${themes?.model}`)
    check('at least three categories including Forming', categories.length >= 3, `got ${categories.length}`)
    check('at most seven categories', categories.length <= 7, `got ${categories.length}`)

    const others = categories.filter((c) => c.isOther)
    check('exactly one Forming bucket', others.length === 1, `got ${others.length}`)
    check('Forming bucket is last', categories.length > 0 && categories[categories.length - 1]?.isOther === true)

    // ── 2. Counts are derived, not asserted by the model ──────────────────────
    section('2. Counts')
    const sum = categories.reduce((s, c) => s + c.count, 0)
    check('counts sum to classified', sum === themes?.classified, `sum ${sum} vs classified ${themes?.classified}`)
    check('every answer is classified', themes?.classified === ANSWERS.length, `${themes?.classified} of ${ANSWERS.length}`)
    check('total matches the answers created', themes?.total === ANSWERS.length, `got ${themes?.total}`)

    const rowCount = await prisma.responseTheme.count({
      where: { response: { questionId: question.id } },
    })
    check('one assignment row per answer in the database', rowCount === ANSWERS.length, `${rowCount} rows`)

    const set = await prisma.themeSet.findFirst({ where: { questionId: question.id } })
    check('bootstrapN records how many answers seeded it', set?.bootstrapN === ANSWERS.length, `got ${set?.bootstrapN}`)

    // ── 3. Does the clustering actually make sense? ───────────────────────────
    section('3. Clustering quality')
    const assignments = await assignmentsByAnswerIndex(question.id, studentIds)
    const otherId = others[0]?.id

    for (const group of ['entropy', 'heat', 'phase'] as const) {
      const { best, size } = cohesion(assignments, group)
      check(
        `the ${group} answers group together (${best}/${size} share a category)`,
        best >= size - 1,
        `best cluster held only ${best} of ${size}`
      )
    }

    const junkIdx = ANSWERS.map((a, i) => (a.group === 'junk' ? i : -1)).filter((i) => i >= 0)
    const junkInForming = junkIdx.filter((i) => assignments[i]?.categoryId === otherId).length
    check(
      `junk answers land in Forming (${junkInForming}/${junkIdx.length})`,
      junkInForming === junkIdx.length,
      'a junk answer was placed in a real category — the prompt or MIN_CONFIDENCE needs tightening'
    )

    const realAnswers = assignments.filter((_, i) => ANSWERS[i]!.group !== 'junk')
    const realInForming = realAnswers.filter((a) => a?.categoryId === otherId).length
    check(
      `real answers mostly avoid Forming (${realInForming}/${realAnswers.length} fell through)`,
      realInForming <= 2,
      'too many genuine answers were not confidently categorised'
    )

    // ── 4. The reload guarantee ───────────────────────────────────────────────
    section('4. Persistence — the reason phase 1 exists')
    const get = await http<any>('GET', `/api/sessions/${session.id}/questions/${question.id}/themes`, { token: pTok })
    check('themes route returns 200', get.status === 200, `status ${get.status}`)

    const reread: Array<any> = get.body?.data?.themes?.categories ?? []
    check('same number of categories after reload', reread.length === categories.length, `${reread.length} vs ${categories.length}`)
    check(
      'same category ids and counts after reload',
      JSON.stringify(reread.map((c) => [c.id, c.count])) === JSON.stringify(categories.map((c) => [c.id, c.count])),
      'the persisted read disagrees with what the bootstrap returned'
    )

    // ── 5. Re-running replaces rather than blends ─────────────────────────────
    section('5. Re-run replaces the previous set')
    const again = await http<any>('POST', `/api/sessions/${session.id}/questions/${question.id}/summarize`, { token: pTok })
    check('second summarize returns 200', again.status === 200, `status ${again.status}`)

    const setCount = await prisma.themeSet.count({ where: { questionId: question.id } })
    check('still exactly one theme set for the question', setCount === 1, `${setCount} sets`)

    const catCount = await prisma.themeCategory.count({ where: { themeSet: { questionId: question.id } } })
    const againCats: Array<any> = again.body?.data?.themes?.categories ?? []
    check('no orphaned categories from the first run', catCount === againCats.length, `${catCount} rows vs ${againCats.length} returned`)

    const rowsAfter = await prisma.responseTheme.count({ where: { response: { questionId: question.id } } })
    check('still one assignment per answer after re-running', rowsAfter === ANSWERS.length, `${rowsAfter} rows`)

  } finally {
    section('Cleanup')
    await destroyFixture(professor.id, studentIds)
    const leftover = await prisma.class.count({ where: { name: { contains: RUN_ID } } })
    check('all fixture data removed', leftover === 0, `${leftover} classes remain`)
  }

  section('Result')
  console.log(`  ${passed} passed, ${failed} failed`)
  if (failures.length) {
    console.log('\nFailures:')
    for (const f of failures) console.log(`  - ${f}`)
  }
  await prisma.$disconnect()
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(async (err) => {
  console.error('\nFATAL:', err)
  await prisma.$disconnect()
  process.exit(1)
})
