/**
 * Smoke test for changing a session question's type from the edit dialog.
 *
 * Type may change only until someone answers. A change replaces the options, resets the
 * key, and clears the free-text-only settings.
 *
 * Usage:
 *   E2E_BASE=http://localhost:3010 npx tsx scripts/smoke-type-change.ts
 *
 * Needs a server pointed at the same database this script connects to, and cleans up
 * everything it creates. Never point it at prod.
 */

import 'dotenv/config'
import jwt from 'jsonwebtoken'
import { prisma } from '../src/db/index.js'
import { config } from '../src/config/index.js'

const BASE = process.env.E2E_BASE ?? 'http://localhost:3001'
const RUN_ID = Date.now().toString(36)
const TAG = `smoke-tc-${RUN_ID}`

let failed = 0
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failed++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
}

async function http(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, body: (await res.json().catch(() => null)) as any }
}

async function freeCode(): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const c = String(Math.floor(Math.random() * 10000)).padStart(4, '0')
    if (!(await prisma.question.findUnique({ where: { accessCode: c } }))) return c
  }
  throw new Error('No free access code available')
}

async function main() {
  const professor = await prisma.professor.create({
    data: { email: `${TAG}@example.invalid`, name: `Smoke TC ${RUN_ID}`, passwordHash: 'x' },
  })
  let studentId: string | null = null
  try {
    const cls = await prisma.class.create({
      data: { professorId: professor.id, name: `Smoke TC ${RUN_ID}`, joinCode: `TC${RUN_ID.slice(-6).toUpperCase()}` },
    })
    const session = await prisma.session.create({
      data: { classId: cls.id, title: `Smoke TC ${RUN_ID}`, accessCode: await freeCode() },
    })
    const prof = jwt.sign({ sub: professor.id, role: 'professor' }, config.jwtSecret, { expiresIn: '1h' })
    const url = (qid: string) => `/api/sessions/${session.id}/questions/${qid}`

    let r = await http('POST', `/api/sessions/${session.id}/questions`, prof, {
      text: 'Pick one', type: 'MULTIPLE_CHOICE', options: ['A', 'B', 'C'],
    })
    const qid = r.body.data.question.id as string
    await http('PATCH', url(qid), prof, { correctAnswer: 'B' })

    r = await http('PATCH', url(qid), prof, { type: 'MULTI_SELECT', options: ['A', 'B'] })
    check('multiple choice → multi-select', r.status === 200, `got ${r.status}`)
    let q = r.body.data.question
    check('options replaced', JSON.stringify(q.options) === '["A","B"]')
    check('key cleared', q.correctAnswer === null)

    r = await http('PATCH', url(qid), prof, { type: 'ORDERING', options: ['one'] })
    check('one option is refused', r.status === 400, `got ${r.status}`)

    r = await http('PATCH', url(qid), prof, { type: 'ORDERING', options: ['first', 'second'] })
    q = r.body.data.question
    check('ordering key is the steps as given', q.correctAnswer === '["first","second"]')

    r = await http('PATCH', url(qid), prof, { type: 'FREE_TEXT', effortGrading: true })
    q = r.body.data.question
    check('→ free text drops options', r.status === 200 && q.options === null, `got ${r.status}`)
    check('free-text setting accepted alongside the change', q.effortGrading === true)

    r = await http('PATCH', url(qid), prof, { type: 'NUMERIC' })
    q = r.body.data.question
    check('→ numeric clears free-text settings', q.effortGrading === null && q.liveThemes === null)

    r = await http('PATCH', url(qid), prof, { type: 'YES_NO', correctAnswer: 'Yes' })
    check('key in the same save is refused', r.status === 400, `got ${r.status}`)

    r = await http('PATCH', url(qid), prof, { type: 'BLANKS', options: ['Prompt one', 'Prompt two'] })
    q = r.body.data.question
    check('→ blanks takes prompts', r.status === 200 && q.options.length === 2, `got ${r.status}`)

    r = await http('PATCH', url(qid), prof, { type: 'STRUCTURE' })
    check('structure refused in a session', r.status === 400, `got ${r.status}`)

    r = await http('PATCH', url(qid), prof, { type: 'BLANKS', text: 'Same type, new text' })
    check('sending the current type is a no-op', r.status === 200 && r.body.data.question.text === 'Same type, new text')

    // A draft answer is enough to lock it.
    const s = await prisma.student.create({
      data: { netId: TAG, email: `${TAG}@example.invalid`, passwordHash: 'x' },
    })
    studentId = s.id
    await prisma.response.create({
      data: { questionId: qid, studentId: s.id, responseText: '["a",""]', wordCount: 1, isDraft: true },
    })
    r = await http('PATCH', url(qid), prof, { type: 'FREE_TEXT' })
    check('locked once anyone has answered, drafts included', r.status === 409, `got ${r.status}`)

    await prisma.response.deleteMany({ where: { questionId: qid } })
    await prisma.sessionRun.create({ data: { sessionId: session.id, status: 'OPEN' } })
    r = await http('PATCH', url(qid), prof, { type: 'FREE_TEXT' })
    check('refused while a run is open', r.status === 400, `got ${r.status}`)
  } finally {
    await prisma.class.deleteMany({ where: { professorId: professor.id } })
    await prisma.professor.delete({ where: { id: professor.id } })
    if (studentId) await prisma.student.delete({ where: { id: studentId } })
    await prisma.$disconnect()
  }
  console.log(failed ? `\n${failed} failed` : '\nAll passed')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
