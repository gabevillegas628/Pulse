/**
 * Smoke test for who is allowed into a session's professor room.
 *
 * The `{sessionId}:professor` room carries student netIDs and answer text as
 * answers land. Joining it used to require only that the JWT said "professor",
 * which is indistinguishable from correct while one professor account exists and
 * is a live feed of somebody else's lecture the moment a second one does.
 *
 * Two professors, one session. A owns it, B does not, and B is a real registered
 * professor with a class of their own — the point is that authentication was
 * never the missing piece. Each is asserted twice over:
 *
 *   1. The join acknowledgement, which reports the room decision directly.
 *   2. What actually arrives on the socket when a student answers, which is the
 *      thing that matters and does not take the ack's word for it.
 *
 * Usage:
 *   npx tsx scripts/smoke-socket-auth.ts
 *   E2E_BASE=http://localhost:3010 npx tsx scripts/smoke-socket-auth.ts
 *
 * Requires a server pointed at the same database this script connects to, and
 * cleans up everything it creates.
 */

import 'dotenv/config'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { io as connect, Socket } from 'socket.io-client'
import { prisma } from '../src/db/index.js'
import { config } from '../src/config/index.js'

const BASE = process.env.E2E_BASE ?? 'http://localhost:3001'
const RUN_ID = Date.now().toString(36)
const TAG = `smoke-sock-${RUN_ID}`

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const tokenFor = (id: string, role: 'professor' | 'student') =>
  jwt.sign({ sub: id, role }, config.jwtSecret, { expiresIn: '1h' })

async function freeCode(): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const c = String(Math.floor(Math.random() * 10000)).padStart(4, '0')
    if (!(await prisma.question.findUnique({ where: { accessCode: c } }))) return c
  }
  throw new Error('No free access code available — the 4-digit namespace may be full')
}

async function answer(studentId: string, questionId: string, text: string) {
  return fetch(`${BASE}/api/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tokenFor(studentId, 'student')}`,
    },
    body: JSON.stringify({ questionId, responseText: text }),
  })
}

// ─── Socket helpers ───────────────────────────────────────────────────────────

/** Connect as one identity, failing loudly rather than hanging if it cannot. */
function open(token: string): Promise<Socket> {
  const socket = connect(BASE, { auth: { token }, transports: ['websocket'], reconnection: false })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket did not connect within 5s')), 5_000)
    socket.on('connect', () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.on('connect_error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

/** Join, and report back what the server decided about the professor room. */
function join(socket: Socket, sessionId: string): Promise<{ professor: boolean }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('join was not acknowledged within 5s')), 5_000)
    socket.emit('join_session', sessionId, (result: { professor: boolean }) => {
      clearTimeout(timer)
      resolve(result)
    })
  })
}

/**
 * Collect every new_response this socket sees from now on.
 *
 * A recorder rather than a one-shot wait, because the two halves need opposite
 * things: showing the owner received the event needs something to wait for,
 * showing the stranger did not needs a window that closes. Both read the same
 * list at the end.
 */
function record(socket: Socket): { seen: unknown[] } {
  const box: { seen: unknown[] } = { seen: [] }
  socket.on('new_response', (payload: unknown) => box.seen.push(payload))
  return box
}

// ─── Fixture ──────────────────────────────────────────────────────────────────

async function createFixture() {
  const hash = await bcrypt.hash(`pw-${RUN_ID}`, 4)

  const owner = await prisma.professor.create({
    data: {
      email: `${TAG}-owner@example.invalid`,
      name: `Smoke Sock Owner ${RUN_ID}`,
      passwordHash: hash,
    },
  })
  const stranger = await prisma.professor.create({
    data: {
      email: `${TAG}-stranger@example.invalid`,
      name: `Smoke Sock Stranger ${RUN_ID}`,
      passwordHash: hash,
    },
  })

  const cls = await prisma.class.create({
    data: {
      professorId: owner.id,
      name: `Smoke Sock Class ${RUN_ID}`,
      joinCode: `SK${RUN_ID.slice(-6).toUpperCase()}`,
    },
  })

  // The stranger owns a class of their own, so they are a working professor
  // rather than an empty account that might be refused for the wrong reason.
  await prisma.class.create({
    data: {
      professorId: stranger.id,
      name: `Smoke Sock Other Class ${RUN_ID}`,
      joinCode: `SO${RUN_ID.slice(-6).toUpperCase()}`,
    },
  })

  const session = await prisma.session.create({
    data: {
      classId: cls.id,
      title: `Smoke Sock Session ${RUN_ID}`,
      accessCode: await freeCode(),
      status: 'OPEN',
    },
  })
  const question = await prisma.question.create({
    data: {
      sessionId: session.id,
      text: 'Name one product of the pentose phosphate pathway.',
      type: 'FREE_TEXT',
      order: 0,
      accessCode: await freeCode(),
      // Off, so nothing closes the question underneath the assertions.
      autoClose: false,
    },
  })
  await prisma.sessionRun.create({ data: { sessionId: session.id, status: 'OPEN' } })

  const student = await prisma.student.create({
    data: { netId: `${TAG}-s1`, email: `${TAG}-s1@example.invalid`, passwordHash: hash },
  })
  await prisma.enrollment.create({ data: { studentId: student.id, classId: cls.id } })

  const second = await prisma.student.create({
    data: { netId: `${TAG}-s2`, email: `${TAG}-s2@example.invalid`, passwordHash: hash },
  })
  await prisma.enrollment.create({ data: { studentId: second.id, classId: cls.id } })

  return { owner, stranger, cls, session, question, student, second }
}

