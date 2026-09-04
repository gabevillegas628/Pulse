/**
 * Smoke test for the student "forgot password" flow.
 *
 * What is under test is the token, not the mail. Requesting a link is exercised over
 * HTTP — that is where the enumeration and throttling properties live — but the token
 * itself is minted straight into the database for the redemption tests, because the
 * real one leaves only in an email and this script cannot read the inbox. The one
 * thing that stays uncovered, then, is Brevo actually delivering; run the flow by hand
 * once against a real key before a term starts.
 *
 * The properties worth proving:
 *   - a request for an account that does not exist is indistinguishable from one that does
 *   - the raw token is never what is stored
 *   - a link works exactly once, and redeeming it kills the others
 *   - an expired link is refused
 *   - a reset clears the sign-in lockout that sent the student here in the first place
 *
 * Usage:
 *   npx tsx scripts/smoke-password-reset.ts
 *   E2E_BASE=http://localhost:3010 npx tsx scripts/smoke-password-reset.ts
 *
 * Requires a server pointed at the same database this script connects to. Note the
 * per-address reset limit is 20 an hour: two full runs from one machine inside an hour
 * will trip it, and the failures will be 429s rather than real regressions.
 */

import 'dotenv/config'
import crypto from 'crypto'
import bcrypt from 'bcryptjs'
import { prisma } from '../src/db/index.js'

const BASE = process.env.E2E_BASE ?? 'http://localhost:3001'
const RUN_ID = Date.now().toString(36)
const NETID = `pwr${RUN_ID.slice(-6)}`
const EMAIL = `${NETID}@rutgers.edu`
const OLD_PASSWORD = 'old-password-123'
const NEW_PASSWORD = 'new-password-456'

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

async function call(path: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => null)
  return {
    status: res.status,
    json: json as { success?: boolean; data?: Record<string, unknown>; error?: string } | null,
  }
}

const hashToken = (t: string) => crypto.createHash('sha256').update(t).digest('hex')

/** Mint a live token directly, standing in for the one that leaves by email. */
async function mintToken(studentId: string, minutesFromNow = 60) {
  const token = crypto.randomBytes(32).toString('base64url')
  await prisma.passwordResetToken.create({
    data: {
      studentId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + minutesFromNow * 60 * 1000),
    },
  })
  return token
}

