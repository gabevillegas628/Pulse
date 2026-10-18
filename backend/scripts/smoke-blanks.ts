/**
 * Smoke test for fill-in-the-blank questions.
 *
 * Two halves, like smoke-autoclose:
 *
 *   1. The pure parts — the lenient matcher, the per-blank score, the reveal gate on
 *      injected time. Needs nothing running.
 *   2. The wiring, against a running server: authoring and its validation, the key
 *      following its prompt through an edit, the submit route's wall, grading, and the
 *      projector withholding answers until most of the room is in and quiet.
 *
 * Part 2 sits through one real 10s quiet spell, because that spell is the thing being
 * tested. Budget twenty seconds.
 *
 * Usage:
 *   npx tsx scripts/smoke-blanks.ts --pure-only
 *   E2E_BASE=http://localhost:3010 npx tsx scripts/smoke-blanks.ts
 *
 * Part 2 requires a server pointed at the same database this script connects to, and
 * cleans up everything it creates. Never point it at prod.
 */

import 'dotenv/config'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { blankMatches, blanksScore } from 'shared'
import { prisma } from '../src/db/index.js'
import { config } from '../src/config/index.js'
import { gradeSession } from '../src/utils/scoring.js'
import { blanksRevealed, REVEAL_QUIET_MS } from '../src/services/reveal.service.js'

const BASE = process.env.E2E_BASE ?? 'http://localhost:3001'
const RUN_ID = Date.now().toString(36)
const TAG = `smoke-bl-${RUN_ID}`

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

async function http<T = any>(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {}
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  })
  const body = await res.json().catch(() => null)
  return { status: res.status, body: body as T }
}

const tokenFor = (id: string, role: 'professor' | 'student') =>
  jwt.sign({ sub: id, role }, config.jwtSecret, { expiresIn: '1h' })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function freeCode(): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const c = String(Math.floor(Math.random() * 10000)).padStart(4, '0')
    if (!(await prisma.question.findUnique({ where: { accessCode: c } }))) return c
  }
  throw new Error('No free access code available')
}

// ─── Part 1: pure ─────────────────────────────────────────────────────────────

