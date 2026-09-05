/**
 * Smoke test for the admin surface: the door, the system view, account
 * creation, transfer, and deactivation.
 *
 * The design under test is that admin power exists only under /api/admin.
 * Ownership predicates were not widened — an admin in the normal professor UI
 * is just a professor — so what needs proving is the other direction: that the
 * admin routes refuse everyone who is not an admin, that the system view really
 * does see across accounts (the forgotten-account problem), and that
 * deactivation kills both login and every outstanding token without touching
 * the rows underneath.
 *
 * Three professors: an admin, B (owns a class with students and answers), and
 * C (empty account, transfer target). Deactivation is asserted from B's side —
 * the token that worked a moment ago answers 401 on the next request.
 *
 * Usage:
 *   npx tsx scripts/smoke-admin.ts
 *   E2E_BASE=http://localhost:3010 npx tsx scripts/smoke-admin.ts
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
const TAG = `smoke-admin-${RUN_ID}`

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

async function freeCode(): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const c = String(Math.floor(Math.random() * 10000)).padStart(4, '0')
    if (!(await prisma.question.findUnique({ where: { accessCode: c } }))) return c
  }
  throw new Error('No free access code available — the 4-digit namespace may be full')
}

/** One call, returning status and parsed body together so a check can name both. */
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

// ─── Fixture ──────────────────────────────────────────────────────────────────

const TEMP_PASSWORD = `pw-${RUN_ID}-x`

async function createFixture() {
  const hash = await bcrypt.hash(TEMP_PASSWORD, 4)

  const admin = await prisma.professor.create({
    data: { email: `${TAG}-admin@example.invalid`, name: `Smoke Admin ${RUN_ID}`, passwordHash: hash, isAdmin: true },
  })
  const profB = await prisma.professor.create({
    data: { email: `${TAG}-b@example.invalid`, name: `Smoke Prof B ${RUN_ID}`, passwordHash: hash },
  })
  const profC = await prisma.professor.create({
    data: { email: `${TAG}-c@example.invalid`, name: `Smoke Prof C ${RUN_ID}`, passwordHash: hash },
  })

  // B's class is the forgotten-account shape in miniature: enrollments and
  // submitted answers that no other professor's screen would ever show.
  const cls = await prisma.class.create({
    data: { professorId: profB.id, name: `Smoke Admin Class ${RUN_ID}`, joinCode: `AD${RUN_ID.slice(-6).toUpperCase()}` },
  })
  const session = await prisma.session.create({
    data: { classId: cls.id, title: `Smoke Admin Session ${RUN_ID}`, accessCode: await freeCode(), status: 'OPEN' },
  })
  const question = await prisma.question.create({
    data: {
      sessionId: session.id,
      text: 'Which enzyme opens glycolysis?',
      type: 'FREE_TEXT',
      order: 0,
      accessCode: await freeCode(),
      autoClose: false,
    },
  })

  const s1 = await prisma.student.create({
    data: { netId: `${TAG}-s1`, email: `${TAG}-s1@example.invalid`, passwordHash: hash },
  })
  const s2 = await prisma.student.create({
    data: { netId: `${TAG}-s2`, email: `${TAG}-s2@example.invalid`, passwordHash: hash },
  })
  await prisma.enrollment.create({ data: { studentId: s1.id, classId: cls.id } })
  await prisma.enrollment.create({ data: { studentId: s2.id, classId: cls.id } })

  // One submitted answer and one draft: the system view reports answers, so the
  // draft must not count.
  await prisma.response.create({
    data: { questionId: question.id, studentId: s1.id, responseText: 'hexokinase', wordCount: 1, isDraft: false },
  })
  await prisma.response.create({
    data: { questionId: question.id, studentId: s2.id, responseText: 'hexo', wordCount: 1, isDraft: true },
  })

  return { admin, profB, profC, cls, session, question, s1, s2 }
}