async function destroyFixture(professorIds: string[], studentIds: string[]) {
  // Classes first: professor deletion is Restrict-ed while any remain.
  await prisma.class.deleteMany({ where: { professorId: { in: professorIds } } }).catch(() => {})
  for (const id of professorIds) {
    await prisma.professor.delete({ where: { id } }).catch(() => {})
  }
  for (const id of studentIds) {
    await prisma.student.delete({ where: { id } }).catch(() => {})
  }
}

// ─── Run ──────────────────────────────────────────────────────────────────────

async function main() {
  const ping = await fetch(`${BASE}/health`).catch(() => null)
  if (!ping || ping.status >= 500) {
    console.log(`\n  No server at ${BASE} — this suite is entirely integration, so`)
    console.log('  there is nothing it can check alone. Start the backend and re-run.')
    await prisma.$disconnect()
    process.exit(1)
  }

  let fixture: Awaited<ReturnType<typeof createFixture>> | null = null
  const sockets: Socket[] = []

  try {
    fixture = await createFixture()
    const { owner, stranger, session, question, student, second } = fixture

    const ownerSock = await open(tokenFor(owner.id, 'professor'))
    const strangerSock = await open(tokenFor(stranger.id, 'professor'))
    const studentSock = await open(tokenFor(student.id, 'student'))
    sockets.push(ownerSock, strangerSock, studentSock)

    section('The room decision, as the server reports it')

    const ownerJoin = await join(ownerSock, session.id)
    check('the owning professor is admitted to the professor room',
      ownerJoin.professor === true, `ack said ${JSON.stringify(ownerJoin)}`)

    const strangerJoin = await join(strangerSock, session.id)
    check('another professor is refused the professor room',
      strangerJoin.professor === false, `ack said ${JSON.stringify(strangerJoin)}`)

    const studentJoin = await join(studentSock, session.id)
    check('a student is refused the professor room',
      studentJoin.professor === false, `ack said ${JSON.stringify(studentJoin)}`)

    section('What actually arrives when a student answers')

    const ownerSaw = record(ownerSock)
    const strangerSaw = record(strangerSock)
    const studentSaw = record(studentSock)

    const res = await answer(student.id, question.id, 'NADPH')
    check('the answer was accepted', res.status === 200 || res.status === 201, `status ${res.status}`)

    // Long enough that an event which was going to arrive has. The acks above are
    // the deterministic half; this half does not trust them.
    await sleep(750)

    check('the owning professor received the answer',
      ownerSaw.seen.length === 1, `saw ${ownerSaw.seen.length}`)
    check('another professor received nothing',
      strangerSaw.seen.length === 0, `saw ${strangerSaw.seen.length} — this is the leak`)
    check('the student received nothing',
      studentSaw.seen.length === 0, `saw ${studentSaw.seen.length}`)

    section('Leaving')

    ownerSock.emit('leave_session', session.id)
    await sleep(250)
    const afterLeave = record(ownerSock)

    await answer(second.id, question.id, 'ribose-5-phosphate')
    await sleep(750)

    check('a professor who left stops receiving answers',
      afterLeave.seen.length === 0, `saw ${afterLeave.seen.length}`)
  } finally {
    section('Cleanup')
    for (const s of sockets) s.disconnect()
    if (fixture) {
      await destroyFixture(
        [fixture.owner.id, fixture.stranger.id],
        [fixture.student.id, fixture.second.id]
      )
    }
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
