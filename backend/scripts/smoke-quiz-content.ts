/**
 * Smoke test for the quiz grader's content API (answer keys, layouts, assessments).
 *
 * Against a running server: load the starter content, edit a key the way the editor
 * does, export it, and check the export differs from the seed file by exactly the
 * edited line — the Phase 1 acceptance test. Also: imports, conflicts, a stale save,
 * deletes refused while in use, and one professor not seeing another's content.
 *
 * Usage:
 *   E2E_BASE=http://localhost:3010 npx tsx scripts/smoke-quiz-content.ts
 *
 * Needs a server pointed at the same database this script connects to. Creates two
 * professors and removes them, and everything they own, at the end. Never point it at prod.
 */
import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { prisma } from '../src/db/index.js'
import { config } from '../src/config/index.js'
import { PDFDocument } from 'pdf-lib'

const BASE = process.env.E2E_BASE ?? 'http://localhost:3001'
const RUN_ID = Date.now().toString(36)
const SEED = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'quiz-grader', 'seed')

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; console.log(`  ✗ ${name}`, detail ?? '') }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function http<T = any>(method: string, url: string, token: string, body?: unknown): Promise<{ status: number; body: T; text: string }> {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  let parsed: unknown = null
  try { parsed = JSON.parse(text) } catch { /* the YAML download */ }
  return { status: res.status, body: parsed as T, text }
}

const tokenFor = (id: string) => jwt.sign({ sub: id, role: 'professor' }, config.jwtSecret, { expiresIn: '1h' })

/** Lines removed and added, trimming the shared head and tail. */
function lineDiff(a: string, b: string) {
  const A = a.split('\n'), B = b.split('\n')
  let i = 0
  while (i < A.length && A[i] === B[i]) i++
  let j = 0
  while (j < A.length - i && j < B.length - i && A[A.length - 1 - j] === B[B.length - 1 - j]) j++
  return { removed: A.slice(i, A.length - j), added: B.slice(i, B.length - j) }
}

