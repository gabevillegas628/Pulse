/**
 * Smoke test for the per-question auto-close countdown.
 *
 * Two halves, because they fail differently:
 *
 *   1. The clock itself, driven directly with injected timestamps. `touch()` and
 *      `isOpen()` both take an explicit time precisely so the reset, the floor and
 *      the gap-scaled grace can be checked without waiting out real seconds.
 *   2. The wiring, against a running server: that the toggle persists, that a
 *      question with the countdown off is untouched, that the submit route actually
 *      refuses a late answer, and that the projector payload withholds the answer
 *      key until the question closes.
 *
 * Part 2 sits through one real ~20s floor, because that floor is the thing being
 * tested and faking it would test nothing. Budget half a minute.
 *
 * Usage:
 *   npx tsx scripts/smoke-autoclose.ts
 *   E2E_BASE=http://localhost:3010 npx tsx scripts/smoke-autoclose.ts
 *
 * Part 1 needs nothing running. Part 2 requires a server pointed at the same
 * database this script connects to, and cleans up everything it creates.
 */

import 'dotenv/config'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { prisma } from '../src/db/index.js'
import { config } from '../src/config/index.js'
import {
  autoCloseEnabled, touch, isOpen, closesAt, clockState, reopen, clearRun,
} from '../src/services/clock.service.js'

const BASE = process.env.E2E_BASE ?? 'http://localhost:3001'
const RUN_ID = Date.now().toString(36)
const TAG = `smoke-ac-${RUN_ID}`

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function freeCode(): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const c = String(Math.floor(Math.random() * 10000)).padStart(4, '0')
    if (!(await prisma.question.findUnique({ where: { accessCode: c } }))) return c
  }
  throw new Error('No free access code available — the 4-digit namespace may be full')
}

// These mirror the constants in clock.service.ts. Duplicated on purpose: if someone
// retunes the service, these assertions should fail loudly rather than silently
// following along and testing nothing.
const FLOOR_MS = 20_000
const MIN_GRACE_MS = 8_000
const MAX_GRACE_MS = 45_000

// ─── Part 1: the clock, on injected time ──────────────────────────────────────