async function destroyFixture(professorIds: string[], studentIds: string[], extraEmails: string[]) {
  // Classes first: professor deletion is Restrict-ed while any remain — the
  // very constraint this suite's admin surface exists to respect.
  await prisma.class.deleteMany({ where: { professorId: { in: professorIds } } }).catch(() => {})
  for (const id of professorIds) {
    await prisma.professor.delete({ where: { id } }).catch(() => {})
  }
  for (const email of extraEmails) {
    await prisma.professor.delete({ where: { email } }).catch(() => {})
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
  const createdEmail = `${TAG}-new@scarletmail.rutgers.edu`

  try {
    fixture = await createFixture()
    const { admin, profB, profC, cls } = fixture
    const adminToken = tokenFor(admin.id, 'professor')
    const bToken = tokenFor(profB.id, 'professor')
    const cToken = tokenFor(profC.id, 'professor')

    section('The door')

    const noToken = await call('GET', '/api/admin/professors', null)
    check('no token is refused with 401', noToken.status === 401, `status ${noToken.status}`)

    const asB = await call('GET', '/api/admin/professors', bToken)
    check('a non-admin professor is refused with 403 — authenticated, not theirs',
      asB.status === 403, `status ${asB.status}`)

    const asStudent = await call('GET', '/api/admin/professors', tokenFor(fixture.s1.id, 'student'))
    check('a student token is refused with 401', asStudent.status === 401, `status ${asStudent.status}`)

    section('The system view')

    const view = await call('GET', '/api/admin/professors', adminToken)
    check('an admin is admitted', view.status === 200, `status ${view.status}`)

    const rows: any[] = view.json?.data?.professors ?? []
    const byEmail = new Map(rows.map((r) => [r.email, r]))
    check('the view lists every account, not a filter anyone owns',
      byEmail.has(admin.email) && byEmail.has(profB.email) && byEmail.has(profC.email),
      `found ${rows.length} professors, fixture accounts missing`)

    const bRow = byEmail.get(profB.email)
    const bClass = bRow?.classes?.find((c: any) => c.id === cls.id)
    check("B's class is visible under B", Boolean(bClass), 'class not in view')
    check('enrollment count is right', bClass?.enrollmentCount === 2, `got ${bClass?.enrollmentCount}`)
    check('answer count excludes the draft', bClass?.responseCount === 1, `got ${bClass?.responseCount}`)
    check('last answer time is reported', Boolean(bClass?.lastResponseAt), 'lastResponseAt missing')
    check('an empty account shows empty, not absent',
      byEmail.get(profC.email)?.classes?.length === 0,
      `C has ${byEmail.get(profC.email)?.classes?.length} classes`)

    section('The constraint')

    // Not an HTTP check — no route deletes a professor, which is the point. The
    // guard exists for raw SQL and scripts, so it is asserted at that level: the
    // database itself must refuse while classes remain. Asserted on outcome, not
    // on Prisma's error code — a stale generated client surfaces the same 23001
    // as a codeless ConnectorError, and what matters is that the row survived.
    const rawDelete = await prisma.professor.delete({ where: { id: profB.id } }).then(() => null, (e) => e)
    const survivor = await prisma.professor.findUnique({ where: { id: profB.id } })
    check('deleting a professor who owns classes is refused by the database',
      rawDelete !== null && Boolean(survivor),
      rawDelete === null ? 'the delete went through' : 'delete errored but the professor row is gone')

    section('Creating an account')

    const created = await call('POST', '/api/admin/professors', adminToken, {
      name: `Smoke Created ${RUN_ID}`, email: createdEmail, password: TEMP_PASSWORD,
    })
    check('an admin can create an account', created.status === 201, `status ${created.status}`)
    check('a created account is not an admin', created.json?.data?.professor?.isAdmin === false,
      `isAdmin=${created.json?.data?.professor?.isAdmin}`)

    const newLogin = await call('POST', '/api/auth/professor/login', null, {
      email: createdEmail, password: TEMP_PASSWORD,
    })
    check('the handed-over password works', newLogin.status === 200, `status ${newLogin.status}`)

    const dup = await call('POST', '/api/admin/professors', adminToken, {
      name: 'Dup', email: createdEmail, password: TEMP_PASSWORD,
    })
    check('a duplicate email is refused with 409', dup.status === 409, `status ${dup.status}`)

    const outsider = await call('POST', '/api/admin/professors', adminToken, {
      name: 'Outsider', email: `${TAG}@gmail.com`, password: TEMP_PASSWORD,
    })
    check('a non-Rutgers email is refused', outsider.status === 400, `status ${outsider.status}`)

    section('Transfer')

    const moved = await call('POST', `/api/admin/classes/${cls.id}/transfer`, adminToken, {
      toProfessorId: profC.id,
    })
    check('a class transfers whole', moved.status === 200 && moved.json?.data?.class?.professorId === profC.id,
      `status ${moved.status}, professorId ${moved.json?.data?.class?.professorId}`)

    const cSees = await call('GET', '/api/classes', cToken)
    check('the new owner sees it in their own dashboard',
      (cSees.json?.data?.classes ?? []).some((c: any) => c.id === cls.id), 'not in list')

    const bSees = await call('GET', '/api/classes', bToken)
    check('the old owner no longer does',
      !(bSees.json?.data?.classes ?? []).some((c: any) => c.id === cls.id), 'still in list')

    const noProf = await call('POST', `/api/admin/classes/${cls.id}/transfer`, adminToken, {
      toProfessorId: 'nonexistent',
    })
    check('transfer to a missing professor is refused', noProf.status === 404, `status ${noProf.status}`)

    section('Deactivation')

    const deact = await call('POST', `/api/admin/professors/${profB.id}/deactivate`, adminToken)
    check('deactivation reports when access ended',
      deact.status === 200 && Boolean(deact.json?.data?.professor?.deactivatedAt),
      `status ${deact.status}`)

    const bAfter = await call('GET', '/api/classes', bToken)
    check("B's outstanding token dies on its next request — no revocation list involved",
      bAfter.status === 401, `status ${bAfter.status}`)

    const bLogin = await call('POST', '/api/auth/professor/login', null, {
      email: profB.email, password: TEMP_PASSWORD,
    })
    check('login says deactivated, not wrong password',
      bLogin.status === 403, `status ${bLogin.status}`)

    const toDeactivated = await call('POST', `/api/admin/classes/${cls.id}/transfer`, adminToken, {
      toProfessorId: profB.id,
    })
    check('a deactivated account cannot receive a class', toDeactivated.status === 400,
      `status ${toDeactivated.status}`)

    const firstStamp = deact.json?.data?.professor?.deactivatedAt
    const again = await call('POST', `/api/admin/professors/${profB.id}/deactivate`, adminToken)
    check('repeating keeps the original timestamp — when access ended is the fact',
      again.status === 200 && again.json?.data?.professor?.deactivatedAt === firstStamp,
      `${again.json?.data?.professor?.deactivatedAt} vs ${firstStamp}`)

    const self = await call('POST', `/api/admin/professors/${admin.id}/deactivate`, adminToken)
    check('an admin cannot lock themselves out', self.status === 400, `status ${self.status}`)

    const react = await call('POST', `/api/admin/professors/${profB.id}/reactivate`, adminToken)
    check('reactivation clears the mark',
      react.status === 200 && react.json?.data?.professor?.deactivatedAt === null,
      `status ${react.status}`)

    const bBack = await call('POST', '/api/auth/professor/login', null, {
      email: profB.email, password: TEMP_PASSWORD,
    })
    check('a reactivated professor signs straight back in', bBack.status === 200, `status ${bBack.status}`)

    section('Student management')

    const sAsB = await call('GET', `/api/admin/students?q=${TAG}`, bToken)
    check('the student list is behind the same door', sAsB.status === 403, `status ${sAsB.status}`)

    const sList = await call('GET', `/api/admin/students?q=${TAG}`, adminToken)
    const sRows: any[] = sList.json?.data?.students ?? []
    const s1Row = sRows.find((r) => r.id === fixture!.s1.id)
    const s2Row = sRows.find((r) => r.id === fixture!.s2.id)
    check('search by netID substring finds the fixture students',
      sList.status === 200 && sList.json?.data?.total === 2 && Boolean(s1Row) && Boolean(s2Row),
      `status ${sList.status}, total ${sList.json?.data?.total}`)
    check('a draft counts here — it is weight a delete would take',
      s1Row?.responseCount === 1 && s2Row?.responseCount === 1,
      `s1 ${s1Row?.responseCount}, s2 ${s2Row?.responseCount}`)
    check('enrollments name the class', s1Row?.enrollments?.[0]?.className === cls.name,
      `got ${s1Row?.enrollments?.[0]?.className}`)

    const byEmailQ = await call('GET', `/api/admin/students?q=${TAG}-s1%40`, adminToken)
    check('search by email substring narrows to one',
      byEmailQ.status === 200 && byEmailQ.json?.data?.total === 1, `total ${byEmailQ.json?.data?.total}`)

    const newNetId = `${TAG}-s2-fixed`
    const sEdit = await call('PATCH', `/api/admin/students/${fixture.s2.id}`, adminToken, {
      netId: newNetId, email: `${TAG}-s2-fixed@scarletmail.rutgers.edu`,
    })
    check('a typo\'d identity is fixable',
      sEdit.status === 200 && sEdit.json?.data?.student?.netId === newNetId,
      `status ${sEdit.status}`)

    // Collide with the address just written to s2 — it has to pass the rutgers.edu
    // validation first, or the 400 masks the constraint this is checking.
    const sCollide = await call('PATCH', `/api/admin/students/${fixture.s1.id}`, adminToken, {
      email: `${TAG}-s2-fixed@scarletmail.rutgers.edu`,
    })
    check('colliding with another account is refused with 409', sCollide.status === 409,
      `status ${sCollide.status}`)

    const NEW_PW = `pw2-${RUN_ID}-x`
    const sPw = await call('POST', `/api/admin/students/${fixture.s1.id}/set-password`, adminToken, {
      newPassword: NEW_PW,
    })
    const sLogin = await call('POST', '/api/auth/student/login', null, {
      credential: fixture.s1.netId, password: NEW_PW,
    })
    check('an admin-set password signs the student in',
      sPw.status === 200 && sLogin.status === 200,
      `set ${sPw.status}, login ${sLogin.status}`)

    const sReset = await call('POST', `/api/admin/students/${fixture.s1.id}/send-reset`, adminToken)
    const tokenRows = await prisma.passwordResetToken.count({ where: { studentId: fixture.s1.id } })
    check('send-reset mints a real reset token',
      sReset.status === 200 && tokenRows === 1, `status ${sReset.status}, tokens ${tokenRows}`)

    const sDel = await call('DELETE', `/api/admin/students/${fixture.s2.id}`, adminToken)
    const s2Gone = await prisma.student.findUnique({ where: { id: fixture.s2.id } })
    const s2Responses = await prisma.response.count({ where: { studentId: fixture.s2.id } })
    check('deleting a student takes the row and its responses',
      sDel.status === 200 && s2Gone === null && s2Responses === 0,
      `status ${sDel.status}, row ${s2Gone ? 'remains' : 'gone'}, responses ${s2Responses}`)

    section('Professor identity')

    const pEdit = await call('PATCH', `/api/admin/professors/${profC.id}`, adminToken, {
      name: `Smoke Prof C Renamed ${RUN_ID}`, email: `${TAG}-c2@scarletmail.rutgers.edu`,
    })
    check('a professor\'s name and email are fixable the same way',
      pEdit.status === 200 && pEdit.json?.data?.professor?.email === `${TAG}-c2@scarletmail.rutgers.edu`,
      `status ${pEdit.status}`)

    const pPw = await call('POST', `/api/admin/professors/${profC.id}/set-password`, adminToken, {
      newPassword: NEW_PW,
    })
    const pLogin = await call('POST', '/api/auth/professor/login', null, {
      email: `${TAG}-c2@scarletmail.rutgers.edu`, password: NEW_PW,
    })
    check('an admin-set password signs the professor in',
      pPw.status === 200 && pLogin.status === 200,
      `set ${pPw.status}, login ${pLogin.status}`)
  } finally {
    section('Cleanup')
    if (fixture) {
      await destroyFixture(
        [fixture.admin.id, fixture.profB.id, fixture.profC.id],
        [fixture.s1.id, fixture.s2.id],
        [createdEmail]
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
