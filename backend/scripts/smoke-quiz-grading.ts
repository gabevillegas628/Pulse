/**
 * Smoke test for grading scanned pages, end to end: upload → vision service → model reads
 * → scores, against a running Pulse, a running vision service, and a stand-in for the
 * Claude API that answers from a fixed table and counts requests.
 *
 * Checks the scores and review flags, that empty boxes and name/NetID boxes are never sent
 * to the model, that editing the key re-scores every page without a single new model call,
 * that re-grading reuses cached reads, and the comparison with hand grades.
 *
 * Usage:
 *   python3 vision/make_fixtures.py /tmp/fixtures
 *   node scripts/quiz-grader/mock-claude.mjs /tmp/mock.log   # listens on :8788; GET / returns {count}
 *   # server started with ANTHROPIC_API_KEY=mock ANTHROPIC_BASE_URL=http://127.0.0.1:8788
 *   QUIZ_FIXTURES=/tmp/fixtures MOCK_LOG=/tmp/mock.log MOCK_URL=http://127.0.0.1:8788 \
 *     E2E_BASE=http://localhost:3001 npx tsx scripts/smoke-quiz-grading.ts
 *
 * Creates a professor and removes it with everything it made, and empties the model read
 * cache so the run starts cold. Never point it at prod.
 */
import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { prisma } from '../src/db/index.js'
import { config } from '../src/config/index.js'
import { SCAN_ROOT } from '../src/quizGrader/scans.js'

const BASE = process.env.E2E_BASE ?? 'http://localhost:3001'
const FIX = process.env.QUIZ_FIXTURES!
const MOCK_LOG = process.env.MOCK_LOG!
const MOCK_URL = process.env.MOCK_URL!
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
const modelCalls = async () => ((await (await fetch(MOCK_URL)).json()) as { count: number }).count
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function until(what: string, fn: () => Promise<boolean>, secs = 240): Promise<void> {
  for (let i = 0; i < secs; i++) { if (await fn()) return; await sleep(1000) }
  throw new Error(`timed out waiting for ${what}`)
}