function clockTests() {
  section('Inherit logic')

  check('null inherits a class default of on',
    autoCloseEnabled({ autoClose: null }, { autoCloseDefault: true }) === true)
  check('null inherits a class default of off',
    autoCloseEnabled({ autoClose: null }, { autoCloseDefault: false }) === false)
  check('true overrides a class default of off',
    autoCloseEnabled({ autoClose: true }, { autoCloseDefault: false }) === true)
  check('false overrides a class default of on',
    autoCloseEnabled({ autoClose: false }, { autoCloseDefault: true }) === false)

  section('Starting and closing')

  const t0 = 1_000_000_000_000
  const RUN = 'run-unit'

  check('a question with no clock is open — the first answer is never refused',
    isOpen(RUN, 'q-untouched', t0) === true)
  check('a question with no clock has no deadline',
    closesAt(RUN, 'q-untouched') === null)

  // One answer and then silence. Pace is unknown, so the grace falls back to its
  // minimum and the floor is what actually holds the question open.
  touch('sess', RUN, 'q-lonely', t0)
  const lonely = closesAt(RUN, 'q-lonely')!
  check('a single answer is held open by the floor',
    lonely === t0 + FLOOR_MS, `closesAt was t0+${lonely - t0}ms`)
  check('the question is open before its deadline', isOpen(RUN, 'q-lonely', lonely - 1) === true)
  check('the question is closed at its deadline', isOpen(RUN, 'q-lonely', lonely) === false)
  check('the question stays closed after its deadline', isOpen(RUN, 'q-lonely', lonely + 60_000) === false)

  section('Monotonicity')

  // The regression this section exists for. The first answer has no pace to go on; the
  // second reveals it and collapses the computed grace. Before the deadline was clamped
  // monotonic, that second answer pulled the close twenty-five seconds *earlier* — the
  // room would have watched the bar shrink at the moment an answer landed and learned
  // the exact opposite of the rule the countdown is there to teach.
  touch('sess', RUN, 'q-mono', t0)
  const monoFirst = closesAt(RUN, 'q-mono')!
  touch('sess', RUN, 'q-mono', t0 + 150)
  const monoSecond = closesAt(RUN, 'q-mono')!
  check('a fast second answer never pulls the deadline in',
    monoSecond >= monoFirst, `${monoFirst - t0} -> ${monoSecond - t0}`)

  // And across a whole question, at every single step.
  let prev = 0
  let shrank = 0
  let extended = 0
  for (const dt of [0, 900, 2000, 3400, 5200, 7600, 10800, 15000, 21000, 29000, 39000]) {
    touch('sess', RUN, 'q-arc', t0 + dt)
    const now = closesAt(RUN, 'q-arc')!
    if (prev !== 0) {
      if (now < prev) shrank++
      if (now > prev) extended++
    }
    prev = now
  }
  check('the deadline never moves in across a realistic arrival pattern', shrank === 0,
    `${shrank} step(s) moved it in`)
  // If nothing ever extends it, the reset is invisible and the feature teaches nothing.
  check('and answers do visibly extend it once the pace is known', extended >= 3,
    `only ${extended} step(s) extended it`)

  section('The floor')

  // A burst of fast answers then silence. The gap-scaled grace would close this in
  // MIN_GRACE_MS, but the floor must hold the question open longer than that.
  for (let i = 0; i < 6; i++) touch('sess', RUN, 'q-burst', t0 + i * 200)
  const burstLast = t0 + 5 * 200
  const burst = closesAt(RUN, 'q-burst')!
  check('a fast burst is held open by the floor, not by its grace',
    burst === t0 + FLOOR_MS, `closesAt was t0+${burst - t0}ms`)
  check('the floor beats the scaled grace here',
    t0 + FLOOR_MS > burstLast + MIN_GRACE_MS)

  section('The reset')

  // Answers spaced 3s apart: median gap 3s, so grace is 9s — inside the clamp, and
  // long enough past the floor that the reset is what governs.
  const GAP = 3_000
  for (let i = 0; i < 10; i++) touch('sess', RUN, 'q-steady', t0 + i * GAP)
  const steadyLast = t0 + 9 * GAP
  const steady = closesAt(RUN, 'q-steady')!
  check('grace scales to the observed pace',
    steady === steadyLast + GAP * 3, `closesAt was last+${steady - steadyLast}ms`)
  check('the scaled grace is past the floor by now',
    steady > t0 + FLOOR_MS)

  // The property the whole design rests on: another answer must push the deadline out.
  const before = closesAt(RUN, 'q-steady')!
  touch('sess', RUN, 'q-steady', steadyLast + GAP)
  const after = closesAt(RUN, 'q-steady')!
  check('every answer pushes the deadline further out — this is the reset',
    after > before, `${before} -> ${after}`)

  // ...and that a question about to close is rescued by one late answer.
  check('an answer arriving just before the deadline reopens the window',
    isOpen(RUN, 'q-steady', after - 1) === true)

  section('The window the bar draws')

  // The bar is keyed on the deadline and seeks in by `closesAt - windowMs`. If an answer
  // that leaves the deadline alone still rewrote the window, the projector would re-time
  // a running animation once per answer and the bar would stutter.
  touch('sess', RUN, 'q-window', t0)
  const w1 = clockState(RUN, 'q-window')!
  touch('sess', RUN, 'q-window', t0 + 200)
  const w2 = clockState(RUN, 'q-window')!
  check('an answer that does not move the deadline leaves the window alone',
    w2.closesAt === w1.closesAt && w2.windowMs === w1.windowMs,
    `window ${w1.windowMs} -> ${w2.windowMs}`)
  check('the window start is where the bar should seek from',
    w2.closesAt - w2.windowMs === t0, `start was t0+${w2.closesAt - w2.windowMs - t0}ms`)

  section('Clamps')

  // Answers 60s apart would scale to a 180s grace; the clamp must cap it so a slow
  // trickle cannot hold the room hostage.
  for (let i = 0; i < 6; i++) touch('sess', RUN, 'q-slow', t0 + i * 60_000)
  const slowLast = t0 + 5 * 60_000
  const slow = closesAt(RUN, 'q-slow')!
  check('a slow trickle is capped at the maximum grace',
    slow === slowLast + MAX_GRACE_MS, `closesAt was last+${slow - slowLast}ms`)

  section('Out-of-order arrivals')

  touch('sess', RUN, 'q-order', t0 + 10_000)
  const ordered = closesAt(RUN, 'q-order')!
  touch('sess', RUN, 'q-order', t0)  // earlier than what we already have
  check('an out-of-order arrival never pulls the deadline backwards',
    closesAt(RUN, 'q-order')! >= ordered)

  section('Professor override and run cleanup')

  const past = t0 - MAX_GRACE_MS - 1
  touch('sess', RUN, 'q-reopen', past)
  check('the question is closed before the override', isOpen(RUN, 'q-reopen', t0) === false)
  reopen('sess', RUN, 'q-reopen')
  check('reopen restarts the clock from now', isOpen(RUN, 'q-reopen') === true)

  touch('sess', 'run-other', 'q-other', t0)
  clearRun(RUN)
  check('clearRun drops that run\'s clocks', closesAt(RUN, 'q-steady') === null)
  check('clearRun leaves other runs alone', closesAt('run-other', 'q-other') !== null)
  clearRun('run-other')
}

