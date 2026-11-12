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
  // Paper quizzes belong to a class.
  const cls0 = await prisma.class.create({ data: { professorId: prof.id, name: 'Smoke C', joinCode: `C${RUN_ID}`.toUpperCase().slice(0, 12) } })
  const other = await prisma.professor.create({ data: { email: `qc2-${RUN_ID}@example.invalid`, name: `Smoke QC2 ${RUN_ID}`, passwordHash: hash } })
  const T = tokenFor(prof.id)
  const T2 = tokenFor(other.id)
  try {
    // Starter content
    const starter = await http('POST', '/api/quiz-grader/starter', T, { classId: cls0.id })
    check('the examples load 2 quizzes into the class', starter.status === 200 && starter.body.data.added.length === 2, starter.body)
    const again = await http('POST', '/api/quiz-grader/starter', T, { classId: cls0.id })
    check('loading the examples twice skips what the class has', again.body.data.added.length === 0 && again.body.data.skipped.length === 2)
    check('the examples need a class of your own', (await http('POST', '/api/quiz-grader/starter', T2, { classId: cls0.id })).status === 404)

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

    // Quizzes: a new one from a title, edited as one bundle
    check('a new quiz needs a class', (await http('POST', '/api/quiz-grader/quizzes', T, { title: 'Mini quiz' })).status === 400)
    const made = await http('POST', '/api/quiz-grader/quizzes', T, { title: 'Mini quiz', classId: cls0.id })
    check('a new quiz is created from its title', made.status === 201, made.body)
    const qid = made.body.data.id as string
    const b0 = (await http('GET', `/api/quiz-grader/quizzes/${qid}`, T)).body.data
    check('a new quiz comes with an empty key and blank form', !!b0.key && !!b0.layout && b0.quiz.title === 'Mini quiz' && b0.quiz.issues.length === 0)
    const qAgain = await http('POST', '/api/quiz-grader/quizzes', T, { title: 'Mini quiz', classId: cls0.id })
    const b1 = (await http('GET', `/api/quiz-grader/quizzes/${qAgain.body.data.id}`, T)).body.data
    check('a second quiz with the same title gets its own files', b1.quiz.slug === 'mini-quiz-2' && b1.key.slug === 'mini-quiz-2')
    await http('DELETE', `/api/quiz-grader/quizzes/${qAgain.body.data.id}`, T)

    const key = structuredClone(b0.key.data)
    key.intermediates.a = { name: 'A', accept: ['A'], features: [] }
    key.intermediates.b = { name: 'B', accept: ['B'], features: [] }
    key.steps['1'] = { from: ['a'], to: ['b'], enzyme: { accept: ['abase'] } }
    const layout = structuredClone(b0.layout.data)
    layout.slots.push({ id: 's1_enzyme', type: 'text', ref: 'step.1.enzyme', box: [0.1, 0.1, 0.2, 0.1] })
    const quiz = structuredClone(b0.quiz.data)
    quiz.versions.A.structures = ['b']
    const put = await http('PUT', `/api/quiz-grader/quizzes/${qid}`, T, {
      key: { data: key, updatedAt: b0.key.updatedAt },
      layout: { data: layout, updatedAt: b0.layout.updatedAt },
      quiz: { data: quiz, updatedAt: b0.quiz.updatedAt },
    })
    check('one save writes the key, boxes and settings together', put.status === 200 && put.body.data.saved === 3, put.body)
    check('an empty key grows indented lines, comments kept', put.body.data.key.source.includes('\nintermediates:\n  a:\n') && put.body.data.key.source.startsWith('# Answer key: Mini quiz'))
    const qStale = await http('PUT', `/api/quiz-grader/quizzes/${qid}`, T, { key: { data: key, updatedAt: b0.key.updatedAt } })
    check('a save from a qStale page is refused', qStale.status === 409)
    const pdfBytes = await (await fetch(`${BASE}/api/quiz-grader/content/${layouts[0]!.id}/pdf`, { headers: { Authorization: `Bearer ${T}` } })).arrayBuffer()
    await fetch(`${BASE}/api/quiz-grader/content/${put.body.data.layout.id}/pdf`, {
      method: 'PUT', headers: { Authorization: `Bearer ${T}`, 'Content-Type': 'application/pdf' }, body: new Uint8Array(pdfBytes),
    })
    const afterPdf = await http('PUT', `/api/quiz-grader/quizzes/${qid}`, T, {
      layout: { data: { ...layout, slots: [] }, updatedAt: put.body.data.layout.updatedAt },
    })
    check('uploading the blank form does not make an open page qStale', afterPdf.status === 200, afterPdf.body)
    const qRenamed = await http('PUT', `/api/quiz-grader/quizzes/${qid}`, T, { key: { data: { ...key, pathway: 'other' }, updatedAt: put.body.data.key.updatedAt } })
    check('file names are not changed from the quiz page', qRenamed.status === 400)
    const theirQuiz = await http('GET', `/api/quiz-grader/quizzes/${qid}`, T2)
    check("another professor cannot open this quiz", theirQuiz.status === 404)
    const qDel = await http('DELETE', `/api/quiz-grader/quizzes/${qid}`, T)
    const left = await prisma.quizContent.count({ where: { professorId: prof.id, slug: { startsWith: 'mini-quiz' } } })
    check('deleting a quiz removes its three files', qDel.status === 200 && left === 0)

    // Classes: a class's quizzes, copying into another class, duplicating a class
    const inClass = (await http('GET', `/api/quiz-grader/classes/${cls0.id}/quizzes`, T)).body.data
    check("a class lists its quizzes", inClass.quizzes.length === 2 && inClass.unfiled.length === 0 && inClass.class.id === cls0.id, inClass)
    check("another professor cannot list this class's quizzes", (await http('GET', `/api/quiz-grader/classes/${cls0.id}/quizzes`, T2)).status === 404)
    const cls1 = await prisma.class.create({ data: { professorId: prof.id, name: 'Smoke C1', joinCode: `D${RUN_ID}`.toUpperCase().slice(0, 12) } })
    const copied = await http('POST', `/api/quiz-grader/quizzes/${glyQuiz.id}/copy`, T, { classId: cls1.id })
    check('a quiz copies into another class', copied.status === 201, copied.body)
    const cb = (await http('GET', `/api/quiz-grader/quizzes/${copied.body.data.id}`, T)).body.data
    check('the copy has fresh names, points at its own key and boxes, and keeps the blank form',
      cb.quiz.slug === 'glycolysis-quiz-2' && cb.key?.slug === 'glycolysis-2' && cb.layout?.slug === 'glycolysis-template-v1-2'
      && cb.quiz.data.key === 'glycolysis-2' && cb.layout.hasPdf && cb.class?.id === cls1.id && cb.quiz.issues.length === 0, { q: cb.quiz.slug, k: cb.key?.slug, l: cb.layout?.slug })
    const origKey = (await http('GET', `/api/quiz-grader/content/${keyItem.id}`, T)).body.data.source as string
    check('only the naming line of the copied key changed', (() => {
      const x = origKey.split('\n'), y = (cb.key.source as string).split('\n')
      const diff = x.map((l, i) => (l === y[i] ? null : i)).filter((i) => i !== null)
      return x.length === y.length && diff.length === 1 && y[diff[0]!] === 'pathway: glycolysis-2'
    })())
    check("a quiz cannot be copied into another professor's class", (await http('POST', `/api/quiz-grader/quizzes/${glyQuiz.id}/copy`, T2, { classId: cls1.id })).status === 404)
    const dupRes = await http('POST', `/api/classes/${cls0.id}/duplicate`, T, { name: 'Smoke C dup' })
    const dupId = dupRes.body.data?.class?.id as string
    const inDup = dupId ? (await http('GET', `/api/quiz-grader/classes/${dupId}/quizzes`, T)).body.data : null
    check('duplicating a class copies its paper quizzes (not their scans)', dupRes.status === 201 && dupRes.body.data.quizzesCopied === inClass.quizzes.length
      && inDup?.quizzes.length === inClass.quizzes.length && inDup.quizzes.every((q: { papers: number }) => q.papers === 0), dupRes.body)
    const unfiledQuiz = await prisma.quizContent.update({ where: { id: tcaQuiz.id }, data: { classId: null } })
    check('a quiz in no class shows as one to move in', (await http('GET', `/api/quiz-grader/classes/${cls1.id}/quizzes`, T)).body.data.unfiled.some((q: { id: string }) => q.id === unfiledQuiz.id))
    const beforeMove = await prisma.quizContent.findUniqueOrThrow({ where: { id: tcaQuiz.id }, select: { updatedAt: true } })
    await http('PUT', `/api/quiz-grader/content/${tcaQuiz.id}/class`, T, { classId: cls1.id })
    const afterMove = await prisma.quizContent.findUniqueOrThrow({ where: { id: tcaQuiz.id }, select: { updatedAt: true } })
    check('moving a quiz does not make an open quiz page stale', beforeMove.updatedAt.getTime() === afterMove.updatedAt.getTime())
    check('moving it in files it there', (await http('GET', `/api/quiz-grader/classes/${cls1.id}/quizzes`, T)).body.data.quizzes.some((q: { id: string }) => q.id === tcaQuiz.id))

    // Ownership
    const theirs = await http('GET', `/api/quiz-grader/content/${keyItem.id}`, T2)
    check("another professor cannot open this professor's key", theirs.status === 404)
    const theirList = await http('GET', '/api/quiz-grader/content', T2)
    check("another professor's list is empty", theirList.body.data.items.length === 0)
  } finally {
    await prisma.quizContent.deleteMany({ where: { professorId: { in: [prof.id, other.id] } } })
    await prisma.class.deleteMany({ where: { professorId: { in: [prof.id, other.id] } } })
    await prisma.professor.deleteMany({ where: { id: { in: [prof.id, other.id] } } })
    await prisma.$disconnect()
  }
  console.log(`\n  ${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
