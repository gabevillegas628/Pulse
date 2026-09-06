/**
 * End-to-end test for images attached to session questions.
 *
 * Covers the paths that decide whether a diagram reaches the student and whether the
 * file behind it is looked after: upload, attach, the student payload, the mid-run
 * edit lock, and the reference counting that lets a duplicated class share one file.
 *
 * Everything is created under a throwaway professor and deleted afterwards, so a run
 * leaves no trace beyond log lines.
 *
 * Usage:
 *   npx tsx scripts/e2e-question-image.ts
 *   E2E_BASE=http://localhost:3010 npx tsx scripts/e2e-question-image.ts
 *
 * Requires a running server pointed at the same database this script connects to.
 */

import 'dotenv/config'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import fs from 'fs'
import path from 'path'
import { prisma } from '../src/db/index.js'
import { config } from '../src/config/index.js'
import { uploadDir } from '../src/utils/uploads.js'

const BASE = process.env.E2E_BASE ?? 'http://localhost:3001'
const RUN_ID = Date.now().toString(36)
const TAG = `img-${RUN_ID}`

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++
    console.log(`  PASS  ${name}`)
  } else {
    failed++
    failures.push(name + (detail ? ` - ${detail}` : ''))
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`)
  }
}

const section = (title: string) => console.log(`\n=== ${title} ===`)

interface Res<T> { status: number; body: T }

async function http<T = any>(
  method: string,
  route: string,
  opts: { token?: string; body?: unknown } = {}
): Promise<Res<T>> {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  })
  return { status: res.status, body: (await res.json().catch(() => null)) as T }
}

async function upload(
  token: string,
  bytes: Buffer,
  filename: string,
  contentType: string
): Promise<Res<{ url?: string; error?: string }>> {
  const form = new FormData()
  form.append('image', new Blob([new Uint8Array(bytes)], { type: contentType }), filename)
  const res = await fetch(`${BASE}/api/uploads/image`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  })
  return { status: res.status, body: (await res.json().catch(() => null)) as any }
}

/** Mint a token directly rather than logging in, keeping JWT_SECRET out of the output. */
const tokenFor = (id: string, role: 'professor' | 'student') =>
  jwt.sign({ sub: id, role }, config.jwtSecret, { expiresIn: '1h' })

async function freeCode(): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const c = String(Math.floor(Math.random() * 10000)).padStart(4, '0')
    if (!(await prisma.question.findUnique({ where: { accessCode: c } }))) return c
  }
  throw new Error('No free access code available')
}

/** A real 1x1 PNG, so nothing downstream is reading bytes that are not an image. */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

const onDisk = (url: string) => fs.existsSync(path.join(uploadDir, path.basename(url)))

async function main() {
  console.log(`Question image e2e - ${BASE}`)
  console.log(`Upload dir: ${uploadDir}`)

  const hash = await bcrypt.hash(`pw-${RUN_ID}`, 4)
  const professor = await prisma.professor.create({
    data: { email: `${TAG}@example.invalid`, name: `Img ${RUN_ID}`, passwordHash: hash },
  })
  const student = await prisma.student.create({
    data: { netId: TAG, email: `${TAG}-s@example.invalid`, passwordHash: hash },
  })
  const cls = await prisma.class.create({
    data: {
      professorId: professor.id,
      name: `Img Class ${RUN_ID}`,
      joinCode: `IMG${RUN_ID.slice(-5).toUpperCase()}`,
    },
  })
  await prisma.enrollment.create({ data: { studentId: student.id, classId: cls.id } })
  const session = await prisma.session.create({
    data: { classId: cls.id, title: `Img Session ${RUN_ID}`, accessCode: await freeCode(), status: 'DRAFT' },
  })

  const pToken = tokenFor(professor.id, 'professor')
  const sToken = tokenFor(student.id, 'student')
  const createdUrls: string[] = []
  let dupClassId: string | undefined

  try {
    // --- Upload ---------------------------------------------------------------
    section('Upload')
    const up = await upload(pToken, PNG_1PX, 'diagram.png', 'image/png')
    check('accepts a png', up.status === 200, `status ${up.status}`)
    const imageUrl = up.body.url as string
    createdUrls.push(imageUrl)
    check('returns an /uploads path', /^\/uploads\/[0-9a-f]{32}\.png$/.test(imageUrl ?? ''), imageUrl)
    check('writes the file to disk', onDisk(imageUrl))

    const anon = await fetch(`${BASE}/api/uploads/image`, { method: 'POST', body: new FormData() })
    check('refuses an unauthenticated upload', anon.status === 401, `status ${anon.status}`)

    const tooBig = await upload(pToken, Buffer.alloc(6 * 1024 * 1024, 1), 'huge.png', 'image/png')
    check('refuses a file over 5 MB with 400', tooBig.status === 400, `status ${tooBig.status}`)
    check('says the file was too large', /5 MB/.test(JSON.stringify(tooBig.body)), JSON.stringify(tooBig.body))

    const wrongType = await upload(pToken, Buffer.from('not an image'), 'notes.txt', 'text/plain')
    check('refuses a non-image with 400', wrongType.status === 400, `status ${wrongType.status}`)

    // --- Attach ---------------------------------------------------------------
    section('Attach to a question')
    const created = await http<any>('POST', `/api/sessions/${session.id}/questions`, {
      token: pToken,
      body: { text: 'What does this spectrum show?', type: 'FREE_TEXT', imageUrl },
    })
    check('creates a question with an image', created.status === 201, `status ${created.status}`)
    const questionId = created.body?.data?.question?.id as string
    check('stores the image path', created.body?.data?.question?.imageUrl === imageUrl)

    const external = await http<any>('POST', `/api/sessions/${session.id}/questions`, {
      token: pToken,
      body: { text: 'Tracking pixel?', type: 'FREE_TEXT', imageUrl: 'https://evil.example.invalid/p.png' },
    })
    check('refuses an off-site image URL', external.status === 400, `status ${external.status}`)

    const traversal = await http<any>('POST', `/api/sessions/${session.id}/questions`, {
      token: pToken,
      body: { text: 'Traversal?', type: 'FREE_TEXT', imageUrl: '/uploads/../../.env' },
    })
    check('refuses a traversal path', traversal.status === 400, `status ${traversal.status}`)

    const detail = await http<any>('GET', `/api/sessions/${session.id}`, { token: pToken })
    const fromDetail = detail.body?.data?.session?.questions?.find((q: any) => q.id === questionId)
    check('professor session detail carries imageUrl', fromDetail?.imageUrl === imageUrl)

    // --- The student's view ---------------------------------------------------
    section('Student payload')
    // The session itself has to leave DRAFT: an open run on a draft session is still
    // invisible to students, by design.
    const run = await prisma.sessionRun.create({ data: { sessionId: session.id, status: 'OPEN' } })
    await prisma.session.update({ where: { id: session.id }, data: { status: 'OPEN' } })
    const asStudent = await http<any>('GET', `/api/student/questions/${questionId}`, { token: sToken })
    check('student can load the question', asStudent.status === 200, `status ${asStudent.status}`)
    check(
      'student payload carries imageUrl',
      asStudent.body?.data?.question?.imageUrl === imageUrl,
      String(asStudent.body?.data?.question?.imageUrl)
    )

    const served = await fetch(`${BASE}${imageUrl}`)
    check('the image is served over http', served.status === 200, `status ${served.status}`)
    check(
      'served with an image content-type',
      (served.headers.get('content-type') ?? '').startsWith('image/'),
      served.headers.get('content-type') ?? ''
    )

    // --- The mid-run lock -----------------------------------------------------
    section('Edit lock while a run is open')
    const second = await upload(pToken, PNG_1PX, 'second.png', 'image/png')
    const secondUrl = second.body.url as string
    createdUrls.push(secondUrl)

    const blocked = await http<any>('PATCH', `/api/sessions/${session.id}/questions/${questionId}`, {
      token: pToken,
      body: { imageUrl: secondUrl },
    })
    check('refuses an image swap mid-run', blocked.status === 400, `status ${blocked.status}`)
    check('says why', /run is open/.test(blocked.body?.error ?? ''), blocked.body?.error)
    check('the original image survived the refusal', onDisk(imageUrl))

    await prisma.sessionRun.update({
      where: { id: run.id },
      data: { status: 'CLOSED', closedAt: new Date() },
    })

    // --- Replace --------------------------------------------------------------
    section('Replace once the run is closed')
    const swapped = await http<any>('PATCH', `/api/sessions/${session.id}/questions/${questionId}`, {
      token: pToken,
      body: { imageUrl: secondUrl },
    })
    check('accepts the swap', swapped.status === 200, `status ${swapped.status}`)
    check('the question points at the new image', swapped.body?.data?.question?.imageUrl === secondUrl)
    check('the replaced file is deleted', !onDisk(imageUrl))
    check('the new file is on disk', onDisk(secondUrl))

    // --- Sharing, via class duplication ---------------------------------------
    section('Reference counting across a duplicated class')
    const dup = await http<any>('POST', `/api/classes/${cls.id}/duplicate`, {
      token: pToken,
      body: { name: `Img Class ${RUN_ID} copy` },
    })
    check('duplicates the class', dup.status === 200 || dup.status === 201, `status ${dup.status}`)
    dupClassId = dup.body?.data?.class?.id
    const copies = await prisma.question.findMany({
      where: { imageUrl: secondUrl },
      select: { id: true, sessionId: true },
    })
    check('both copies point at one file', copies.length === 2, `found ${copies.length}`)

    const del1 = await http<any>('DELETE', `/api/sessions/${session.id}/questions/${questionId}`, {
      token: pToken,
    })
    check('deletes the original question', del1.status === 200, `status ${del1.status}`)
    check('the shared file survives - the copy still needs it', onDisk(secondUrl))

    const copy = copies.find((c) => c.id !== questionId)
    if (copy?.sessionId) {
      const del2 = await http<any>(
        'DELETE',
        `/api/sessions/${copy.sessionId}/questions/${copy.id}`,
        { token: pToken }
      )
      check('deletes the last question holding it', del2.status === 200, `status ${del2.status}`)
      check('the file is gone once nothing points at it', !onDisk(secondUrl))
    } else {
      check('found the duplicated copy to delete', false, 'no copy with a sessionId')
    }

    // --- The cancel path ------------------------------------------------------
    section('Discarding an unsaved upload')
    const stray = await upload(pToken, PNG_1PX, 'stray.png', 'image/png')
    const strayUrl = stray.body.url as string
    createdUrls.push(strayUrl)
    const dropped = await http<any>('DELETE', '/api/uploads/image', {
      token: pToken,
      body: { url: strayUrl },
    })
    check('accepts the discard', dropped.status === 200, `status ${dropped.status}`)
    check('removes the unreferenced file', !onDisk(strayUrl))

    const keep = await upload(pToken, PNG_1PX, 'keep.png', 'image/png')
    const keepUrl = keep.body.url as string
    createdUrls.push(keepUrl)
    const keeperSession = await prisma.session.create({
      data: { classId: cls.id, title: `Keeper ${RUN_ID}`, accessCode: await freeCode(), status: 'DRAFT' },
    })
    await http<any>('POST', `/api/sessions/${keeperSession.id}/questions`, {
      token: pToken,
      body: { text: 'Keeps its image', type: 'FREE_TEXT', imageUrl: keepUrl },
    })
    const refused = await http<any>('DELETE', '/api/uploads/image', {
      token: pToken,
      body: { url: keepUrl },
    })
    check('a file a question still uses is not deleted', onDisk(keepUrl), `discard status ${refused.status}`)
  } finally {
    section('Cleanup')
    if (dupClassId) await prisma.class.delete({ where: { id: dupClassId } }).catch(() => {})
    await prisma.class.deleteMany({ where: { professorId: professor.id } })
    await prisma.professor.delete({ where: { id: professor.id } })
    await prisma.student.delete({ where: { id: student.id } })
    for (const url of createdUrls) {
      const f = path.join(uploadDir, path.basename(url))
      if (fs.existsSync(f)) fs.unlinkSync(f)
    }
    const leftovers = createdUrls.filter(onDisk)
    check('all fixture data and files removed', leftovers.length === 0, leftovers.join(', '))
    await prisma.$disconnect()
  }

  section('Result')
  console.log(`  ${passed} passed, ${failed} failed`)
  if (failures.length) {
    console.log('\nFailures:')
    for (const f of failures) console.log(`  - ${f}`)
  }
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