// ─── Part 2: the wiring, against a live server ────────────────────────────────

const OPTIONS = ['Entropy increases', 'Heat flows in', 'It is above zero', 'None of these']
const CORRECT = OPTIONS[1]!
/** Enough answers, spaced tightly, to pull the median gap down to the clamp. */
const VOTERS = 6

async function createFixture(tag: string, autoClose: boolean | null) {
  const hash = await bcrypt.hash(`pw-${RUN_ID}`, 4)

  const professor = await prisma.professor.create({
    data: { email: `${TAG}-${tag}@example.invalid`, name: `Smoke AC ${RUN_ID}`, passwordHash: hash },
  })
  const cls = await prisma.class.create({
    data: {
      professorId: professor.id,
      name: `Smoke AC Class ${RUN_ID} ${tag}`,
      joinCode: `AC${tag.slice(0, 1).toUpperCase()}${RUN_ID.slice(-5).toUpperCase()}`,
    },
  })
  const session = await prisma.session.create({
    data: { classId: cls.id, title: `Smoke AC Session ${RUN_ID}`, accessCode: await freeCode(), status: 'OPEN' },
  })
  const question = await prisma.question.create({
    data: {
      sessionId: session.id,
      text: 'Why does an ice cube melt at room temperature?',
      type: 'MULTIPLE_CHOICE',
      options: OPTIONS,
      correctAnswer: CORRECT,
      order: 0,
      accessCode: await freeCode(),
      autoClose,
    },
  })
  const run = await prisma.sessionRun.create({ data: { sessionId: session.id, status: 'OPEN' } })

  const students = []
  for (let i = 0; i < VOTERS + 3; i++) {
    const student = await prisma.student.create({
      data: {
        netId: `${TAG}-${tag}-${i}`,
        email: `${TAG}-${tag}-${i}@example.invalid`,
        passwordHash: hash,
      },
    })
    await prisma.enrollment.create({ data: { studentId: student.id, classId: cls.id } })
    students.push(student)
  }

  return { professor, cls, session, question, run, students }
}

async function destroyFixture(professorId: string, studentIds: string[]) {
  await prisma.professor.delete({ where: { id: professorId } }).catch(() => {})
  for (const id of studentIds) {
    await prisma.student.delete({ where: { id } }).catch(() => {})
  }
}

/** The projector's view of one question. */
async function liveQuestion(token: string, questionId: string) {
  const r = await http<any>('GET', '/api/addin/live', { token })
  const qs = r.body?.data?.session?.questions ?? []
  return qs.find((q: any) => q.id === questionId) ?? null
}

