/**
 * Smoke test for live AI themes.
 *
 * The point of this script is that it needs no real students and no clicking. It
 * fabricates classes whose grouping is known in advance and checks that the clustering
 * is *sensible*, not merely that some JSON parsed.
 *
 * The answers are three genuinely distinct framings of one question — entropy, heat
 * transfer, phase stability — plus junk. So the entropy answers should end up together,
 * and "idk" should reach Forming rather than distorting a real category.
 *
 * Four fixtures, because the paths fail differently:
 *   1-5  batch     — responses seeded directly, driven by the summarize button
 *   6    live      — submitted through the real student route, so the worker's hook fires
 *   7    scale     — 120 answers, past both the bootstrap sample cap and the catch-up
 *                    threshold, where junk is numerous enough to cluster on its own
 *   8    gate      — themes off, to prove nothing runs until a professor switches it on
 *
 * Costs roughly five Opus 5 calls and nine Haiku calls, takes about five minutes, and
 * writes to whatever DATABASE_URL points at, deleting everything it created afterwards.
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

/**
 * The order answers arrive in for the live test.
 *
 * ANSWERS is grouped, so its first eight would be four entropy and four heat with no
 * phase answers at all — bootstrap would derive categories that miss a third of the
 * class. Interleaving means the first eight span all three groups, which is what a real
 * lecture looks like and what makes the later assertions mean anything.
 */
const LIVE_ORDER = [0, 4, 8, 1, 5, 9, 2, 6, 10, 3, 7, 11, 12]

/** Well past the 40-answer bootstrap cap, and past the catch-up threshold too. */
const SCALE_N = 120

interface FixtureOpts {
  /** Turn on automatic theming for the question. */
  liveThemes?: boolean
  /** Write responses straight to the database, bypassing the submit route and its hook. */
  seedResponses?: boolean
  /** Distinguishes fixtures that would otherwise collide on email and join code. */
  tag?: string
}

async function createFixture({ liveThemes = false, seedResponses = true, tag }: FixtureOpts = {}) {
  const hash = await bcrypt.hash(`pw-${RUN_ID}`, 4)
  const suffix = tag ?? (liveThemes ? 'live' : 'batch')

  const professor = await prisma.professor.create({
    data: { email: `${TAG}-${suffix}@example.invalid`, name: `Smoke ${RUN_ID}`, passwordHash: hash },
  })
  const cls = await prisma.class.create({
    data: {
      professorId: professor.id,
      name: `Smoke Class ${RUN_ID} ${suffix}`,
      joinCode: `SM${suffix.slice(0, 1).toUpperCase()}${RUN_ID.slice(-5).toUpperCase()}`,
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
      liveThemes: liveThemes ? true : null,
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
        netId: `${TAG}-${suffix}-${i}`,
        email: `${TAG}-${suffix}-${i}@example.invalid`,
        passwordHash: hash,
      },
    })
    await prisma.enrollment.create({ data: { studentId: student.id, classId: cls.id } })
    if (seedResponses) {
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
    }
    students.push(student)
  }

  return { professor, cls, session, question, run, students }
}

