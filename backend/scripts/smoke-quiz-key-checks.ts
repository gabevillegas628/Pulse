/**
 * Smoke test for suggested structure checks, end to end: upload a filled-in key → the vision
 * service cuts out each drawing → a model suggests checks → the grading reader tests them on
 * every key drawing → code tallies. Against a running Pulse, vision service and the stand-in
 * for the Claude API (scripts/quiz-grader/mock-claude.mjs), set up as for smoke-quiz-grading.
 *
 * The mock suggests two checks per molecule, one of which ("MOCKFAIL…") no drawing shows, so
 * the run exercises the revision and the dropping of a check the key's own drawing fails.
 *
 * Usage (fixtures from vision/make_fixtures.py; the copier scan stands in for a filled key):
 *   QUIZ_FIXTURES=/tmp/fixtures MOCK_LOG=/tmp/mock.log E2E_BASE=http://localhost:3001 \
 *     npx tsx scripts/smoke-quiz-key-checks.ts
 *
 * Creates two professors and removes them with everything they made. Never point it at prod.
 */
import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { prisma } from '../src/db/index.js'
import { config } from '../src/config/index.js'

const BASE = process.env.E2E_BASE ?? 'http://localhost:3001'
const FIX = process.env.QUIZ_FIXTURES!
const MOCK_LOG = process.env.MOCK_LOG!
const RUN_ID = Date.now().toString(36)

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; console.log(`  ✗ ${name}`, detail ?? '') }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api<T = any>(method: string, url: string, token: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, body: (await res.json().catch(() => null)) as T }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const profs = await Promise.all(['a', 'b'].map(async (x) => prisma.professor.create({
    data: { email: `qk-${x}-${RUN_ID}@example.invalid`, name: `Smoke QK ${RUN_ID}`, passwordHash: await bcrypt.hash('x', 4) },
  })))
  const [prof, other] = profs as [typeof profs[0], typeof profs[0]]
  const cls = await prisma.class.create({ data: { professorId: prof.id, name: 'Smoke K', joinCode: `K${RUN_ID}`.toUpperCase().slice(0, 12) } })
  const T = jwt.sign({ sub: prof.id, role: 'professor' }, config.jwtSecret, { expiresIn: '1h' })
  const T2 = jwt.sign({ sub: other.id, role: 'professor' }, config.jwtSecret, { expiresIn: '1h' })
  try {
    await api('POST', '/api/quiz-grader/starter', T, { classId: cls.id })
    const items = (await api('GET', '/api/quiz-grader/content', T)).body.data.items as { id: string; slug: string; kind: string }[]
    const quiz = items.find((i) => i.slug === 'glycolysis-quiz')!
    const url = `/api/quiz-grader/quizzes/${quiz.id}`

    const empty = (await api('GET', `${url}/key-drawings`, T)).body.data
    check('a new quiz has no key drawings, and says the vision service is there', empty.drawings === null && empty.vision === true, empty)
    const early = await api('POST', `${url}/suggest-checks`, T)
    await sleep(500)
    const earlyJob = (await api('GET', `${url}/suggest-checks`, T)).body.data
    check('suggesting checks before a key is uploaded fails, saying why', early.status === 202 && earlyJob.status === 'failed' && /Upload your filled-in answer key/.test(earlyJob.error), earlyJob)

    // Page 1 is version A with its three drawings filled in; page 2 version B, with its own.
    fs.writeFileSync(MOCK_LOG, '')
    const up = await fetch(`${BASE}${url}/key-drawings?name=key.pdf`, {
      method: 'PUT', headers: { Authorization: `Bearer ${T}`, 'Content-Type': 'application/pdf' }, body: fs.readFileSync(path.join(FIX, 'copier.pdf')),
    })
    const cut = ((await up.json()) as { data: { items: { id: string; slotId: string; page: number }[]; pages: number; notes: string[]; outOfDate: string[] } }).data
    const ids = cut.items.map((i) => i.id).sort()
    check('the key is cut into one drawing per filled structure box', up.status === 200 && ['bpg13', 'pep', 'pg2'].every((id) => ids.includes(id)), cut)
    // Every box catches some ink from the answers beside it; a page whose version has the
    // intermediate drawn by hand is preferred (pep is drawn on version A, page 1; pg3 on B, page 2).
    check('a drawing is taken from a page whose version draws it', cut.items.find((i) => i.id === 'pep')?.page === 1 && cut.items.find((i) => i.id === 'pg3')?.page === 2, cut.items)
    check('nothing is out of date straight after cutting', cut.outOfDate.length === 0, cut.outOfDate)

    const img = await fetch(`${BASE}${url}/key-drawings/pep.png`, { headers: { Authorization: `Bearer ${T}` } })
    check('a drawing is served as a PNG to its professor', img.status === 200 && img.headers.get('content-type') === 'image/png' && (await img.arrayBuffer()).byteLength > 1000)
    const theirs = await fetch(`${BASE}${url}/key-drawings/pep.png`, { headers: { Authorization: `Bearer ${T2}` } })
    check('and to no one else', theirs.status === 404, theirs.status)
    check('another professor cannot start suggestions on it', (await api('POST', `${url}/suggest-checks`, T2)).status === 404)

    // Suggest, test, revise. Start cold, and with one graded structure undrawn.
    await prisma.quizReadCache.deleteMany({})
    const row = await prisma.quizKeyDrawings.findUniqueOrThrow({ where: { assessmentId: quiz.id } })
    const stored = row.drawings as { items: Record<string, unknown> }
    delete stored.items.pyruvate
    await prisma.quizKeyDrawings.update({ where: { assessmentId: quiz.id }, data: { drawings: stored as object } })
    fs.writeFileSync(MOCK_LOG, '')
    const start = await api('POST', `${url}/suggest-checks`, T)
    check('suggesting starts in the background', start.status === 202 && start.body.data.status === 'running', start.body)
    let job = start.body.data
    for (let i = 0; i < 60 && job.status === 'running'; i++) { await sleep(500); job = (await api('GET', `${url}/suggest-checks`, T)).body.data }
    check('and finishes', job.status === 'done', job)
    const res = job.result as { items: { id: string; current: string[]; currentTest: { keyFails: unknown[] } | null; suggested: string[]; suggestedTest: { tested: boolean; keyFails: unknown[]; confusedWith: { id: string }[]; tellsApart: unknown[] }; dropped: { check: string }[]; revised: boolean }[]; dollars: number; drawings: number }
    const graded = ['bpg13', 'pg2', 'pep', 'pg3', 'f16bp', 'f6p', 'pyruvate']
    check('every structure a version grades gets suggestions', graded.every((id) => res.items.some((x) => x.id === id)) && res.items.length === graded.length, res.items.map((x) => x.id))
    const pep = res.items.find((x) => x.id === 'pep')!
    check('a check the key’s own drawing fails is dropped, with what the reader saw', pep.suggested.length === 1 && pep.dropped.length === 1 && pep.dropped[0]!.check.startsWith('MOCKFAIL'), pep)
    check('what is left passes the key’s own drawing', pep.suggestedTest.tested && pep.suggestedTest.keyFails.length === 0, pep.suggestedTest)
    check('molecules it cannot be told from are listed (the mock sees the one check everywhere)', pep.suggestedTest.confusedWith.length === res.drawings - 1, pep.suggestedTest)
    check('a revision that does no better is not kept', !pep.revised)
    check('the current checks are tested the same way', pep.current.length > 0 && pep.currentTest !== null && pep.currentTest.keyFails.length === 0, pep.currentTest)
    const undrawn = res.items.find((x) => x.id === 'pyruvate')
    check('a structure with no key drawing is suggested but marked untested', !!undrawn && undrawn.suggestedTest.tested === false && undrawn.dropped.length === 0, undrawn)
    check('the run reports its cost', typeof res.dollars === 'number' && res.dollars > 0, res.dollars)

    const log = fs.readFileSync(MOCK_LOG, 'utf8').trim().split('\n')
    check('one call writes checks for every graded structure', log.filter((l) => l.startsWith('suggest ')).length === 1 && graded.every((id) => log.find((l) => l.startsWith('suggest '))!.split(' ').includes(id)), log)
    check('checks with problems are sent back once to be revised', log.filter((l) => l.startsWith('revise ')).length === 1, log)
    const reads = log.filter((l) => !/^(suggest|revise) /.test(l))
    check('the reader answers neutrally labelled lists, never told which molecule each is for', reads.length > 0 && reads.every((l) => /^(l\d+ )*l\d+$/.test(l)), log)
    check('names and NetIDs are never sent', !log.some((l) => l.split(' ').some((x) => x === 'name' || x === 'netid')), log)

    // Boxes moved: the drawings are out of date until cut again.
    const layout = items.find((i) => i.kind === 'LAYOUT' && i.slug === 'glycolysis-template-v1')!
    const lay = (await api('GET', `/api/quiz-grader/content/${layout.id}`, T)).body.data
    const moved = structuredClone(lay.data)
    const pepSlot = moved.slots.find((s: { ref: string }) => s.ref === 'intermediate.pep')
    pepSlot.box = [pepSlot.box[0] + 0.01, ...pepSlot.box.slice(1)]
    await api('PUT', `/api/quiz-grader/content/${layout.id}`, T, { data: moved, updatedAt: lay.updatedAt })
    const after = (await api('GET', `${url}/key-drawings`, T)).body.data.drawings
    check('moving a box marks its drawing out of date', after.outOfDate.includes('pep'), after.outOfDate)
    const recut = (await api('POST', `${url}/key-drawings/cut`, T)).body.data
    check('cutting again brings it up to date', recut.outOfDate.length === 0, recut)

    check('removing the key removes its drawings', (await api('DELETE', `${url}/key-drawings`, T)).status === 200
      && (await api('GET', `${url}/key-drawings`, T)).body.data.drawings === null)
  } finally {
    for (const pr of profs) {
      await prisma.quizContent.deleteMany({ where: { professorId: pr.id } })
      await prisma.class.deleteMany({ where: { professorId: pr.id } })
      await prisma.professor.delete({ where: { id: pr.id } })
    }
    await prisma.$disconnect()
  }
  console.log(`\n  ${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
