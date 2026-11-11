/**
 * Smoke test for reviewing graded quiz boxes: group decisions, paper overrides, structure
 * feature checks, precedence, withdrawing, decisions surviving re-scoring and reaching
 * later uploads, adding an answer to the key from review, and the audit log.
 *
 * Same setup as smoke-quiz-grading.ts: a running Pulse (ANTHROPIC_BASE_URL pointed at
 * scripts/quiz-grader/mock-claude.mjs), a running vision service, fixtures from
 * vision/make_fixtures.py.
 *
 *   QUIZ_FIXTURES=/tmp/fixtures E2E_BASE=http://localhost:3001 npx tsx scripts/smoke-quiz-review.ts
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
import { SCAN_ROOT } from '../src/quizGrader/scans.js'

const BASE = process.env.E2E_BASE ?? 'http://localhost:3001'
const FIX = process.env.QUIZ_FIXTURES!
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
async function until(what: string, fn: () => Promise<boolean>, secs = 240) {
  for (let i = 0; i < secs; i++) { if (await fn()) return; await sleep(1000) }
  throw new Error(`timed out waiting for ${what}`)
}

async function main() {
  const hash = await bcrypt.hash('x', 4)
  const prof = await prisma.professor.create({ data: { email: `qr-${RUN_ID}@example.invalid`, name: `Smoke Reviewer ${RUN_ID}`, passwordHash: hash } })
  const other = await prisma.professor.create({ data: { email: `qr2-${RUN_ID}@example.invalid`, name: `Smoke QR2 ${RUN_ID}`, passwordHash: hash } })
  const T = jwt.sign({ sub: prof.id, role: 'professor' }, config.jwtSecret, { expiresIn: '1h' })
  const T2 = jwt.sign({ sub: other.id, role: 'professor' }, config.jwtSecret, { expiresIn: '1h' })
  const batches: string[] = []
  try {
    await api('POST', '/api/quiz-grader/starter', T)
    const items = (await api('GET', '/api/quiz-grader/content', T)).body.data.items as { id: string; slug: string; kind: string }[]
    const quiz = items.find((i) => i.slug === 'glycolysis-quiz')!
    const key = items.find((i) => i.kind === 'KEY' && i.slug === 'glycolysis')!
    const upload = async () => {
      const form = new FormData()
      form.append('file', await fs.openAsBlob(path.join(FIX, 'copier.pdf'), { type: 'application/pdf' }), 'copier.pdf')
      const r = await fetch(`${BASE}/api/quiz-grader/content/${quiz.id}/batches`, { method: 'POST', headers: { Authorization: `Bearer ${T}` }, body: form })
      const id = ((await r.json()) as { data: { id: string } }).data.id
      batches.push(id)
      return id
    }
    const results = async () => (await api('GET', `/api/quiz-grader/content/${quiz.id}/results`, T)).body.data
    const review = async () => (await api('GET', `/api/quiz-grader/content/${quiz.id}/review`, T)).body.data
    const item = async (slot: string) => (await api('GET', `/api/quiz-grader/content/${quiz.id}/review/${slot}`, T)).body.data
    const page = async (id: string) => (await api('GET', `/api/quiz-grader/pages/${id}`, T)).body.data

    await upload()
    await until('two pages graded', async () => (await results()).summary.graded === 2)
    const [p1, p2] = (await results()).pages
    const start = await review()
    check('8 boxes to review across the two graded pages', start.open === 8, start.open)
    const s2 = start.slots.find((s: { slotId: string }) => s.slotId === 's2_enzyme')
    check('the summary lists boxes in layout order with counts', start.slots[0].slotId === 's1_enzyme' && s2.open === 2 && s2.label === 'Step 2 enzyme', start.slots.slice(0, 3))

    // By item: both papers wrote "phosphoglucose isomerse" in step 2.
    const s2item = await item('s2_enzyme')
    const misspelt = s2item.groups[0]
    check('identical answers form one group of 2, flagged first', misspelt.count === 2 && misspelt.open === 2 && /isomerse/.test(misspelt.sample), misspelt)
    check('an enzyme box comes with its accepted names', Array.isArray(s2item.accept) && s2item.accept.includes('phosphoglucose isomerase'))

    // Mark the group wrong: one decision, two papers.
    const [a1, a2] = [(await page(p1.id)).pointsAuto, (await page(p2.id)).pointsAuto]
    await api('POST', `/api/quiz-grader/content/${quiz.id}/review/s2_enzyme/group`, T, { groupKey: misspelt.groupKey, points: 0 })
    check('one group decision covers both papers', (await review()).open === 6 && (await page(p1.id)).pointsFinal === a1 - 1 && (await page(p2.id)).pointsFinal === a2 - 1)
    check('the automatic score is kept alongside', (await page(p1.id)).pointsAuto === a1)

    // Change of mind: correct after all, and add it to the key.
    const yamlBefore = await (await fetch(`${BASE}/api/quiz-grader/content/${key.id}/yaml`, { headers: { Authorization: `Bearer ${T}` } })).text()
    const alias = await api('POST', `/api/quiz-grader/content/${quiz.id}/review/s2_enzyme/group`, T, { groupKey: misspelt.groupKey, points: 1, addAlias: 'phosphoglucose isomerse' })
    check('a group can be re-decided, with the answer added to the key', alias.status === 200 && alias.body.data.alias === 'phosphoglucose isomerse', alias.body)
    const yamlAfter = await (await fetch(`${BASE}/api/quiz-grader/content/${key.id}/yaml`, { headers: { Authorization: `Bearer ${T}` } })).text()
    const changed = yamlAfter.split('\n').filter((l, i) => l !== yamlBefore.split('\n')[i])
    check('the key gains the alias on exactly one line', changed.length === 1 && changed[0]!.includes('phosphoglucose isomerse'), changed)
    const after = (await item('s2_enzyme')).groups[0]
    check('after re-scoring, the answer is an exact match and no longer flagged', after.members.every((m: { needsReview: boolean }) => !m.needsReview))

    // One paper, against its group.
    await api('POST', `/api/quiz-grader/content/${quiz.id}/review/s1_enzyme/group`, T, { groupKey: 'hexokinase', points: 1 })
    await api('POST', `/api/quiz-grader/pages/${p1.id}/boxes/s1_enzyme`, T, { points: 0, note: 'illegible on paper' })
    const s1 = (await page(p1.id)).results.find((r: { slotId: string }) => r.slotId === 's1_enzyme')
    check("a paper's own decision beats its group's", s1.points === 0 && s1.source === 'paper' && s1.decision?.points === 1, s1)
    await api('POST', `/api/quiz-grader/pages/${p1.id}/boxes/s1_enzyme`, T, { points: null })
    const s1b = (await page(p1.id)).results.find((r: { slotId: string }) => r.slotId === 's1_enzyme')
    check('withdrawing it falls back to the group decision', s1b.points === 1 && s1b.source === 'group')

    // Structures: judged feature by feature, all or nothing.
    const pep = await api('POST', `/api/quiz-grader/pages/${p1.id}/boxes/int_pep`, T, { points: 1, features: [true, true, false, true] })
    check('a structure missing one feature scores 0 (all or nothing)', pep.body.data.points === 0, pep.body)
    const pep2 = await api('POST', `/api/quiz-grader/pages/${p1.id}/boxes/int_pep`, T, { points: 1, features: [true, true, true, true] })
    check('with every feature it scores 1', pep2.body.data.points === 1)
    const bad = await api('POST', `/api/quiz-grader/pages/${p1.id}/boxes/int_pep`, T, { points: 1, features: [true] })
    check('the wrong number of feature answers is refused', bad.status === 400)
    const tooMany = await api('POST', `/api/quiz-grader/pages/${p1.id}/boxes/s1_enzyme`, T, { points: 5 })
    check('more than the box is worth is refused', tooMany.status === 400)

    // Decisions survive re-scoring.
    const before = (await page(p1.id)).pointsFinal
    await api('POST', `/api/quiz-grader/content/${quiz.id}/rescore`, T)
    check('re-scoring keeps every decision', (await page(p1.id)).pointsFinal === before)

    // A later upload: the same answers arrive already decided.
    const b2 = await upload()
    await until('the second upload graded', async () => (await results()).summary.graded === 4)
    const later = (await api('GET', `/api/quiz-grader/batches/${b2}`, T)).body.data.pages[0]
    const laterS1 = (await page(later.id)).results.find((r: { slotId: string }) => r.slotId === 's1_enzyme')
    check('group decisions reach papers uploaded later', laterS1.source === 'group' && laterS1.points === 1, laterS1)

    // Review everything to zero, by item.
    for (const slot of (await review()).slots.filter((s: { open: number }) => s.open > 0)) {
      const it = await item(slot.slotId)
      for (const g of it.groups.filter((g: { open: number }) => g.open > 0)) {
        if (it.kind === 'structure') {
          for (const m of g.members) await api('POST', `/api/quiz-grader/pages/${m.pageId}/boxes/${slot.slotId}`, T, { points: m.pointsAuto })
        } else {
          await api('POST', `/api/quiz-grader/content/${quiz.id}/review/${slot.slotId}/group`, T, { groupKey: g.groupKey, points: g.members[0].pointsAuto })
        }
      }
    }
    check('every flagged box can be decided: nothing left to review', (await review()).open === 0 && (await results()).summary.toReview === 0)

    // Re-processing every page (after a layout change) keeps every decision.
    await until('nothing still processing', async () => (await results()).pages.every((pg: { status: string }) => pg.status !== 'PENDING' && pg.status !== 'PROCESSING'))
    const totalsBefore = (await results()).pages.map((pg: { pointsFinal: number | null }) => pg.pointsFinal).join()
    const rp = await api('POST', `/api/quiz-grader/content/${quiz.id}/reprocess`, T)
    check('re-process queues every page', rp.body.data.queued === 6, rp.body)
    await until('everything re-processed and re-graded', async () => {
      const x = await results()
      return x.summary.graded === 4 && x.pages.every((pg: { status: string }) => pg.status === 'DONE' || pg.status === 'NEEDS_VERSION') && !x.summary.grading
    })
    check('after re-processing, decisions still apply: same scores, nothing to review',
      (await results()).pages.map((pg: { pointsFinal: number | null }) => pg.pointsFinal).join() === totalsBefore && (await review()).open === 0)

    // The log.
    const log = (await api('GET', `/api/quiz-grader/content/${quiz.id}/log`, T)).body.data.entries
    check('every decision is logged, newest first, with who', log.length > 10 && log[0].who === prof.name
      && new Date(log[0].createdAt) >= new Date(log[log.length - 1].createdAt))
    check('the log records group, paper and alias decisions with before and after', ['group', 'paper', 'alias'].every((s) => log.some((e: { scope: string }) => e.scope === s))
      && log.some((e: { scope: string; fromPoints: number; toPoints: number }) => e.scope === 'paper' && e.fromPoints === 1 && e.toPoints === 0))

    // Students: a class with a roster, papers matched by hand, grades out as a CSV.
    const cls = await prisma.class.create({ data: { professorId: prof.id, name: `Smoke class ${RUN_ID}`, joinCode: `SMK${RUN_ID}`.slice(0, 12) } })
    const kids = await Promise.all(['zz101', 'zz102', 'zz103'].map((n) => prisma.student.create({
      data: { netId: `${n}${RUN_ID}`.toLowerCase(), email: `${n}${RUN_ID}@example.invalid`.toLowerCase(), passwordHash: hash, enrollments: { create: { classId: cls.id } } },
    })))
    try {
      const m0 = (await api('GET', `/api/quiz-grader/content/${quiz.id}/match`, T)).body.data
      check('matching lists every paper with its name and NetID boxes', m0.pages.length === 6 && m0.classId === null
        && m0.pages.some((pg: { nameBox: string | null; netidBox: string | null }) => pg.nameBox === 'name' && pg.netidBox === 'netid'), m0.pages[0])
      const setCls = await api('PUT', `/api/quiz-grader/content/${quiz.id}/class`, T, { classId: cls.id })
      check('linking the quiz to a class returns its roster', setCls.status === 200 && setCls.body.data.roster.length === 3)
      check("another professor's class cannot be linked", (await api('PUT', `/api/quiz-grader/content/${quiz.id}/class`, T2, { classId: cls.id })).status === 404)
      const graded = (await results()).pages.filter((pg: { gradeStatus: string }) => pg.gradeStatus === 'GRADED')
      const put1 = await api('PUT', `/api/quiz-grader/pages/${graded[0].id}/student`, T, { netId: `  ${kids[0]!.netId.toUpperCase()} ` })
      check('a NetID is stored trimmed and lower-cased', put1.body.data.netId === kids[0]!.netId)
      await api('PUT', `/api/quiz-grader/pages/${graded[1].id}/student`, T, { netId: 'notinclass9' })
      check('a NetID with odd characters is refused', (await api('PUT', `/api/quiz-grader/pages/${graded[1].id}/student`, T, { netId: '=cmd()' })).status === 400)
      check("another professor cannot match this professor's paper", (await api('PUT', `/api/quiz-grader/pages/${graded[0].id}/student`, T2, { netId: 'x' })).status === 404)
      check('results show the matched NetID', (await results()).pages.some((pg: { studentNetId: string | null }) => pg.studentNetId === kids[0]!.netId))

      const csvRes = await fetch(`${BASE}/api/quiz-grader/content/${quiz.id}/export.csv?boxes=1`, { headers: { Authorization: `Bearer ${T}` } })
      const csv = await csvRes.text()
      const rows = csv.trim().split('\r\n').map((l) => l.split(','))
      const head = rows[0]!
      const row = (netId: string) => rows.find((r) => r[0] === netId)
      const totals = (await results()).pages
      const first = totals.find((pg: { id: string }) => pg.id === graded[0].id)
      check('the CSV is a download with a header and a column per box', csvRes.headers.get('content-type')?.startsWith('text/csv') === true
        && head.slice(0, 4).join() === 'netid,email,score,out_of' && head.includes('s1_enzyme'), head)
      check("a matched paper's row has its email and its score after review", row(kids[0]!.netId)?.[1] === kids[0]!.email
        && Number(row(kids[0]!.netId)?.[2]) === first.pointsFinal && Number(row(kids[0]!.netId)?.[3]) === first.maxPoints, row(kids[0]!.netId))
      check('a NetID not on the roster is exported and noted', row('notinclass9')?.join().includes('not on the class roster') === true)
      check('unmatched papers are exported and noted', rows.filter((r) => r[0] === '' && r.join().includes('not matched')).length === 4)
      check('students with no paper are listed with no score', [kids[1]!, kids[2]!].every((k) => row(k.netId)?.[2] === '' && row(k.netId)?.join().includes('no paper')))
      check("another professor cannot export this quiz's grades", (await fetch(`${BASE}/api/quiz-grader/content/${quiz.id}/export.csv`, { headers: { Authorization: `Bearer ${T2}` } })).status === 404)
    } finally {
      await prisma.quizContent.updateMany({ where: { classId: cls.id }, data: { classId: null } })
      await prisma.enrollment.deleteMany({ where: { classId: cls.id } })
      await prisma.student.deleteMany({ where: { id: { in: kids.map((k) => k.id) } } })
      await prisma.class.delete({ where: { id: cls.id } })
    }

    // Ownership.
    check("another professor cannot see this review", (await api('GET', `/api/quiz-grader/content/${quiz.id}/review`, T2)).status === 404)
    check("another professor cannot decide this paper's box", (await api('POST', `/api/quiz-grader/pages/${p1.id}/boxes/s1_enzyme`, T2, { points: 0 })).status === 404)
  } finally {
    for (const id of batches) fs.rmSync(path.join(SCAN_ROOT, id), { recursive: true, force: true })
    await prisma.quizBatch.deleteMany({ where: { professorId: { in: [prof.id, other.id] } } })
    await prisma.quizContent.deleteMany({ where: { professorId: { in: [prof.id, other.id] } } })
    await prisma.professor.deleteMany({ where: { id: { in: [prof.id, other.id] } } })
    await prisma.$disconnect()
  }
  console.log(`\n  ${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
