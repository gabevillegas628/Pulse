/**
 * End-to-end test for the QR / access-code lifecycle.
 *
 * Covers the paths that decide whether a printed slide still works: the code a QR
 * encodes, the student's scan-to-answer route, the add-in's verify/adopt endpoints,
 * and what class duplication does to codes.
 *
 * Everything is created under a throwaway professor and deleted afterwards, so a run
 * leaves no trace beyond log lines. The one test that deliberately touches real data
 * is the ownership check, which asserts another professor's code CANNOT be stolen and
 * that their question is byte-identical afterwards.
 *
 * Usage:
 *   npm run test:e2e:qr                 # against http://localhost:3001
 *   E2E_BASE=http://localhost:3010 npm run test:e2e:qr
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
const TAG = `e2e-${RUN_ID}`

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

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

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

/**
 * Mint a token directly rather than logging in. Avoids inventing a password flow and
 * keeps JWT_SECRET out of the output.
 */
const tokenFor = (id: string, role: 'professor' | 'student') =>
  jwt.sign({ sub: id, role }, config.jwtSecret, { expiresIn: '1h' })

/** A 4-digit code not currently in use, so "adopt a free code" is genuinely free. */
async function freeCode(): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const c = String(Math.floor(Math.random() * 10000)).padStart(4, '0')
    if (!(await prisma.question.findUnique({ where: { accessCode: c } }))) return c
  }
  throw new Error('No free access code available — the 4-digit namespace may be full')
}

const codeOf = async (id: string) =>
  (await prisma.question.findUniqueOrThrow({ where: { id }, select: { accessCode: true } })).accessCode

// ─── Fixture ──────────────────────────────────────────────────────────────────

async function createFixture() {
  const hash = await bcrypt.hash(`pw-${RUN_ID}`, 4)

  const professor = await prisma.professor.create({
    data: { email: `${TAG}@example.invalid`, name: `E2E ${RUN_ID}`, passwordHash: hash },
  })
  const student = await prisma.student.create({
    data: { netId: `${TAG}`, email: `${TAG}-s@example.invalid`, passwordHash: hash },
  })

  const cls = await prisma.class.create({
    data: { professorId: professor.id, name: `E2E Class ${RUN_ID}`, joinCode: `E2E${RUN_ID.slice(-5).toUpperCase()}` },
  })
  await prisma.enrollment.create({ data: { studentId: student.id, classId: cls.id } })

  // Two sessions of two questions, so duplication and rebind have something to match on.
  const sessions = []
  for (const [si, title] of [[0, 'Week 1 Opener'], [1, 'Week 2 Opener']] as const) {
    const session = await prisma.session.create({
      data: { classId: cls.id, title, accessCode: await freeCode(), status: 'DRAFT' },
    })
    for (let qi = 0; qi < 2; qi++) {
      await prisma.question.create({
        data: {
          sessionId: session.id,
          title: `S${si + 1} Q${qi + 1} title`,
          text: `Session ${si + 1} question ${qi + 1}: what is the rate-limiting step?`,
          type: 'FREE_TEXT',
          order: qi,
          accessCode: await freeCode(),
        },
      })
    }
    sessions.push(session)
  }

  return { professor, student, cls, sessions }
}

async function destroyFixture(professorId: string, studentId: string) {
  // Classes cascade from professor; responses/enrollments cascade from student.
  await prisma.professor.delete({ where: { id: professorId } }).catch(() => {})
  await prisma.student.delete({ where: { id: studentId } }).catch(() => {})
}