async function main() {
  clockTests()

  let timed: Awaited<ReturnType<typeof createFixture>> | null = null
  let untimed: Awaited<ReturnType<typeof createFixture>> | null = null

  try {
    const ping = await http('GET', '/health').catch(() => null)
    if (!ping || ping.status >= 500) {
      console.log(`\n  (no server at ${BASE} — skipping the integration half)`)
    } else {
      section('The toggle persists')

      timed = await createFixture('timed', true)
      const pTok = tokenFor(timed.professor.id, 'professor')

      const patch = await http('PATCH', `/api/sessions/${timed.session.id}/questions/${timed.question.id}`,
        { token: pTok, body: { autoClose: false } })
      check('the question route accepts autoClose', patch.status === 200, `status ${patch.status}`)
      let stored = await prisma.question.findUnique({
        where: { id: timed.question.id }, select: { autoClose: true },
      })
      check('autoClose persisted as false', stored?.autoClose === false, `stored ${stored?.autoClose}`)

      // Unlike liveThemes, which is refused on anything but FREE_TEXT. This question
      // is MULTIPLE_CHOICE, which is exactly where the answer key is worth protecting.
      const backOn = await http('PATCH', `/api/sessions/${timed.session.id}/questions/${timed.question.id}`,
        { token: pTok, body: { autoClose: true } })
      check('autoClose is allowed on a non-free-text question', backOn.status === 200, `status ${backOn.status}`)
      stored = await prisma.question.findUnique({
        where: { id: timed.question.id }, select: { autoClose: true },
      })
      check('autoClose persisted as true', stored?.autoClose === true, `stored ${stored?.autoClose}`)

      const clsPatch = await http('PATCH', `/api/classes/${timed.cls.id}`,
        { token: pTok, body: { autoCloseDefault: true } })
      check('the class route accepts autoCloseDefault', clsPatch.status === 200, `status ${clsPatch.status}`)
      const storedCls = await prisma.class.findUnique({
        where: { id: timed.cls.id }, select: { autoCloseDefault: true },
      })
      check('autoCloseDefault persisted', storedCls?.autoCloseDefault === true, `stored ${storedCls?.autoCloseDefault}`)

      section('The answer key is withheld while the question is open')

      // A burst of votes: tight spacing drives the grace to its floor-dominated
      // minimum, so this question closes ~FLOOR_MS after its first answer.
      const started = Date.now()
      for (let i = 0; i < VOTERS; i++) {
        const sTok = tokenFor(timed.students[i]!.id, 'student')
        const r = await http('POST', '/api/responses', {
          token: sTok,
          body: { questionId: timed.question.id, responseText: OPTIONS[i % OPTIONS.length]! },
        })
        check(`vote ${i + 1} accepted while the question is open`, r.status === 200 || r.status === 201,
          `status ${r.status}`)
        await sleep(150)
      }

      const openView = await liveQuestion(pTok, timed.question.id)
      check('the projector sees the votes', (openView?.responses?.length ?? 0) === VOTERS,
        `${openView?.responses?.length} responses`)
      check('the projector is told the question is timed', openView?.autoCloseOn === true)
      check('the projector gets an absolute deadline', typeof openView?.closesAt === 'number')
      // Without the window the bar cannot draw proportionally, nor seek into its drain
      // when the projector connects partway through a question.
      check('the projector gets the window the deadline belongs to',
        typeof openView?.closeWindowMs === 'number' && openView.closeWindowMs > 0,
        `closeWindowMs was ${openView?.closeWindowMs}`)
      check('the deadline sits exactly one window after the answer that set it',
        openView.closesAt - openView.closeWindowMs <= Date.now(),
        `window start ${openView?.closesAt - openView?.closeWindowMs} vs now ${Date.now()}`)

      // The property the whole mechanic rests on, end to end: one more answer must buy
      // the room more time. Checked through the real routes, not just the service.
      const beforeReset = openView.closesAt as number
      await sleep(1_100)
      const resetVote = await http('POST', '/api/responses', {
        token: tokenFor(timed.students[VOTERS + 1]!.id, 'student'),
        body: { questionId: timed.question.id, responseText: OPTIONS[0]! },
      })
      check('a further answer is accepted', resetVote.status === 200 || resetVote.status === 201,
        `status ${resetVote.status}`)
      const afterReset = await liveQuestion(pTok, timed.question.id)
      // Not `>`: these votes land inside the floor, where the question cannot close yet
      // and so there is nothing for an answer to extend. What must never happen — and did
      // before the deadline was clamped monotonic — is the close moving *in*. The
      // extension itself is exercised at full speed in the clock tests above.
      check('an answer never pulls the deadline in — checked through the routes',
        (afterReset?.closesAt ?? 0) >= beforeReset,
        `${beforeReset} -> ${afterReset?.closesAt}`)
      check('the answer key is still withheld after the reset',
        afterReset?.correctAnswer === null)
      check('the answer key is NOT on the wall while the question is open',
        openView?.correctAnswer === null, `correctAnswer was ${JSON.stringify(openView?.correctAnswer)}`)

      section('The close is real')

      const deadline = (afterReset?.closesAt ?? openView?.closesAt) as number
      const waitMs = Math.max(0, deadline - Date.now()) + 2_000
      console.log(`  waiting ${(waitMs / 1000).toFixed(1)}s for the countdown to run out…`)
      await sleep(waitMs)

      const late = await http('POST', '/api/responses', {
        token: tokenFor(timed.students[VOTERS]!.id, 'student'),
        body: { questionId: timed.question.id, responseText: CORRECT },
      })
      check('a late answer is refused', late.status === 409, `status ${late.status}`)
      check('the refusal says why', /closed/i.test((late.body as any)?.error ?? ''),
        JSON.stringify((late.body as any)?.error))

      const lateInDb = await prisma.response.count({
        where: { questionId: timed.question.id, studentId: timed.students[VOTERS]!.id },
      })
      check('the late answer was not recorded', lateInDb === 0, `${lateInDb} rows`)

      const byCode = await http('GET', `/api/questions/by-code/${timed.question.accessCode}`, {
        token: tokenFor(timed.students[VOTERS]!.id, 'student'),
      })
      check('a harvested access code no longer resolves', byCode.status === 409, `status ${byCode.status}`)

      const closedView = await liveQuestion(pTok, timed.question.id)
      check('the answer key appears once the question has closed',
        closedView?.correctAnswer === CORRECT, `correctAnswer was ${JSON.stringify(closedView?.correctAnswer)}`)
      check('the distribution is unchanged by closing',
        (closedView?.responses?.length ?? 0) === VOTERS + 1,
        `${closedView?.responses?.length} responses, expected ${VOTERS + 1}`)

      section('The professor override')

      const reopened = await http('POST',
        `/api/sessions/${timed.session.id}/questions/${timed.question.id}/reopen`, { token: pTok })
      check('reopen is accepted', reopened.status === 200, `status ${reopened.status}`)

      const afterReopen = await http('POST', '/api/responses', {
        token: tokenFor(timed.students[VOTERS]!.id, 'student'),
        body: { questionId: timed.question.id, responseText: CORRECT },
      })
      check('answers are accepted again after the override',
        afterReopen.status === 200 || afterReopen.status === 201, `status ${afterReopen.status}`)

      const reopenedView = await liveQuestion(pTok, timed.question.id)
      check('the answer key goes back into hiding once the question reopens',
        reopenedView?.correctAnswer === null,
        `correctAnswer was ${JSON.stringify(reopenedView?.correctAnswer)}`)

      section('A question with the countdown off is untouched')

      untimed = await createFixture('untimed', false)
      const upTok = tokenFor(untimed.professor.id, 'professor')

      const firstVote = await http('POST', '/api/responses', {
        token: tokenFor(untimed.students[0]!.id, 'student'),
        body: { questionId: untimed.question.id, responseText: OPTIONS[0]! },
      })
      check('an untimed question accepts its first answer',
        firstVote.status === 200 || firstVote.status === 201, `status ${firstVote.status}`)

      const untimedView = await liveQuestion(upTok, untimed.question.id)
      check('an untimed question is not reported as timed', untimedView?.autoCloseOn === false)
      check('an untimed question has no deadline', untimedView?.closesAt === null)
      // This is today's behaviour, preserved: with the countdown off, the answer key
      // is still on the wall live. Turning it on is what changes that.
      check('an untimed question still shows its answer key',
        untimedView?.correctAnswer === CORRECT,
        `correctAnswer was ${JSON.stringify(untimedView?.correctAnswer)}`)

      // Well past the floor for the timed question, and this one must still accept.
      await sleep(1_000)
      const stillOpen = await http('POST', '/api/responses', {
        token: tokenFor(untimed.students[1]!.id, 'student'),
        body: { questionId: untimed.question.id, responseText: OPTIONS[2]! },
      })
      check('an untimed question keeps accepting answers',
        stillOpen.status === 200 || stillOpen.status === 201, `status ${stillOpen.status}`)

      console.log(`  (integration half took ${((Date.now() - started) / 1000).toFixed(0)}s)`)
    }
  } finally {
    section('Cleanup')
    if (timed) await destroyFixture(timed.professor.id, timed.students.map((s) => s.id))
    if (untimed) await destroyFixture(untimed.professor.id, untimed.students.map((s) => s.id))
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