async function main() {
  const hash = await bcrypt.hash(`pw-${RUN_ID}`, 4)
  const prof = await prisma.professor.create({ data: { email: `qc-${RUN_ID}@example.invalid`, name: `Smoke QC ${RUN_ID}`, passwordHash: hash } })
  const other = await prisma.professor.create({ data: { email: `qc2-${RUN_ID}@example.invalid`, name: `Smoke QC2 ${RUN_ID}`, passwordHash: hash } })
  const T = tokenFor(prof.id)
  const T2 = tokenFor(other.id)
  try {
    // Starter content
    const starter = await http('POST', '/api/quiz-grader/starter', T)
    check('starter content loads 6 files', starter.status === 200 && starter.body.data.added.length === 6, starter.body)
    const again = await http('POST', '/api/quiz-grader/starter', T)
    check('loading starter content twice skips what is there', again.body.data.added.length === 0 && again.body.data.skipped.length === 6)

    const list = await http('GET', '/api/quiz-grader/content', T)
    const items = list.body.data.items as { id: string; kind: string; slug: string; title: string; issues: string[]; warnings: string[] }[]
    check('list shows 2 keys, 2 layouts, 2 assessments',
      ['KEY', 'LAYOUT', 'ASSESSMENT'].every((k) => items.filter((i) => i.kind === k).length === 2))
    check('seed content has no schema problems', items.every((i) => i.issues.length === 0), items.filter((i) => i.issues.length))
    const glyQuiz = items.find((i) => i.slug === 'glycolysis-quiz')!
    const tcaQuiz = items.find((i) => i.slug === 'tca-quiz')!
    check('the complete glycolysis quiz has no warnings', glyQuiz.warnings.length === 0, glyQuiz.warnings)
    check('the TCA quiz notes its layout has undrawn boxes', tcaQuiz.warnings.some((w) => w.includes('no box drawn')), tcaQuiz.warnings)
    const tcaLayout = items.find((i) => i.kind === 'LAYOUT' && i.slug === 'tca-template-v1')!
    check('the TCA layout warns only about its ungraded structures having no box', tcaLayout.warnings.some((w) => w.includes('9 slots')), tcaLayout.warnings)

    const keyItem = items.find((i) => i.kind === 'KEY' && i.slug === 'glycolysis')!
    check('a key is listed by its title', keyItem.title === 'Glycolysis')

    // Export is the seed file, byte for byte
    const seedKey = fs.readFileSync(path.join(SEED, 'keys', 'glycolysis.yaml'), 'utf8')
    const exported = await http('GET', `/api/quiz-grader/content/${keyItem.id}/yaml`, T)
    check('export of an unedited key is byte-identical to the seed', exported.text === seedKey)

    // Phase 1 acceptance: edit in the app, export, diff against the seed.
    const one = await http('GET', `/api/quiz-grader/content/${keyItem.id}`, T)
    const data = one.body.data.data
    data.steps['6'].enzyme.accept.push('glyceraldehyde-3-P DH')
    const saved = await http('PUT', `/api/quiz-grader/content/${keyItem.id}`, T, { data, updatedAt: one.body.data.updatedAt })
    check('an edit saves by splicing', saved.status === 200 && saved.body.data.method === 'splice', saved.body)
    const after = await http('GET', `/api/quiz-grader/content/${keyItem.id}/yaml`, T)
    const d = lineDiff(seedKey, after.text)
    check('PHASE 1: the edited key exports with exactly the edited line changed',
      d.removed.length === 1 && d.added.length === 1 && d.added[0]!.includes('glyceraldehyde-3-P DH') && d.removed[0]!.includes('GAP dehydrogenase'), d)

    const stale = await http('PUT', `/api/quiz-grader/content/${keyItem.id}`, T, { data, updatedAt: one.body.data.updatedAt })
    check('a save based on an old copy is refused', stale.status === 409 && stale.body.code === 'QUIZ_CONTENT_STALE')

    const bad = structuredClone(saved.body.data.data)
    delete bad.steps['6'].enzyme
    const invalid = await http('PUT', `/api/quiz-grader/content/${keyItem.id}`, T, { data: bad, updatedAt: saved.body.data.updatedAt })
    check('an invalid edit is refused with the path to the problem', invalid.status === 400 && /steps\.6\.enzyme/.test(invalid.body.error), invalid.body)

    // Rename and delete are refused while an assessment uses the key
    const renamed = structuredClone(saved.body.data.data)
    renamed.pathway = 'glycolysis-2'
    const rename = await http('PUT', `/api/quiz-grader/content/${keyItem.id}`, T, { data: renamed, updatedAt: saved.body.data.updatedAt })
    check('renaming a key an assessment uses is refused', rename.status === 409 && /glycolysis-quiz/.test(rename.body.error))
    const del = await http('DELETE', `/api/quiz-grader/content/${keyItem.id}`, T)
    check('deleting a key an assessment uses is refused', del.status === 409)

    // Imports
    const dup = await http('POST', '/api/quiz-grader/content', T, { source: seedKey })
    check('importing a duplicate name is refused without replace', dup.status === 409 && dup.body.code === 'QUIZ_CONTENT_EXISTS')
    const repl = await http('POST', '/api/quiz-grader/content', T, { source: seedKey, replace: true })
    check('import with replace restores the seed', repl.status === 200
      && (await http('GET', `/api/quiz-grader/content/${keyItem.id}/yaml`, T)).text === seedKey)
    const garbage = await http('POST', '/api/quiz-grader/content', T, { source: 'pathway: x\n  bad: [indent' })
    check('a YAML syntax error is a 400 with a line number', garbage.status === 400 && /line/i.test(garbage.body.error), garbage.body)
    const notOurs = await http('POST', '/api/quiz-grader/content', T, { source: 'hello: world\n' })
    check('a file that is not quiz content is refused', notOurs.status === 400)
    const newKey = await http('POST', '/api/quiz-grader/content', T, {
      source: `pathway: ppp-${RUN_ID}\ntitle: Pentose phosphate\nintermediates: {}\nsteps:\n  1:\n    from: [g6p]\n    to: [6pgl]\n    enzyme: { accept: [G6PD] }\n`,
    })
    check('a new key imports', newKey.status === 201)
    const delNew = await http('DELETE', `/api/quiz-grader/content/${newKey.body.data.id}`, T)
    check('an unused key deletes', delNew.status === 200)

    // Blank forms and printing
    const layouts = items.filter((i) => i.kind === 'LAYOUT') as unknown as { id: string; hasPdf: boolean }[]
    check('starter layouts come with their blank PDFs', layouts.every((l) => l.hasPdf))
    const pdfRes = await fetch(`${BASE}/api/quiz-grader/content/${layouts[0]!.id}/pdf`, { headers: { Authorization: `Bearer ${T}` } })
    check('a layout PDF downloads', pdfRes.status === 200 && (await pdfRes.arrayBuffer()).byteLength > 1000)
    const printAll = await fetch(`${BASE}/api/quiz-grader/content/${glyQuiz.id}/print`, { headers: { Authorization: `Bearer ${T}` } })
    const allPdf = await PDFDocument.load(new Uint8Array(await printAll.arrayBuffer()))
    check('printing the glycolysis quiz gives one page per version (3)', printAll.status === 200 && allPdf.getPageCount() === 3)
    const printB = await fetch(`${BASE}/api/quiz-grader/content/${glyQuiz.id}/print?version=B`, { headers: { Authorization: `Bearer ${T}` } })
    check('printing one version gives one page', printB.status === 200 && (await PDFDocument.load(new Uint8Array(await printB.arrayBuffer()))).getPageCount() === 1
      && /glycolysis-quiz-B\.pdf/.test(printB.headers.get('content-disposition') ?? ''))
    const printZ = await http('GET', `/api/quiz-grader/content/${glyQuiz.id}/print?version=Z`, T)
    check('printing an unknown version is refused', printZ.status === 400)
    const junk = await fetch(`${BASE}/api/quiz-grader/content/${layouts[0]!.id}/pdf`, {
      method: 'PUT', headers: { Authorization: `Bearer ${T}`, 'Content-Type': 'application/pdf' }, body: 'not a pdf',
    })
    check('a file that is not a PDF is refused', junk.status === 400)
    const keyPdf = await fetch(`${BASE}/api/quiz-grader/content/${keyItem.id}/pdf`, {
      method: 'PUT', headers: { Authorization: `Bearer ${T}`, 'Content-Type': 'application/pdf' }, body: new Uint8Array(await (await fetch(`${BASE}/api/quiz-grader/content/${layouts[0]!.id}/pdf`, { headers: { Authorization: `Bearer ${T}` } })).arrayBuffer()),
    })
    check('only layouts take a PDF', keyPdf.status === 400)

    // Ownership
    const theirs = await http('GET', `/api/quiz-grader/content/${keyItem.id}`, T2)
    check("another professor cannot open this professor's key", theirs.status === 404)
    const theirList = await http('GET', '/api/quiz-grader/content', T2)
    check("another professor's list is empty", theirList.body.data.items.length === 0)
  } finally {
    await prisma.quizContent.deleteMany({ where: { professorId: { in: [prof.id, other.id] } } })
    await prisma.professor.deleteMany({ where: { id: { in: [prof.id, other.id] } } })
    await prisma.$disconnect()
  }
  console.log(`\n  ${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