function pureTests() {
  section('Matcher')
  const yes: Array<[string, string]> = [
    ['Capitulum', 'capitulum'],
    ['capitelum', 'capitulum / capitellum'],
    ['the capitulum', 'capitulum'],
    ['Olecranon Fossa', 'olecranon fossa'],
    ['olecrannon fosa', 'olecranon fossa'],
    ["it's the olecranon fossa of the humerus", 'olecranon fossa'],
    ['semi-lunar', 'semilunar'],
    ['triquetral', 'triquetrum / triquetral'],
    ['scaphoids', 'scaphoid'],
    // From the first real try, 2026-10-17: the generic noun left off, a list out of order.
    ['acromial', 'Acromial end'],
    ['subscapular supraspinus infraspinous', 'Supraspinous infraspinous subscapular'],
    ['supraspinous, infraspinous and subscapular fossae', 'Supraspinous infraspinous subscapular'],
    ['glenoid cavity', 'Glenoid'],
    ['olecranon', 'olecranon fossa'],
    ['Spine', 'spine'],
    ['spine of the scapula', 'spine'],
    ['humeral head', 'head of the humerus'],
    ['Glénoid', 'glenoid'],
    ['C', 'c'],
  ]
  const no: Array<[string, string]> = [
    ['trochlea', 'capitulum'],
    ['fossa', 'olecranon fossa'],
    ['coronoid fossa', 'olecranon fossa'],
    ['lunate', 'scaphoid'],
    ['medial', 'lateral'],
    ['', 'scaphoid'],
    ['gas', 'gab'],
    ['olecranon process', 'olecranon fossa'],
    ['greater tuberosity', 'greater tubercle'],
    ['supraspinous infraspinous', 'Supraspinous infraspinous subscapular'],
    ['scaphoid lunate triquetrum pisiform', 'scaphoid'],
    ['head', 'spine'],
    ['sternal', 'Acromial end'],
  ]
  for (const [a, k] of yes) check(`"${a}" matches "${k}"`, blankMatches(a, k) === true)
  for (const [a, k] of no) check(`"${a}" does not match "${k}"`, blankMatches(a, k) === false)
  check('an unkeyed blank has no verdict', blankMatches('anything', '') === null)

  section('Score')
  const key = JSON.stringify(['capitulum', 'olecranon fossa', 'scaphoid'])
  check('all close → 1', blanksScore(JSON.stringify(['capitulum', 'olecranon fossa', 'scaphoid']), key, 3) === 1)
  check('close, wrong, empty → (1 + 0.5 + 0) / 3',
    Math.abs(blanksScore(JSON.stringify(['capitulum', 'coronoid fossa', '']), key, 3) - 0.5) < 1e-9)
  check('any attempt on an unkeyed blank earns it',
    blanksScore(JSON.stringify(['x', 'y']), JSON.stringify(['', 'y']), 2) === 1)
  check('malformed answer scores 0', blanksScore('not json', key, 3) === 0)

  section('Reveal gate')
  const t = 2_000_000_000_000
  check('nothing answered stays hidden', blanksRevealed('r', 'q0', 0, 10, null, t) === false)
  check('75% in but still arriving stays hidden', blanksRevealed('r', 'q1', 8, 10, t - 2000, t) === false)
  check('quiet but under 75% stays hidden', blanksRevealed('r', 'q1', 7, 10, t - 60_000, t) === false)
  check('75% in and quiet reveals', blanksRevealed('r', 'q1', 8, 10, t - REVEAL_QUIET_MS, t) === true)
  check('once revealed it stays revealed as the room grows',
    blanksRevealed('r', 'q1', 8, 40, t - 1, t) === true)
  check('first question of a run waits for the quiet spell',
    blanksRevealed('r', 'q2', 5, 5, t - 3000, t) === false)
  check('...and reveals once it comes', blanksRevealed('r', 'q2', 5, 5, t - REVEAL_QUIET_MS, t) === true)
  check('a reveal is per run', blanksRevealed('r2', 'q1', 1, 10, t - 60_000, t) === false)
}

// ─── Part 2: wiring ───────────────────────────────────────────────────────────

const PROMPTS = [
  'Capitulum or trochlea: which meets the radius?',
  'Which fossa holds the olecranon when the elbow is straight?',
  'Most lateral bone of the proximal carpal row?',
]
const KEY = ['capitulum', 'olecranon fossa / olecranon', 'scaphoid']