async function main() {
  const prof = await prisma.professor.create({ data: { email: `qg-${RUN_ID}@example.invalid`, name: `Smoke QG ${RUN_ID}`, passwordHash: await bcrypt.hash('x', 4) } })
  // Paper quizzes belong to a class.
  const cls0 = await prisma.class.create({ data: { professorId: prof.id, name: 'Smoke G', joinCode: `G${RUN_ID}`.toUpperCase().slice(0, 12) } })
  const T = jwt.sign({ sub: prof.id, role: 'professor' }, config.jwtSecret, { expiresIn: '1h' })
  let batchId = ''
  try {
    const v = await api('GET', '/api/quiz-grader/vision', T)
    check('the server reports grading as set up', v.body.data.grading === true, v.body)
    await api('POST', '/api/quiz-grader/starter', T, { classId: cls0.id })
    const items = (await api('GET', '/api/quiz-grader/content', T)).body.data.items as { id: string; slug: string; kind: string }[]
    const quiz = items.find((i) => i.slug === 'glycolysis-quiz')!
    const key = items.find((i) => i.kind === 'KEY' && i.slug === 'glycolysis')!

    // Start cold: an earlier run's cached reads of these same crops would skip the model.
    await prisma.quizReadCache.deleteMany({})
    fs.writeFileSync(MOCK_LOG, '')
    const before = await modelCalls()
    const form = new FormData()
    form.append('file', await fs.openAsBlob(path.join(FIX, 'copier.pdf'), { type: 'application/pdf' }), 'copier.pdf')
    const up = await fetch(`${BASE}/api/quiz-grader/content/${quiz.id}/batches`, { method: 'POST', headers: { Authorization: `Bearer ${T}` }, body: form })
    batchId = ((await up.json()) as { data: { id: string } }).data.id
    const results = async () => (await api('GET', `/api/quiz-grader/content/${quiz.id}/results`, T)).body.data
    await until('pages 1-2 graded and page 3 settled', async () => {
      const x = await results()
      return x.summary.graded === 2 && x.pages[2]?.status === 'NEEDS_VERSION'
    })
    const r = await results()
    check('two lined-up pages are graded; the page without a version is not', r.summary.graded === 2
      && r.pages[2].status === 'NEEDS_VERSION' && r.pages[2].gradeStatus === 'NONE', r.pages)

    const page1 = (await api('GET', `/api/quiz-grader/pages/${r.pages[0].id}`, T)).body.data
    const res = new Map<string, { status: string; blankBy: string; pointsAuto: number; maxPoints: number; needsReview: boolean; reviewReasons: string[]; groupKey: string }>(
      page1.results.map((x: { slotId: string }) => [x.slotId, x]))
    check('every scored box of version A has a result (19 + 10 intermediate names)', page1.results.length === 29, page1.results.length)
    check('the empty step-4 blank scores 0 without being read', res.get('s4_enzyme')?.status === 'blank' && res.get('s4_enzyme')?.blankBy === 'ink' && res.get('s4_enzyme')?.pointsAuto === 0)
    check('a right enzyme scores 1, not reviewed', res.get('s1_enzyme')?.pointsAuto === 1 && !res.get('s1_enzyme')?.needsReview)
    check('a misspelling is credited but sent to review', res.get('s2_enzyme')?.pointsAuto === 1 && res.get('s2_enzyme')?.needsReview === true)
    check('cofactors score all-or-nothing, Pi included', res.get('s6_cofactors')?.pointsAuto === 1 && res.get('s1_cofactors')?.pointsAuto === 1)
    check('structures are always reviewed', ['int_bpg13', 'int_pg2', 'int_pep'].every((s) => res.get(s)?.needsReview))
    // The test page has writing near some intermediates only; the rest are empty boxes.
    const nameResults = page1.results.filter((x: { kind: string }) => x.kind === 'name')
    const namesRead = nameResults.filter((x: { status: string }) => x.status === 'read')
    check('names that were written are read and scored; empty name boxes are not sent',
      namesRead.length >= 5 && namesRead.every((x: { pointsAuto: number; needsReview: boolean }) => x.pointsAuto === 1 && !x.needsReview)
      && nameResults.filter((x: { status: string }) => x.status !== 'read').every((x: { blankBy: string; pointsAuto: number }) => x.blankBy === 'ink' && x.pointsAuto === 0),
      nameResults.map((x: { slotId: string; status: string; pointsAuto: number }) => `${x.slotId}:${x.status}:${x.pointsAuto}`))
    const autoTotal = 18 + namesRead.length
    check(`the page total is ${autoTotal} of 29 (18 as before, plus each name read)`, page1.pointsAuto === autoTotal && page1.maxPoints === 29, [page1.pointsAuto, page1.maxPoints])
    check('identical answers share a group key', res.get('s1_enzyme')?.groupKey === 'hexokinase')
    check('the page reports what its grading cost', typeof page1.cost === 'number' && page1.cost > 0)

    const requests = fs.readFileSync(MOCK_LOG, 'utf8').split('\n').filter(Boolean).map((l) => l.split(' '))
    const sent = requests.flat()
    check('names and NetIDs were never sent to the model', !sent.some((s) => s === 'name' || s === 'netid'), sent)
    const carrying = (id: string) => requests.filter((q) => q.includes(id)).length
    // Page 1 left step 4 empty, page 2 step 9: each is in one text request, not both.
    check('empty boxes are never sent (step 4 only from page 2, step 9 only from page 1)',
      carrying('s1_enzyme') === 2 && carrying('s4_enzyme') === 1 && carrying('s9_enzyme') === 1, requests)
    check('two model calls per page (text, structures), plus a second look on each page with a near miss', (await modelCalls()) - before === 6, (await modelCalls()) - before)
    const looks = fs.readFileSync(MOCK_LOG, 'utf8').trim().split('\n')
    const lookIds = looks.flatMap((l, i) => (l === 'second-look' ? (looks[i - 1] ?? '').split(' ') : []))
    check('second looks carry only near-miss enzyme and name answers (here, the step 2 misspelling)',
      lookIds.length > 0 && lookIds.every((id) => /_(enzyme|name)$/.test(id)) && lookIds.includes('s2_enzyme'), lookIds)

    // Editing the key re-scores without asking the model again.
    const calls = await modelCalls()
    const k = (await api('GET', `/api/quiz-grader/content/${key.id}`, T)).body.data
    const edited = structuredClone(k.data)
    edited.steps['1'].enzyme.accept = ['glucokinase']
    await api('PUT', `/api/quiz-grader/content/${key.id}`, T, { data: edited, updatedAt: k.updatedAt })
    await until('re-score after the key edit', async () => (await api('GET', `/api/quiz-grader/pages/${r.pages[0].id}`, T)).body.data.pointsAuto === autoTotal - 1, 20)
    check('editing the key re-scores graded pages (hexokinase no longer accepted: one point less)', true)
    check('re-scoring made no model calls', (await modelCalls()) === calls)
    const k2 = (await api('GET', `/api/quiz-grader/content/${key.id}`, T)).body.data
    await api('PUT', `/api/quiz-grader/content/${key.id}`, T, { data: k.data, updatedAt: k2.updatedAt })
    await until('re-score after restoring the key', async () => (await api('GET', `/api/quiz-grader/pages/${r.pages[0].id}`, T)).body.data.pointsAuto === autoTotal, 20)
    const resc = await api('POST', `/api/quiz-grader/content/${quiz.id}/rescore`, T)
    check('re-score on demand covers both graded pages', resc.body.data.pages === 2)

    // Answers are matched to checks by position, so changing a drawing's checks has those
    // drawings read again rather than re-scored from answers to the old checks.
    const c3 = await modelCalls()
    const k3 = (await api('GET', `/api/quiz-grader/content/${key.id}`, T)).body.data
    const e3 = structuredClone(k3.data)
    e3.intermediates.pep.features[0] = `${e3.intermediates.pep.features[0]} (reworded)`
    await api('PUT', `/api/quiz-grader/content/${key.id}`, T, { data: e3, updatedAt: k3.updatedAt })
    await until('page 1 read again', async () => (await modelCalls()) > c3 && (await results()).pages[0].gradeStatus === 'GRADED', 30)
    await sleep(1500)
    check('changing a drawing’s checks reads it again: one structure call, for the one page that draws it', (await modelCalls()) - c3 === 1, (await modelCalls()) - c3)
    const pepNow = (await api('GET', `/api/quiz-grader/pages/${r.pages[0].id}`, T)).body.data.results.find((x: { slotId: string }) => x.slotId === 'int_pep')
    check('and the page shows the new check', /\(reworded\)$/.test(pepNow?.detail?.features?.[0]?.feature ?? ''), pepNow?.detail)
    check('the other page (version B does not draw pep) was not read again', (await results()).pages[1].gradeStatus === 'GRADED')
    const k4 = (await api('GET', `/api/quiz-grader/content/${key.id}`, T)).body.data
    await api('PUT', `/api/quiz-grader/content/${key.id}`, T, { data: k.data, updatedAt: k4.updatedAt })
    await until('page 1 back on the original checks', async () => {
      const d = (await api('GET', `/api/quiz-grader/pages/${r.pages[0].id}`, T)).body.data
      return d.gradeStatus === 'GRADED' && !/reworded/.test(JSON.stringify(d.results))
    }, 30)
    check('going back to the original checks reuses the earlier reading (no model call)', (await modelCalls()) - c3 === 1, (await modelCalls()) - c3)

    // Re-grading reuses the cache.
    const c2 = await modelCalls()
    await api('POST', `/api/quiz-grader/pages/${r.pages[0].id}/regrade`, T)
    await until('re-grade', async () => (await results()).pages[0].gradeStatus === 'GRADED' && (await results()).summary.grading === 0)
    check('re-grading an unchanged page uses cached reads (no model calls)', (await modelCalls()) === c2)

    // The unclear page, once its version is named, is lined up and graded.
    await api('POST', `/api/quiz-grader/pages/${r.pages[2].id}/version`, T, { version: 'A' })
    await until('page 3 graded', async () => (await results()).pages[2].gradeStatus === 'GRADED')
    check('naming a version gets the page graded', (await results()).pages[2].version === 'A')

    // Pages lined up before grading was set up can be graded later.
    await prisma.quizPage.update({ where: { id: r.pages[1].id }, data: { gradeStatus: 'NONE' } })
    const queued = await api('POST', `/api/quiz-grader/content/${quiz.id}/grade-ungraded`, T)
    check('"grade ungraded" queues exactly the ungraded page', queued.body.data.queued === 1, queued.body)
    await until('the ungraded page graded', async () => (await results()).pages[1].gradeStatus === 'GRADED')
    check('it gets graded', true)

    // Comparison with hand grades.
    const csv = 'page,s1_enzyme,s2_enzyme,s4_enzyme,int_pep\ntestScans-p1,1,0,0,1\n2,1,1,0,-\n'
    const cmp = (await api('POST', `/api/quiz-grader/batches/${batchId}/compare`, T, { csv })).body.data
    const enzyme = cmp.byKind.find((k: { kind: string }) => k.kind === 'enzyme')
    check('the comparison counts agreements per kind', enzyme.compared === 6 && enzyme.agree === 4, cmp)
    check('disagreements list unflagged first', cmp.disagreements.length === 2 && cmp.disagreements.some((d: { slotId: string; flagged: string | null }) => d.slotId === 's2_enzyme' && d.flagged), cmp.disagreements)
  } finally {
    if (batchId) fs.rmSync(path.join(SCAN_ROOT, batchId), { recursive: true, force: true })
    await prisma.quizBatch.deleteMany({ where: { professorId: prof.id } })
    await prisma.quizContent.deleteMany({ where: { professorId: prof.id } })
    await prisma.class.deleteMany({ where: { professorId: prof.id } })
    await prisma.professor.delete({ where: { id: prof.id } })
    await prisma.$disconnect()
  }
  console.log(`\n  ${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