// ─── The test ─────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Pulse QR end-to-end test`)
  console.log(`  server : ${BASE}`)
  console.log(`  run id : ${RUN_ID}`)

  const health = await fetch(BASE).catch(() => null)
  if (!health) throw new Error(`No server at ${BASE}. Start one, or set E2E_BASE.`)

  const { professor, student, cls, sessions } = await createFixture()
  const pTok = tokenFor(professor.id, 'professor')
  const sTok = tokenFor(student.id, 'student')
  console.log(`  fixture: professor ${professor.id}, class ${cls.id}`)

  try {
    // ── 1. The QR encodes the access code, not the question id ────────────────
    section('1. QR URL shape')
    const detail = await http<any>('GET', `/api/sessions/${sessions[0].id}`, { token: pTok })
    check('session detail loads', detail.status === 200, `status ${detail.status}`)
    const q1 = detail.body?.data?.session?.questions?.[0]
    check('question has a qrDataUrl', !!q1?.qrDataUrl)

    const qr = await http<any>('GET', `/api/addin/questions/${q1.id}/qr`, { token: pTok })
    check('addin qr endpoint returns text for the card', typeof qr.body?.data?.text === 'string')
    check('addin qr endpoint returns the access code', qr.body?.data?.accessCode === q1.accessCode)

    // Decoding the PNG would need a QR reader; instead assert the two producers agree,
    // which is the invariant that actually broke before.
    check(
      'session view and addin agree on the QR image',
      qr.body?.data?.qrDataUrl === q1.qrDataUrl,
      'the two QR generators disagree again'
    )

    // ── 2. Student scan path ──────────────────────────────────────────────────
    section('2. Student scan-to-answer path')
    let byCode = await http<any>('GET', `/api/questions/by-code/${q1.accessCode}`, { token: sTok })
    check('closed session rejects the scan', byCode.status !== 200, `status ${byCode.status}`)

    const run = await http<any>('POST', `/api/sessions/${sessions[0].id}/runs`, { token: pTok, body: {} })
    check('run opens', run.status === 201 || run.status === 200, `status ${run.status}`)

    byCode = await http<any>('GET', `/api/questions/by-code/${q1.accessCode}`, { token: sTok })
    check('open session accepts the scan', byCode.status === 200, `status ${byCode.status}`)
    check('scan resolves to the right question', byCode.body?.data?.questionId === q1.id)

    const submit = await http<any>('POST', `/api/responses`, {
      token: sTok,
      body: { questionId: q1.id, responseText: 'e2e answer' },
    })
    check('student can submit', submit.status === 201 || submit.status === 200, `status ${submit.status}`)

    const runId = run.body?.data?.run?.id
    if (runId) await http('PATCH', `/api/sessions/${sessions[0].id}/runs/${runId}`, { token: pTok, body: { status: 'CLOSED' } })

    // ── 3. Add-in verify ──────────────────────────────────────────────────────
    section('3. Add-in verify')
    const allCodes = await prisma.question.findMany({
      where: { session: { classId: cls.id } },
      select: { id: true, accessCode: true },
      orderBy: { accessCode: 'asc' },
    })
    const verify = await http<any>('POST', '/api/addin/verify', {
      token: pTok,
      body: { codes: [...allCodes.map((q) => q.accessCode), '0000zz-nope'] },
    })
    check('verify responds', verify.status === 200, `status ${verify.status}`)
    const results: any[] = verify.body?.data?.results ?? []
    check('every real code resolves', allCodes.every((q) => results.find((r) => r.code === q.accessCode)?.status === 'ok'))
    check('unknown code reports not_found', results.find((r) => r.code === '0000zz-nope')?.status === 'not_found')
    check('verify names the owning class', results.find((r) => r.status === 'ok')?.class?.id === cls.id)

    // ── 4. Adopt a free code ──────────────────────────────────────────────────
    section('4. Adopt a free code (deck keeps its image)')
    const target = allCodes[0]
    const oldCode = await codeOf(target.id)
    const wanted = await freeCode()
    const qrBefore = (await http<any>('GET', `/api/addin/questions/${target.id}/qr`, { token: pTok }))
      .body?.data?.qrDataUrl
    const adopt1 = await http<any>('POST', '/api/addin/adopt-code', {
      token: pTok,
      body: { questionId: target.id, code: wanted },
    })
    check('adopt succeeds', adopt1.status === 200, `status ${adopt1.status} ${JSON.stringify(adopt1.body)}`)
    check('question now holds the wanted code', (await codeOf(target.id)) === wanted)
    const oldNow = await prisma.question.findUnique({ where: { accessCode: oldCode } })
    check('the vacated code is released', oldNow === null)

    // The QR must encode the access code, not the question id. Asserting only that the
    // two producers agree would not catch both of them regressing to an id-based URL;
    // an id-based QR would be byte-identical after the code changed.
    const qrAfter = (await http<any>('GET', `/api/addin/questions/${target.id}/qr`, { token: pTok }))
      .body?.data?.qrDataUrl
    check('the QR image changes when the code changes', !!qrBefore && qrBefore !== qrAfter,
      'QR appears to encode the question id rather than the access code')

    // ── 5. Adopt a code held by one of your own questions (the swap) ──────────
    section('5. Adopt a colliding code (swap)')
    const a = allCodes[0]
    const b = allCodes[1]
    const aBefore = await codeOf(a.id)
    const bBefore = await codeOf(b.id)
    const adopt2 = await http<any>('POST', '/api/addin/adopt-code', {
      token: pTok,
      body: { questionId: a.id, code: bBefore },
    })
    check('swap succeeds', adopt2.status === 200, `status ${adopt2.status} ${JSON.stringify(adopt2.body)}`)
    const aAfter = await codeOf(a.id)
    const bAfter = await codeOf(b.id)
    check('target took the requested code', aAfter === bBefore)
    check('holder received the target\'s old code', bAfter === aBefore)
    check('no code was orphaned', aAfter !== bAfter)
    const stillResolve = await http<any>('POST', '/api/addin/verify', {
      token: pTok, body: { codes: [aAfter, bAfter] },
    })
    check('both codes still resolve after the swap',
      (stillResolve.body?.data?.results ?? []).every((r: any) => r.status === 'ok'))

    // ── 6. Ownership boundary — must not steal another professor's code ───────
    section('6. Ownership boundary (touches real data, read-only)')
    const foreign = await prisma.question.findFirst({
      where: { NOT: { OR: [
        { session: { class: { professorId: professor.id } } },
        { assignment: { class: { professorId: professor.id } } },
      ] } },
      select: { id: true, accessCode: true, text: true, title: true },
    })
    if (!foreign) {
      console.log('  SKIP  no other professor\'s questions exist in this database')
    } else {
      const steal = await http<any>('POST', '/api/addin/adopt-code', {
        token: pTok,
        body: { questionId: a.id, code: foreign.accessCode },
      })
      check('stealing another professor\'s code is refused', steal.status === 409, `status ${steal.status}`)
      const foreignAfter = await prisma.question.findUnique({
        where: { id: foreign.id }, select: { accessCode: true, text: true, title: true },
      })
      check('the other professor\'s code is untouched', foreignAfter?.accessCode === foreign.accessCode)
      check('the other professor\'s question is untouched',
        foreignAfter?.text === foreign.text && foreignAfter?.title === foreign.title)

      const leak = await http<any>('POST', '/api/addin/verify', {
        token: pTok, body: { codes: [foreign.accessCode] },
      })
      check('verify does not leak another professor\'s question',
        leak.body?.data?.results?.[0]?.status === 'not_found')
    }

    // ── 7. Duplication and printed-slide continuity ───────────────────────────
    section('7. Class duplication with QR transfer')
    const preCodes = await prisma.question.findMany({
      where: { session: { classId: cls.id } },
      select: { id: true, accessCode: true, order: true, session: { select: { title: true } } },
    })
    const dup = await http<any>('POST', `/api/classes/${cls.id}/duplicate`, {
      token: pTok,
      body: { name: `E2E Dup ${RUN_ID}`, transferQrCodes: true },
    })
    check('duplicate succeeds', dup.status === 201, `status ${dup.status} ${JSON.stringify(dup.body)}`)
    const newClassId = dup.body?.data?.class?.id

    const dupQuestions = await prisma.question.findMany({
      where: { session: { classId: newClassId } },
      select: { id: true, accessCode: true, order: true, title: true, tolerance: true, unit: true, session: { select: { title: true } } },
    })
    check('duplicate has the same number of questions', dupQuestions.length === preCodes.length,
      `${dupQuestions.length} vs ${preCodes.length}`)
    check('question titles carried over', dupQuestions.every((q) => !!q.title))

    // The point of transferQrCodes: a slide printed for the old class now resolves to
    // the new class's equivalent question.
    const movedCorrectly = preCodes.every((old) => {
      const holder = dupQuestions.find((q) => q.accessCode === old.accessCode)
      return holder && holder.order === old.order && holder.session.title === old.session.title
    })
    check('printed codes now point at the new class\'s matching questions', movedCorrectly)

    const sourceAfter = await prisma.question.findMany({
      where: { session: { classId: cls.id } }, select: { accessCode: true },
    })
    check('source questions all received fresh codes',
      sourceAfter.every((q) => !preCodes.some((p) => p.accessCode === q.accessCode)))
    check('no duplicate codes across the two classes',
      new Set([...sourceAfter, ...dupQuestions].map((q) => q.accessCode)).size ===
        sourceAfter.length + dupQuestions.length)

    // Assignments and textbook are covered by the duplication commit; assert the
    // question-side invariants that QR continuity depends on.
    const dupSessions = await prisma.session.findMany({
      where: { classId: newClassId }, select: { title: true },
    })
    check('all sessions duplicated', dupSessions.length === sessions.length)

    // ── 8. Rebind proposal ────────────────────────────────────────────────────
    section('8. Rebind proposal (read-only)')
    const beforeRebind = await prisma.question.findMany({
      where: { session: { classId: cls.id } }, select: { id: true, accessCode: true },
    })
    const rebind = await http<any>('POST', '/api/addin/rebind', {
      token: pTok, body: { fromClassId: cls.id, toClassId: newClassId },
    })
    check('rebind responds', rebind.status === 200, `status ${rebind.status}`)
    check('every question is matched', rebind.body?.data?.unmatched === 0,
      `unmatched=${rebind.body?.data?.unmatched}`)
    check('mapping count equals question count',
      (rebind.body?.data?.mappings ?? []).length === beforeRebind.length)
    const afterRebind = await prisma.question.findMany({
      where: { session: { classId: cls.id } }, select: { id: true, accessCode: true },
    })
    check('rebind mutated nothing',
      JSON.stringify(beforeRebind) === JSON.stringify(afterRebind))

    // ── 9. Namespace sanity ───────────────────────────────────────────────────
    section('9. Access code namespace')
    const total = await prisma.question.count()
    const distinct = (await prisma.question.findMany({ select: { accessCode: true } }))
    check('all access codes are unique', new Set(distinct.map((d) => d.accessCode)).size === distinct.length)
    check('all access codes are 4 digits', distinct.every((d) => /^\d{4}$/.test(d.accessCode)))
    console.log(`  INFO  ${total} questions using ${((total / 10000) * 100).toFixed(1)}% of the 4-digit namespace`)
    // ── 10. Projected live results ────────────────────────────────────────────
    section('10. Projected live results (/addin/live)')

    // Nothing open: the slide should be told so explicitly, not handed stale data.
    let live = await http<any>('GET', '/api/addin/live', { token: pTok })
    check('reports no session when nothing is open', live.status === 200 && live.body?.data?.session === null,
      `status ${live.status}`)

    const liveRun = await http<any>('POST', `/api/sessions/${sessions[1].id}/runs`, { token: pTok, body: {} })
    check('run opens for the live test', liveRun.status === 201 || liveRun.status === 200)

    const liveQs = await prisma.question.findMany({
      where: { sessionId: sessions[1].id }, orderBy: { order: 'asc' }, select: { id: true },
    })
    await http('POST', '/api/responses', {
      token: sTok, body: { questionId: liveQs[1].id, responseText: 'projected answer' },
    })

    live = await http<any>('GET', '/api/addin/live', { token: pTok })
    check('returns the open session', live.body?.data?.session?.id === sessions[1].id)
    check('carries the enrolled count for the participation bar',
      typeof live.body?.data?.session?.enrolledCount === 'number')
    check('follows the question that was just answered',
      live.body?.data?.activeQuestionId === liveQs[1].id,
      `got ${live.body?.data?.activeQuestionId}`)

    // The whole point of stripping identity server-side: this payload is projected in a
    // lecture hall, so a rendering bug must not be able to expose who answered.
    const payload = JSON.stringify(live.body)
    check('payload contains no netId', !payload.includes('netId'))
    check('payload contains no studentId', !payload.includes('studentId'))
    check('payload contains no student object', !/"student"\s*:/.test(payload))

    // Free text is quasi-identifying even without a netID — "as I said in office hours"
    // names someone. The projector needs counts and categories, never the words.
    check('payload contains no responseText for free text', !payload.includes('responseText'))
    check('payload does not contain the submitted answer', !payload.includes('projected answer'))

    // Themes are off by default, and "off" must be distinguishable from "not started".
    const liveQ = live.body?.data?.session?.questions?.find((q: any) => q.id === liveQs[1].id)
    check('themes are null while theming is off', liveQ?.themes === null, `got ${JSON.stringify(liveQ?.themes)}`)

    // Turn it on and the shape appears — still with nothing identifying in it. Stays
    // below the bootstrap threshold on purpose, so this suite never calls an LLM.
    const enable = await http<any>('PATCH', `/api/sessions/${sessions[1].id}/questions/${liveQs[1].id}`, {
      token: pTok, body: { liveThemes: true },
    })
    check('theming can be switched on mid-run', enable.status === 200, `status ${enable.status}`)

    live = await http<any>('GET', '/api/addin/live', { token: pTok })
    const themed = live.body?.data?.session?.questions?.find((q: any) => q.id === liveQs[1].id)
    check('themes report progress before the threshold', themed?.themes?.status === 'WAITING',
      `status ${themed?.themes?.status}`)
    check('themes say how many answers are still needed', typeof themed?.themes?.need === 'number')
    const themedPayload = JSON.stringify(live.body)
    check('themed payload still contains no identity', !themedPayload.includes('netId') && !themedPayload.includes('studentId'))
    check('themes carry no per-response detail', !themedPayload.includes('responseId'))

    const liveRunId = liveRun.body?.data?.run?.id

    // ── Themes belong to a run, not a question ────────────────────────────────
    // Re-teaching a session must start from a clean set rather than inheriting last
    // time's categories. Seeded directly rather than derived, so this suite stays
    // LLM-free — what is under test is the keying, not the clustering.
    if (liveRunId) {
      const seeded = await prisma.themeSet.create({
        data: {
          questionId: liveQs[1].id,
          runId: liveRunId,
          status: 'ACTIVE',
          model: 'seeded-by-e2e',
          bootstrapN: 1,
          categories: {
            create: [
              { label: 'Seeded theme', description: 'Planted by the e2e suite', order: 0 },
              { label: 'Still forming', description: 'Planted by the e2e suite', order: 1, isOther: true },
            ],
          },
        },
        include: { categories: true },
      })

      live = await http<any>('GET', '/api/addin/live', { token: pTok })
      const seenNow = live.body?.data?.session?.questions?.find((q: any) => q.id === liveQs[1].id)
      check('the run’s own theme set is reported', seenNow?.themes?.categories?.length === 2,
        `got ${seenNow?.themes?.categories?.length} categories`)

      // Close this run and open a fresh one over the same question.
      await http('PATCH', `/api/sessions/${sessions[1].id}/runs/${liveRunId}`, { token: pTok, body: { status: 'CLOSED' } })
      live = await http<any>('GET', '/api/addin/live', { token: pTok })
      check('stops reporting a session once the run closes', live.body?.data?.session === null)

      const secondRun = await http<any>('POST', `/api/sessions/${sessions[1].id}/runs`, { token: pTok, body: {} })
      check('a second run opens over the same question', secondRun.status === 201 || secondRun.status === 200)

      live = await http<any>('GET', '/api/addin/live', { token: pTok })
      const fresh = live.body?.data?.session?.questions?.find((q: any) => q.id === liveQs[1].id)
      check(
        'a second run starts with a clean theme set',
        fresh?.themes?.status === 'WAITING' && (fresh?.themes?.categories?.length ?? 0) === 0,
        `status ${fresh?.themes?.status}, ${fresh?.themes?.categories?.length ?? 0} categories carried over`
      )
      check('the first run keeps its own themes', 
        (await prisma.themeSet.count({ where: { id: seeded.id } })) === 1)

      const secondRunId = secondRun.body?.data?.run?.id
      if (secondRunId) {
        await http('PATCH', `/api/sessions/${sessions[1].id}/runs/${secondRunId}`, { token: pTok, body: { status: 'CLOSED' } })
      }
    }

  } finally {
    section('Cleanup')
    await destroyFixture(professor.id, student.id)
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
