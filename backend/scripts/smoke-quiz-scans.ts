/**
 * Smoke test for scanned quizzes, end to end: upload → vision service → aligned pages and
 * crops, through a running Pulse with the worker and a running vision service.
 *
 * Phase 3 acceptance: an angled phone photo and a copier scan both line up so every box
 * lands on its blank (checked here as: the form's lines match well, the right version is
 * found, and no box with writing in it is called empty).
 *
 * Usage:
 *   python3 vision/make_fixtures.py /tmp/fixtures
 *   QUIZ_FIXTURES=/tmp/fixtures E2E_BASE=http://localhost:3001 npx tsx scripts/smoke-quiz-scans.ts
 *
 * The server needs VISION_URL and VISION_TOKEN and must share this script's database.
 * Creates two professors and removes them, their content and their scans. Never point it at prod.
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
const FIX = process.env.QUIZ_FIXTURES
const RUN_ID = Date.now().toString(36)

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; console.log(`  ✗ ${name}`, detail ?? '') }
}
const tokenFor = (id: string) => jwt.sign({ sub: id, role: 'professor' }, config.jwtSecret, { expiresIn: '1h' })

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api<T = any>(method: string, url: string, token: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, body: (await res.json().catch(() => null)) as T }
}

async function uploadFile(assessmentId: string, file: string, token: string) {
  const form = new FormData()
  form.append('file', await fs.openAsBlob(file, { type: file.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg' }), path.basename(file))
  const res = await fetch(`${BASE}/api/quiz-grader/content/${assessmentId}/batches`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form })
  return { status: res.status, body: await res.json() }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function settle(batchId: string, token: string): Promise<any> {
  for (let i = 0; i < 240; i++) {
    const b = await api('GET', `/api/quiz-grader/batches/${batchId}`, token)
    const pending = (b.body.data.counts.PENDING ?? 0) + (b.body.data.counts.PROCESSING ?? 0)
    if (!pending) return b.body.data
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('pages did not finish in 4 minutes')
}

async function main() {
  if (!FIX) throw new Error('Set QUIZ_FIXTURES to a directory made by vision/make_fixtures.py')
  const hash = await bcrypt.hash(`pw-${RUN_ID}`, 4)
  const prof = await prisma.professor.create({ data: { email: `qs-${RUN_ID}@example.invalid`, name: `Smoke QS ${RUN_ID}`, passwordHash: hash } })
  const other = await prisma.professor.create({ data: { email: `qs2-${RUN_ID}@example.invalid`, name: `Smoke QS2 ${RUN_ID}`, passwordHash: hash } })
  const T = tokenFor(prof.id)
  const T2 = tokenFor(other.id)
  const batchIds: string[] = []
  try {
    const v = await api('GET', '/api/quiz-grader/vision', T)
    check('the server reports the vision service as set up and answering', v.body.data.configured && v.body.data.healthy, v.body)

    await api('POST', '/api/quiz-grader/starter', T)
    const items = (await api('GET', '/api/quiz-grader/content', T)).body.data.items as { id: string; slug: string; kind: string }[]
    const quiz = items.find((i) => i.slug === 'glycolysis-quiz')!
    const key = items.find((i) => i.kind === 'KEY')!

    const notAssessment = await uploadFile(key.id, path.join(FIX, 'phone-old.jpg'), T)
    check('scans go to an assessment, not a key', notAssessment.status === 400)

    // The copier PDF: 3 pages.
    const up = await uploadFile(quiz.id, path.join(FIX, 'copier.pdf'), T)
    check('a 3-page scanned PDF uploads as 3 pages', up.status === 201 && up.body.data.pageCount === 3, up.body)
    batchIds.push(up.body.data.id)
    const copier = await settle(up.body.data.id, T)
    const [p0, p1, p2] = copier.pages
    check('copier scan of an old print: lined up by its printed lines, version A',
      p0.status === 'DONE' && p0.method === 'lines' && p0.match > 0.9 && p0.version === 'A', p0)
    check('copier scan of a marker print: lined up by its markers, version B',
      p1.status === 'DONE' && p1.method === 'markers' && p1.markers === 4 && p1.match > 0.9 && p1.version === 'B', p1)
    check('a page whose version cannot be told waits for a person', p2.status === 'NEEDS_VERSION' && p2.version === null, p2)
    check('the empty enzyme blank on page 1 is found empty, written ones are not',
      p0.slots.find((s: { id: string }) => s.id === 's4_enzyme').blank === true
      && p0.slots.filter((s: { id: string; blank: boolean }) => s.id.endsWith('_enzyme') && s.id !== 's4_enzyme').every((s: { blank: boolean }) => !s.blank))
    check('the vision service was told to forget the upload once all pages were fetched',
      (await prisma.quizBatch.findUnique({ where: { id: up.body.data.id } }))?.visionDocId === null)

    // Phone photos.
    for (const [file, method, version] of [['phone-markers.jpg', 'markers', 'C'], ['phone-old.jpg', 'paper edges', 'A']] as const) {
      const r = await uploadFile(quiz.id, path.join(FIX, file), T)
      batchIds.push(r.body.data.id)
      const b = await settle(r.body.data.id, T)
      const pg = b.pages[0]
      check(`PHASE 3: angled phone photo (${file}) lined up by ${method}, version ${version}`,
        pg.status === 'DONE' && pg.method === method && pg.match > 0.9 && pg.version === version, pg)
    }

    // Images: owner only, never static.
    const pageId = p0.id
    const aligned = await fetch(`${BASE}/api/quiz-grader/pages/${pageId}/aligned`, { headers: { Authorization: `Bearer ${T}` } })
    check('the aligned page image is served to its owner', aligned.status === 200 && aligned.headers.get('content-type') === 'image/png')
    const crop = await fetch(`${BASE}/api/quiz-grader/pages/${pageId}/crops/s1_enzyme`, { headers: { Authorization: `Bearer ${T}` } })
    check('a box crop is served to its owner', crop.status === 200)
    const theirs = await fetch(`${BASE}/api/quiz-grader/pages/${pageId}/aligned`, { headers: { Authorization: `Bearer ${T2}` } })
    check("another professor cannot see this professor's scans", theirs.status === 404)
    const anon = await fetch(`${BASE}/api/quiz-grader/pages/${pageId}/original`)
    check('no image without signing in', anon.status === 401)
    const rel = path.relative(path.dirname(SCAN_ROOT), path.join(SCAN_ROOT, up.body.data.id, '0', 'aligned.png'))
    const statik = await fetch(`${BASE}/uploads/${rel}`)
    check('scans are never served from the public /uploads route', statik.status === 404, statik.status)
    const detail = await api('GET', `/api/quiz-grader/pages/${pageId}`, T)
    check('a page comes with its version list and boxes for drawing', detail.body.data.versions.join() === 'A,B,C' && detail.body.data.boxes.length > 10)

    // A person names the version of the unclear page.
    const setV = await api('POST', `/api/quiz-grader/pages/${p2.id}/version`, T, { version: 'A' })
    check('naming a version queues the page again', setV.status === 200)
    const after = await settle(up.body.data.id, T)
    check('the page is processed as the version given', after.pages[2].status === 'DONE' && after.pages[2].version === 'A' && after.pages[2].versionForced === 'A', after.pages[2])
    const badV = await api('POST', `/api/quiz-grader/pages/${p2.id}/version`, T, { version: 'Z' })
    check('an unknown version is refused', badV.status === 400)

    const list = await api('GET', `/api/quiz-grader/content/${quiz.id}/batches`, T)
    check('the assessment lists its 3 uploads with counts', list.body.data.batches.length === 3 && list.body.data.batches.every((b: { counts: Record<string, number> }) => b.counts.DONE >= 1))

    const delQuiz = await api('DELETE', `/api/quiz-grader/content/${quiz.id}`, T)
    check('an assessment with scans cannot be deleted', delQuiz.status === 409)

    const dir = path.join(SCAN_ROOT, up.body.data.id)
    const del = await api('DELETE', `/api/quiz-grader/batches/${up.body.data.id}`, T)
    check('deleting an upload removes its pages and files', del.status === 200 && !fs.existsSync(dir)
      && (await prisma.quizPage.count({ where: { batchId: up.body.data.id } })) === 0)
  } finally {
    for (const id of batchIds) fs.rmSync(path.join(SCAN_ROOT, id), { recursive: true, force: true })
    await prisma.quizBatch.deleteMany({ where: { professorId: { in: [prof.id, other.id] } } })
    await prisma.quizContent.deleteMany({ where: { professorId: { in: [prof.id, other.id] } } })
    await prisma.professor.deleteMany({ where: { id: { in: [prof.id, other.id] } } })
    await prisma.$disconnect()
  }
  console.log(`\n  ${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