async function wiringTests() {
  const hash = await bcrypt.hash(`pw-${RUN_ID}`, 4)
  const professor = await prisma.professor.create({
    data: { email: `${TAG}@example.invalid`, name: `Smoke BL ${RUN_ID}`, passwordHash: hash },
  })
  const studentIds: string[] = []
  try {
    const cls = await prisma.class.create({
      data: { professorId: professor.id, name: `Smoke BL Class ${RUN_ID}`, joinCode: `BL${RUN_ID.slice(-6).toUpperCase()}` },
    })
    const session = await prisma.session.create({
      data: { classId: cls.id, title: `Smoke BL Session ${RUN_ID}`, accessCode: await freeCode(), status: 'OPEN' },
    })
    const prof = tokenFor(professor.id, 'professor')

    section('Authoring')
    let r = await http('POST', `/api/sessions/${session.id}/questions`, {
      token: prof, body: { text: 'Upper limb', type: 'BLANKS', options: [] },
    })
    check('no blanks is refused', r.status === 400, `got ${r.status}`)

    r = await http('POST', `/api/sessions/${session.id}/questions`, {
      token: prof, body: { text: 'Upper limb', type: 'BLANKS', options: PROMPTS, correctAnswer: JSON.stringify(['a']) },
    })
    check('a key of the wrong length is refused', r.status === 400, `got ${r.status}`)

    r = await http('POST', `/api/sessions/${session.id}/questions`, {
      token: prof, body: { text: 'Upper limb', type: 'BLANKS', options: [...PROMPTS, '  '], correctAnswer: undefined },
    })
    check('a blank-only prompt is dropped', r.status === 201 && r.body?.data?.question?.options?.length === 3,
      `got ${r.status} ${JSON.stringify(r.body?.data?.question?.options)}`)
    const qid: string = r.body?.data?.question?.id
    check('no key is stored as null', r.body?.data?.question?.correctAnswer === null)

    r = await http('PATCH', `/api/sessions/${session.id}/questions/${qid}`, {
      token: prof, body: { correctAnswer: JSON.stringify(['', '', '']) },
    })
    check('an all-empty key is stored as null', r.status === 200 && r.body?.data?.question?.correctAnswer === null)

    r = await http('PATCH', `/api/sessions/${session.id}/questions/${qid}`, {
      token: prof, body: { correctAnswer: JSON.stringify(KEY) },
    })
    check('key saves', r.status === 200 && r.body?.data?.question?.correctAnswer === JSON.stringify(KEY))

    // Reorder and add: each answer must follow its own prompt.
    const reordered = [PROMPTS[2]!, PROMPTS[0]!, 'A new blank', PROMPTS[1]!]
    r = await http('PATCH', `/api/sessions/${session.id}/questions/${qid}`, {
      token: prof, body: { options: reordered },
    })
    check('editing prompts carries each key entry with its prompt',
      r.body?.data?.question?.correctAnswer === JSON.stringify([KEY[2], KEY[0], '', KEY[1]]),
      r.body?.data?.question?.correctAnswer)
    // Put it back for the rest of the test.
    await http('PATCH', `/api/sessions/${session.id}/questions/${qid}`, { token: prof, body: { options: PROMPTS } })
    const q = await prisma.question.findUniqueOrThrow({ where: { id: qid } })
    check('...and back again', q.correctAnswer === JSON.stringify(KEY), q.correctAnswer ?? 'null')

    // A second question so part of the room can be "present" without answering the blanks.
    const other = await prisma.question.create({
      data: { sessionId: session.id, text: 'Ready?', type: 'YES_NO', order: 1, accessCode: await freeCode() },
    })

    const run = await prisma.sessionRun.create({ data: { sessionId: session.id, status: 'OPEN' } })

    r = await http('PATCH', `/api/sessions/${session.id}/questions/${qid}`, {
      token: prof, body: { correctAnswer: JSON.stringify(KEY) },
    })
    check('the key stays editable while a run is open', r.status === 200, `got ${r.status}`)

    const students = []
    for (let i = 0; i < 5; i++) {
      const s = await prisma.student.create({
        data: { netId: `${TAG}-${i}`, email: `${TAG}-${i}@example.invalid`, passwordHash: hash },
      })
      studentIds.push(s.id)
      await prisma.enrollment.create({ data: { studentId: s.id, classId: cls.id } })
      students.push({ id: s.id, token: tokenFor(s.id, 'student') })
    }

    section('Submitting')
    const submit = (i: number, responseText: string, questionId = qid) =>
      http('POST', '/api/responses', { token: students[i]!.token, body: { questionId, responseText } })

    r = await submit(0, JSON.stringify(['capitulum']))
    check('an answer of the wrong length is refused', r.status === 400, `got ${r.status}`)
    r = await submit(0, JSON.stringify(['', ' ', '']))
    check('an answer with every blank empty is refused', r.status === 400, `got ${r.status}`)
    r = await submit(0, 'capitulum')
    check('a non-array answer is refused', r.status === 400, `got ${r.status}`)

    // Two of the room answer only the other question: the room is five, the blanks get three.
    await submit(3, 'yes', other.id)
    await submit(4, 'yes', other.id)

    r = await submit(0, JSON.stringify(['  Capitulum ', 'olecranon', 'schaphoid']))
    check('a valid answer is taken', r.status === 201, `got ${r.status}`)
    check('answers are stored trimmed', r.body?.data?.response?.responseText === JSON.stringify(['Capitulum', 'olecranon', 'schaphoid']))
    await submit(1, JSON.stringify(['trochlea', 'coronoid fossa', '']))

    section('Projector, before the reveal')
    const live = async () => {
      const res = await http<any>('GET', '/api/addin/live', { token: prof })
      return (res.body?.data?.session?.questions ?? []).find((x: any) => x.id === qid)
    }
    let lq = await live()
    check('answers are hidden at 2 of 5', lq?.answersHidden === true)
    check('hidden answers carry no text', lq?.responses?.length === 2 && lq.responses.every((x: any) => !('responseText' in x)))

    await submit(2, JSON.stringify(['capitulum', 'olecranon fossa', 'scaphoid']))
    lq = await live()
    check('3 of 5 is under 75%, still hidden', lq?.answersHidden === true)
    await submit(3, JSON.stringify(['capitulum', '', 'lunate']))
    lq = await live()
    check('4 of 5 but answers still arriving, still hidden', lq?.answersHidden === true)
    check('the key is not on the projector', lq?.correctAnswer === null)

    console.log(`  … waiting out the ${REVEAL_QUIET_MS / 1000}s quiet spell`)
    await sleep(REVEAL_QUIET_MS + 1500)

    section('Projector, after the reveal')
    lq = await live()
    check('revealed once most of the room is in and quiet', lq?.answersHidden === false)
    check('revealed answers carry their text', lq?.responses?.every((x: any) => typeof x.responseText === 'string'))
    const byText = new Map<string, any>(lq?.responses?.map((x: any) => [x.responseText, x]) ?? [])
    const first = byText.get(JSON.stringify(['Capitulum', 'olecranon', 'schaphoid']))
    check('verdicts ride along per blank', JSON.stringify(first?.blankVerdicts) === '[true,true,true]',
      JSON.stringify(first?.blankVerdicts))
    check('the key itself still is not shipped', lq?.correctAnswer === null)

    section('Grading')
    const responses = await prisma.response.findMany({ where: { questionId: qid } })
    const expect: Record<string, number> = {
      [students[0]!.id]: 1,
      [students[1]!.id]: (0.5 + 0.5 + 0) / 3,
      [students[2]!.id]: 1,
      [students[3]!.id]: (1 + 0 + 0.5) / 3,
    }
    for (const resp of responses) {
      const g = gradeSession('IN_CLASS', [{
        id: qid, type: 'BLANKS', correctAnswer: JSON.stringify(KEY),
        totalResponseCount: responses.length, hasAnyAiScore: false,
        studentResponse: { responseText: resp.responseText, aiScore: resp.aiScore },
      }])
      const want = expect[resp.studentId]!
      check(`student ${students.findIndex((s) => s.id === resp.studentId)} scores ${want.toFixed(2)}`,
        Math.abs(g.questions[0]!.score - want) < 1e-9, `got ${g.questions[0]!.score}`)
    }
    const unkeyed = gradeSession('IN_CLASS', [{
      id: qid, type: 'BLANKS', correctAnswer: null, totalResponseCount: 1, hasAnyAiScore: false,
      studentResponse: { responseText: '["x","",""]', aiScore: null },
    }])
    check('an unkeyed question does not count', unkeyed.max === 0)

    void run
  } finally {
    await prisma.class.deleteMany({ where: { professorId: professor.id } }).catch(() => {})
    await prisma.professor.delete({ where: { id: professor.id } }).catch(() => {})
    for (const id of studentIds) await prisma.student.delete({ where: { id } }).catch(() => {})
  }
}

async function main() {
  pureTests()
  if (!process.argv.includes('--pure-only')) await wiringTests()
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed) {
    console.log('\nFailures:')
    for (const f of failures) console.log(`  - ${f}`)
  }
  await prisma.$disconnect()
  process.exit(failed ? 1 : 0)
}

main().catch(async (err) => {
  console.error(err)
  await prisma.$disconnect()
  process.exit(1)
})