async function main() {
  let studentId: string | null = null

  try {
    section('Fixture')
    const student = await prisma.student.create({
      data: { netId: NETID, email: EMAIL, passwordHash: await bcrypt.hash(OLD_PASSWORD, 12) },
    })
    studentId = student.id
    console.log(`  student ${NETID}`)

    section('Requesting a link')

    const before = await prisma.passwordResetToken.count({ where: { studentId } })
    const real = await call('/api/auth/student/forgot-password', { credential: NETID })
    check('a request for a real account is accepted', real.status === 200, `status ${real.status}`)

    // The send is fire-and-forget so the response time cannot be used to tell accounts
    // apart; the row it writes therefore lands just after the reply.
    await new Promise((r) => setTimeout(r, 500))
    const after = await prisma.passwordResetToken.count({ where: { studentId } })
    check('it mints exactly one token', after === before + 1, `${before} -> ${after}`)

    const stored = await prisma.passwordResetToken.findFirst({
      where: { studentId },
      orderBy: { createdAt: 'desc' },
    })
    check(
      'the stored value is a SHA-256, not the token',
      !!stored && /^[0-9a-f]{64}$/.test(stored.tokenHash),
      stored ? `tokenHash length ${stored.tokenHash.length}` : 'no row'
    )

    const ghost = await call('/api/auth/student/forgot-password', { credential: `nobody${RUN_ID}` })
    check('an unknown account gets the same status', ghost.status === real.status, `status ${ghost.status}`)
    check(
      'an unknown account gets the same body',
      JSON.stringify(ghost.json) === JSON.stringify(real.json),
      JSON.stringify(ghost.json)
    )

    const byEmail = await call('/api/auth/student/forgot-password', { credential: EMAIL })
    check('an email address works as the credential too', byEmail.status === 200, `status ${byEmail.status}`)

    section('Redeeming a link')

    await prisma.passwordResetToken.deleteMany({ where: { studentId } })
    const token = await mintToken(studentId)
    const spare = await mintToken(studentId)

    const verify = await call('/api/auth/student/reset-password/verify', { token })
    check(
      'a live link verifies and names its account',
      verify.status === 200 && verify.json?.data?.netId === NETID,
      `status ${verify.status}, netId ${String(verify.json?.data?.netId)}`
    )

    const stillUnused = await prisma.passwordResetToken.findFirst({
      where: { tokenHash: hashToken(token) },
    })
    check('verifying does not spend the link', stillUnused?.usedAt === null)

    const reset = await call('/api/auth/student/reset-password', { token, newPassword: NEW_PASSWORD })
    check('the link sets the new password', reset.status === 200, `status ${reset.status} ${reset.json?.error ?? ''}`)

    const newLogin = await call('/api/auth/student/login', { credential: NETID, password: NEW_PASSWORD })
    check('the new password signs in', newLogin.status === 200, `status ${newLogin.status}`)

    const oldLogin = await call('/api/auth/student/login', { credential: NETID, password: OLD_PASSWORD })
    check('the old password no longer does', oldLogin.status === 401, `status ${oldLogin.status}`)

    const replay = await call('/api/auth/student/reset-password', { token, newPassword: 'third-password-789' })
    check('the same link cannot be used twice', replay.status === 400, `status ${replay.status}`)

    const spareCheck = await call('/api/auth/student/reset-password/verify', { token: spare })
    check('every other outstanding link died with it', spareCheck.status === 400, `status ${spareCheck.status}`)

    section('Links that should not work')

    const expired = await mintToken(studentId, -5)
    const expiredCheck = await call('/api/auth/student/reset-password/verify', { token: expired })
    check('an expired link is refused', expiredCheck.status === 400, `status ${expiredCheck.status}`)

    const garbage = await call('/api/auth/student/reset-password/verify', { token: 'not-a-real-token' })
    check('an invented token is refused', garbage.status === 400, `status ${garbage.status}`)

    const short = await call('/api/auth/student/reset-password', {
      token: await mintToken(studentId),
      newPassword: 'short',
    })
    check('a password under 8 characters is refused', short.status === 400, `status ${short.status}`)

    section('The lockout a reset exists to undo')

    // Ten failures is the sign-in limit; the eleventh is the 429 that sends a student
    // looking for this feature in the first place.
    for (let i = 0; i < 10; i++) {
      await call('/api/auth/student/login', { credential: NETID, password: 'wrong-on-purpose' })
    }
    const locked = await call('/api/auth/student/login', { credential: NETID, password: NEW_PASSWORD })
    check('the account is locked out after ten failures', locked.status === 429, `status ${locked.status}`)

    const rescue = await mintToken(studentId)
    const rescued = await call('/api/auth/student/reset-password', { token: rescue, newPassword: OLD_PASSWORD })
    check('the reset itself succeeds while locked out', rescued.status === 200, `status ${rescued.status}`)

    const afterReset = await call('/api/auth/student/login', { credential: NETID, password: OLD_PASSWORD })
    check(
      'and the new password signs in immediately, not in fifteen minutes',
      afterReset.status === 200,
      `status ${afterReset.status}`
    )

    section('Request throttling')

    // Three an hour per account, and this account has already spent two above, so one
    // of the next three must be refused.
    const codes: number[] = []
    for (let i = 0; i < 3; i++) {
      codes.push((await call('/api/auth/student/forgot-password', { credential: NETID })).status)
    }
    check('a fourth request in the hour is throttled', codes.includes(429), `statuses ${codes.join(',')}`)
  } finally {
    section('Cleanup')
    if (studentId) {
      // Tokens cascade, but deleted explicitly so a failure here is legible.
      await prisma.passwordResetToken.deleteMany({ where: { studentId } })
      await prisma.student.delete({ where: { id: studentId } }).catch(() => {})
    }
    const leftover = await prisma.student.count({ where: { netId: NETID } })
    check('fixture removed', leftover === 0, `${leftover} students remain`)
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