/** Poll the themes route until it satisfies `done`, or give up. Returns what it last saw. */
async function waitForThemes(
  sessionId: string,
  questionId: string,
  token: string,
  done: (t: any) => boolean,
  timeoutMs = 90_000
): Promise<any> {
  const started = Date.now()
  let last: any = null
  while (Date.now() - started < timeoutMs) {
    const r = await http<any>('GET', `/api/sessions/${sessionId}/questions/${questionId}/themes`, { token })
    last = r.body?.data?.themes ?? null
    if (done(last)) return last
    await new Promise((r) => setTimeout(r, 1000))
  }
  return last
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ─── Scale fixture ────────────────────────────────────────────────────────────

/** Surface variety over the same three positions, so the groups stay knowable. */
const PREFIXES = ['', 'I think ', 'Basically ', 'In my view ', 'Honestly ', 'My answer is that ']

function scaleAnswers(n: number) {
  const out: Array<{ group: (typeof ANSWERS)[number]['group']; text: string }> = []
  for (let i = 0; i < n; i++) {
    const base = ANSWERS[i % ANSWERS.length]!
    const prefix = PREFIXES[Math.floor(i / ANSWERS.length) % PREFIXES.length]!
    const text = prefix ? prefix + base.text.charAt(0).toLowerCase() + base.text.slice(1) : base.text
    out.push({ group: base.group, text })
  }
  return out
}

/**
 * A class far larger than the bootstrap sample. Written straight to the database with
 * createMany — this section is about what the clustering call does with a big class, not
 * about the submit route, which section 6 already covers.
 */
async function createScaleFixture(n: number) {
  const hash = await bcrypt.hash(`pw-${RUN_ID}`, 4)
  const answers = scaleAnswers(n)

  const professor = await prisma.professor.create({
    data: { email: `${TAG}-scale@example.invalid`, name: `Smoke ${RUN_ID}`, passwordHash: hash },
  })
  const cls = await prisma.class.create({
    data: {
      professorId: professor.id,
      name: `Smoke Class ${RUN_ID} scale`,
      joinCode: `SMX${RUN_ID.slice(-5).toUpperCase()}`,
    },
  })
  const session = await prisma.session.create({
    data: { classId: cls.id, title: `Smoke Scale ${RUN_ID}`, accessCode: await freeCode(), status: 'OPEN' },
  })
  const question = await prisma.question.create({
    data: { sessionId: session.id, text: QUESTION_TEXT, type: 'FREE_TEXT', order: 0, accessCode: await freeCode() },
  })
  const run = await prisma.sessionRun.create({ data: { sessionId: session.id, status: 'OPEN' } })

  await prisma.student.createMany({
    data: answers.map((_, i) => ({
      netId: `${TAG}-scale-${i}`,
      email: `${TAG}-scale-${i}@example.invalid`,
      passwordHash: hash,
    })),
  })
  const students = await prisma.student.findMany({
    where: { netId: { startsWith: `${TAG}-scale-` } },
    select: { id: true, netId: true },
  })
  const byIndex = new Map(students.map((s) => [Number(s.netId.split('-').pop()), s.id]))

  await prisma.response.createMany({
    data: answers.map((a, i) => {
      const wordCount = a.text.trim().split(/\s+/).filter(Boolean).length
      return {
        questionId: question.id,
        studentId: byIndex.get(i)!,
        runId: run.id,
        responseText: a.text,
        wordCount,
        isFlagged: wordCount < 10,
        isDraft: false,
        // Spread submission times so the even sample has an order to spread across.
        submittedAt: new Date(Date.now() - (answers.length - i) * 1000),
      }
    }),
  })

  return { professor, session, question, run, studentIds: students.map((s) => s.id), answers }
}

async function destroyFixture(professorId: string, studentIds: string[]) {
  // Classes first: professor deletion is Restrict-ed while any remain. Session,
  // question, themeSet, and categories all cascade from the class; responses and
  // their theme assignments cascade from the students.
  await prisma.class.deleteMany({ where: { professorId } }).catch(() => {})
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

  // Sections 6 and 7 build their own fixtures; declared here so cleanup reaches them.
  let live: Awaited<ReturnType<typeof createFixture>> | null = null
  let scale: Awaited<ReturnType<typeof createScaleFixture>> | null = null
  let gate: Awaited<ReturnType<typeof createFixture>> | null = null

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

    // ── 6. The automatic live path (phase 2) ──────────────────────────────────
    // A separate fixture, because this one must submit through the real student route
    // so the hook on response creation actually fires.
    section('6. Automatic theming during a lecture')
    live = await createFixture({ liveThemes: true, seedResponses: false })
    const lq = live.question.id
    const ls = live.session.id
    const lTok = tokenFor(live.professor.id, 'professor')

    const submit = async (answerIndex: number) => {
      const student = live!.students[answerIndex]!
      return http<any>('POST', '/api/responses', {
        token: tokenFor(student.id, 'student'),
        body: { questionId: lq, responseText: ANSWERS[answerIndex]!.text },
      })
    }

    // Below the threshold, nothing should happen at all — no set, no API call.
    for (const i of LIVE_ORDER.slice(0, 7)) {
      const r = await submit(i)
      if (r.status !== 201) check(`answer ${i} accepted`, false, `status ${r.status}`)
    }
    check('7 answers submitted through the student route', true)

    // Comfortably past the 2s debounce and the 6s ceiling.
    await sleep(9000)
    const early = await http<any>('GET', `/api/sessions/${ls}/questions/${lq}/themes`, { token: lTok })
    const earlyThemes = early.body?.data?.themes
    check(
      'no categories derived below the bootstrap threshold',
      !earlyThemes || earlyThemes.status === 'WAITING' || earlyThemes.categories?.length === 0,
      `status ${earlyThemes?.status}, ${earlyThemes?.categories?.length ?? 0} categories`
    )
    const setsBefore = await prisma.themeSet.count({ where: { questionId: lq } })
    check('no theme set row written before it is needed', setsBefore === 0, `${setsBefore} sets`)

    // The eighth answer should trigger bootstrap on its own, with nothing clicked.
    await submit(LIVE_ORDER[7]!)
    const t0boot = Date.now()
    const booted = await waitForThemes(ls, lq, lTok, (t) => t?.status === 'ACTIVE' && t.categories?.length >= 3)
    check(
      'the 8th answer triggers bootstrap automatically',
      booted?.status === 'ACTIVE',
      `status ${booted?.status} after ${((Date.now() - t0boot) / 1000).toFixed(1)}s`
    )
    if (booted?.status === 'ACTIVE') {
      console.log(`  (bootstrap landed ${((Date.now() - t0boot) / 1000).toFixed(1)}s after the 8th answer)`)
      check('bootstrap classified all 8', booted.classified === 8, `classified ${booted.classified}`)
    }

    // The rest arrive and should be classified incrementally, without another bootstrap.
    const bootIds = (booted?.categories ?? []).map((c: any) => c.id).join(',')
    for (const i of LIVE_ORDER.slice(8)) {
      const r = await submit(i)
      if (r.status !== 201) check(`answer ${i} accepted`, false, `status ${r.status}`)
    }
    const t0cls = Date.now()
    const settled = await waitForThemes(ls, lq, lTok, (t) => t?.classified >= ANSWERS.length)
    check(
      'later answers are classified incrementally',
      settled?.classified === ANSWERS.length,
      `classified ${settled?.classified} of ${ANSWERS.length}`
    )
    if (settled) {
      console.log(`  (remaining ${ANSWERS.length - 8} classified in ${((Date.now() - t0cls) / 1000).toFixed(1)}s)`)
      console.log('  final distribution:')
      for (const c of settled.categories) console.log(`    ${String(c.count).padStart(3)}  ${c.label}${c.isOther ? '  (forming)' : ''}`)
    }

    check(
      'categories did not churn while answers arrived',
      (settled?.categories ?? []).map((c: any) => c.id).join(',') === bootIds,
      'the category ids changed mid-run — labels would have visibly reshuffled'
    )

    const liveSets = await prisma.themeSet.count({ where: { questionId: lq } })
    check('still exactly one theme set after the whole run', liveSets === 1, `${liveSets} sets`)

    const liveSet = await prisma.themeSet.findFirst({ where: { questionId: lq }, select: { classifyCalls: true, bootstrapN: true } })
    check('bootstrap used exactly the threshold number of answers', liveSet?.bootstrapN === 8, `got ${liveSet?.bootstrapN}`)
    check(
      'the 5 remaining answers cost a single classify call',
      liveSet?.classifyCalls === 1,
      `${liveSet?.classifyCalls} calls — batching may not be working`
    )

    const liveAssignments = await assignmentsByAnswerIndex(lq, live.students.map((s) => s.id))
    const liveOther = (settled?.categories ?? []).find((c: any) => c.isOther)?.id
    const liveJunk = ANSWERS.map((a, i) => (a.group === 'junk' ? i : -1)).filter((i) => i >= 0)
    const liveJunkForming = liveJunk.filter((i) => liveAssignments[i]?.categoryId === liveOther).length
    check(
      `junk answers reach Forming on the live path too (${liveJunkForming}/${liveJunk.length})`,
      liveJunkForming === liveJunk.length,
      'the classifier placed junk in a real category'
    )

    // ── 7. A class far bigger than the clustering call can hold ───────────────
    section(`7. Scale — ${SCALE_N} answers`)
    scale = await createScaleFixture(SCALE_N)
    const sq = scale.question.id
    const ss = scale.session.id
    const sTok2 = tokenFor(scale.professor.id, 'professor')

    const t0scale = Date.now()
    const bigPost = await http<any>('POST', `/api/sessions/${ss}/questions/${sq}/summarize`, { token: sTok2 })
    check('summarize returns promptly on a large class', bigPost.status === 200, `status ${bigPost.status}`)
    const firstReturn = Date.now() - t0scale
    console.log(`  (button returned in ${(firstReturn / 1000).toFixed(1)}s)`)

    const bigSet = await prisma.themeSet.findFirst({ where: { questionId: sq }, select: { bootstrapN: true } })
    check(
      'clustering sampled a capped subset, not the whole class',
      (bigSet?.bootstrapN ?? 0) <= 40 && (bigSet?.bootstrapN ?? 0) >= 8,
      `bootstrapN was ${bigSet?.bootstrapN} of ${SCALE_N}`
    )
    check(
      'the button did not wait for every answer to be classified',
      (bigPost.body?.data?.themes?.classified ?? 0) < SCALE_N,
      'it classified everything inline, which would block the request on a big class'
    )

    const bigSettled = await waitForThemes(ss, sq, sTok2, (t) => t?.classified >= SCALE_N, 240_000)
    check(
      'every answer is eventually classified',
      bigSettled?.classified === SCALE_N,
      `classified ${bigSettled?.classified} of ${SCALE_N}`
    )
    console.log(`  (all ${SCALE_N} classified ${((Date.now() - t0scale) / 1000).toFixed(1)}s after the click)`)

    if (bigSettled) {
      console.log('  distribution:')
      for (const c of bigSettled.categories) console.log(`    ${String(c.count).padStart(4)}  ${c.label}${c.isOther ? '  (forming)' : ''}`)
      const bigSum = bigSettled.categories.reduce((s: number, c: any) => s + c.count, 0)
      check('counts still sum correctly at scale', bigSum === SCALE_N, `sum ${bigSum} vs ${SCALE_N}`)
    }

    const bigCalls = await prisma.themeSet.findFirst({ where: { questionId: sq }, select: { classifyCalls: true } })
    // Unbatched would be ~80 calls for the leftovers; batching should keep it near 6.
    check(
      `the backlog was batched, not sent one at a time (${bigCalls?.classifyCalls} calls)`,
      (bigCalls?.classifyCalls ?? 999) <= 10,
      `${bigCalls?.classifyCalls} calls for ${SCALE_N - (bigSet?.bootstrapN ?? 0)} leftover answers`
    )

    const bigOther = (bigSettled?.categories ?? []).find((c: any) => c.isOther)
    const expectedJunk = scale.answers.filter((a) => a.group === 'junk').length
    check(
      `junk still lands in Forming at scale (${bigOther?.count} vs ${expectedJunk} junk answers)`,
      (bigOther?.count ?? 0) >= expectedJunk * 0.8,
      'Forming holds far fewer than the junk answers submitted'
    )

    // ── 8. The enablement gate ────────────────────────────────────────────────
    // themesEnabled() is what keeps this feature off for everyone by default. Until now
    // it was only ever exercised by setting the flag directly in the database.
    section('8. Enablement gate, through the API')
    gate = await createFixture({ liveThemes: false, seedResponses: false, tag: 'gate' })
    const gq = gate.question.id
    const gs = gate.session.id
    const gTok = tokenFor(gate.professor.id, 'professor')

    check('question starts with liveThemes unset', gate.question.liveThemes === null, `got ${gate.question.liveThemes}`)

    // Well past BOOTSTRAP_N — only the gate should be stopping this.
    for (const i of LIVE_ORDER.slice(0, 10)) {
      const r = await http<any>('POST', '/api/responses', {
        token: tokenFor(gate.students[i]!.id, 'student'),
        body: { questionId: gq, responseText: ANSWERS[i]!.text },
      })
      if (r.status !== 201) check(`gate answer ${i} accepted`, false, `status ${r.status}`)
    }
    await sleep(9000)

    const gatedSets = await prisma.themeSet.count({ where: { questionId: gq } })
    check(
      '10 answers with themes off produce no theme set at all',
      gatedSets === 0,
      `${gatedSets} sets — the gate is not holding, and every lecture would be calling an LLM`
    )

    // Turning it on through the real route, the way the new UI does.
    const patch = await http<any>('PATCH', `/api/sessions/${gs}/questions/${gq}`, {
      token: gTok,
      body: { liveThemes: true },
    })
    check('the question route accepts liveThemes', patch.status === 200, `status ${patch.status}`)
    const stored = await prisma.question.findUnique({ where: { id: gq }, select: { liveThemes: true } })
    check('liveThemes persisted as true', stored?.liveThemes === true, `stored ${stored?.liveThemes}`)

    // One more answer, and the backlog that was ignored should now be picked up.
    const r11 = await http<any>('POST', '/api/responses', {
      token: tokenFor(gate.students[LIVE_ORDER[10]!]!.id, 'student'),
      body: { questionId: gq, responseText: ANSWERS[LIVE_ORDER[10]!]!.text },
    })
    check('11th answer accepted', r11.status === 201, `status ${r11.status}`)

    const gateSettled = await waitForThemes(gs, gq, gTok, (t) => t?.status === 'ACTIVE' && t.classified >= 11)
    check(
      'enabling mid-session catches up on answers already in',
      gateSettled?.classified === 11,
      `classified ${gateSettled?.classified} of 11 — the earlier answers were not backfilled`
    )

    // The class-level default, also through its real route.
    const clsPatch = await http<any>('PATCH', `/api/classes/${gate.cls.id}`, {
      token: gTok,
      body: { liveThemesDefault: true },
    })
    check('the class route accepts liveThemesDefault', clsPatch.status === 200, `status ${clsPatch.status}`)
    const storedCls = await prisma.class.findUnique({ where: { id: gate.cls.id }, select: { liveThemesDefault: true } })
    check('liveThemesDefault persisted', storedCls?.liveThemesDefault === true, `stored ${storedCls?.liveThemesDefault}`)

    // And it must refuse types where it would mean nothing.
    const mcq = await prisma.question.create({
      data: { sessionId: gs, text: 'Pick one', type: 'MULTIPLE_CHOICE', options: ['a', 'b'], order: 9, accessCode: await freeCode() },
    })
    const badPatch = await http<any>('PATCH', `/api/sessions/${gs}/questions/${mcq.id}`, {
      token: gTok,
      body: { liveThemes: true },
    })
    check('liveThemes is refused on non-free-text questions', badPatch.status === 400, `status ${badPatch.status}`)

  } finally {
    section('Cleanup')
    await destroyFixture(professor.id, studentIds)
    if (live) await destroyFixture(live.professor.id, live.students.map((s) => s.id))
    if (scale) await destroyFixture(scale.professor.id, scale.studentIds)
    if (gate) await destroyFixture(gate.professor.id, gate.students.map((s) => s.id))
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
