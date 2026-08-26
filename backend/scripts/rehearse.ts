/**
 * Rehearsal driver — plays a fake class into a real question so you can watch.
 *
 * The smoke test proves the system is correct; it tears everything down in seconds with
 * nobody looking. This is the opposite: it drives the real student route at a realistic
 * pace and leaves the data standing, so you can sit in front of the projector and watch
 * categories assemble the way a room would make them.
 *
 * It exercises the whole chain — student submit, the debounced worker, the Opus
 * bootstrap, the Haiku classifier, the socket, /present, and the add-in if you have the
 * deck open — against a question you actually intend to ask.
 *
 * Answers are generated for whatever question the code resolves to, so this works on
 * your real slide rather than only on a question someone wrote fixtures for.
 *
 * Usage:
 *   npm run rehearse -- --code 4821                   # 30 students, realistic pace
 *   npm run rehearse -- --code 4821 --students 60
 *   npm run rehearse -- --code 4821 --speed 4         # 4x faster, for a quick check
 *   npm run rehearse -- --code 4821 --dry-run         # generate answers, submit nothing
 *   npm run rehearse -- --code 4821 --cleanup         # remove the fake class afterwards
 *
 * Before running: open the session so a run is live, and have /present up.
 *
 * This writes to whatever DATABASE_URL points at. It refuses to touch a question that
 * already has real answers unless you pass --force.
 */

import 'dotenv/config'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import Anthropic from '@anthropic-ai/sdk'
import * as z4 from 'zod/v4'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { prisma } from '../src/db/index.js'
import { config } from '../src/config/index.js'

const BASE = process.env.E2E_BASE ?? 'http://localhost:3001'

/** Every account this script creates carries this prefix, and cleanup keys off it. */
const PREFIX = 'rehearsal-'

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey })

// ─── Arguments ────────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const flag = (name: string) => process.argv.includes(`--${name}`)

const CODE = arg('code')
const STUDENTS = Number(arg('students') ?? 30)
const SPEED = Number(arg('speed') ?? 1)
const CLEANUP = flag('cleanup')
const DRY_RUN = flag('dry-run')
const FORCE = flag('force')
const ENABLE_THEMES = flag('enable-themes')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const tokenFor = (id: string, role: 'student') =>
  jwt.sign({ sub: id, role }, config.jwtSecret, { expiresIn: '4h' })

// ─── Arrival timing ───────────────────────────────────────────────────────────

/**
 * When each answer lands, in milliseconds from the start.
 *
 * A real room does not answer simultaneously and does not answer at a steady rate.
 * Nobody responds for the first few seconds while people read the slide and scan, then
 * the confident answer in a burst, then the gaps stretch out as the stragglers finish.
 * Submitting all at once would classify in one batch and prove nothing about how the
 * bars actually move in front of a room.
 */
function arrivalOffsets(n: number): number[] {
  const out: number[] = []
  let t = 4000 + Math.random() * 4000
  for (let i = 0; i < n; i++) {
    out.push(Math.round(t / SPEED))
    const progress = n > 1 ? i / (n - 1) : 1
    // Mean gap widens quadratically: quick at first, a long tail at the end.
    const mean = 900 + progress * progress * 6000
    t += -Math.log(1 - Math.random()) * mean
  }
  return out
}

// ─── Answer generation ────────────────────────────────────────────────────────

const answerSchema = z4.object({
  answers: z4.array(
    z4.object({
      text: z4.string(),
      kind: z4.enum(['solid', 'partial', 'confused', 'noneffort']),
    })
  ),
})

/**
 * A class's worth of answers to this specific question.
 *
 * Deliberately uneven. A rehearsal where every answer is thoughtful and well-formed
 * tells you nothing about how the Forming bucket behaves, or whether the categories
 * survive contact with a student who wrote "idk".
 */
async function generateAnswers(questionText: string, n: number) {
  console.log(`  generating ${n} answers for this question…`)
  const res = await anthropic.messages.parse({
    model: 'claude-opus-5',
    max_tokens: 8192,
    output_config: { format: zodOutputFormat(answerSchema) },
    messages: [
      {
        role: 'user',
        content: `Write ${n} answers to a classroom question, as a real undergraduate class would answer it — in a hurry, on their phones, with no spell-check.

Question: "${questionText}"

Make them realistic rather than good:
- Three or four genuinely different ways of approaching it should emerge naturally across the class. Do not label them; just write answers that fall that way.
- Vary the length a lot. Some are one clause, some are three sentences.
- About 60% should be roughly right ("solid"), 20% partly right or vague ("partial"), 10% confused or wrong but sincere ("confused"), and 10% no effort at all ("noneffort") — "idk", "not sure", a single word, a keyboard mash.
- Typos, missing capitals and informal phrasing are welcome. Nobody is writing an essay.
- No two answers should be identical.

Return exactly ${n}.`,
      },
    ],
  })
  const parsed = res.parsed_output
  if (!parsed) throw new Error('Could not generate answers')
  return parsed.answers.slice(0, n)
}

// ─── Target lookup ────────────────────────────────────────────────────────────

async function resolveTarget(code: string) {
  const question = await prisma.question.findUnique({
    where: { accessCode: code },
    select: {
      id: true,
      text: true,
      type: true,
      liveThemes: true,
      sessionId: true,
      session: {
        select: {
          id: true,
          title: true,
          classId: true,
          class: { select: { name: true, liveThemesDefault: true } },
          runs: { where: { status: 'OPEN' }, select: { id: true, sectionId: true } },
        },
      },
    },
  })
  if (!question) throw new Error(`No question has access code ${code}`)
  if (!question.sessionId || !question.session) {
    throw new Error('That code belongs to an assignment question. Rehearsal only drives in-class sessions.')
  }
  if (question.type !== 'FREE_TEXT') {
    throw new Error(`That question is ${question.type}. Live themes only apply to FREE_TEXT.`)
  }
  return question
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

/**
 * Remove the fake class. Responses cascade from the students, and the theme set for
 * this question's run goes too, so the question is left exactly as it was found.
 */
async function cleanup(questionId: string | null) {
  const students = await prisma.student.findMany({
    where: { netId: { startsWith: PREFIX } },
    select: { id: true, netId: true },
  })
  console.log(`  ${students.length} rehearsal accounts to remove`)

  if (questionId) {
    const sets = await prisma.themeSet.findMany({ where: { questionId }, select: { id: true } })
    if (sets.length) {
      await prisma.themeSet.deleteMany({ where: { questionId } })
      console.log(`  removed ${sets.length} theme set(s) for the question`)
    }
  }

  let removed = 0
  for (const s of students) {
    await prisma.student.delete({ where: { id: s.id } }).catch(() => {})
    removed++
  }
  console.log(`  removed ${removed} accounts and their responses`)

  const left = await prisma.student.count({ where: { netId: { startsWith: PREFIX } } })
  console.log(left === 0 ? '  clean' : `  WARNING: ${left} accounts remain`)
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!CODE) {
    console.error('Usage: npm run rehearse -- --code <4-digit question code> [--students 30] [--speed 1] [--cleanup] [--dry-run]')
    process.exit(1)
  }

  const question = await resolveTarget(CODE)
  const session = question.session!

  console.log('Pulse rehearsal')
  console.log(`  class    : ${session.class.name}`)
  console.log(`  session  : ${session.title}`)
  console.log(`  question : ${question.text}`)

  if (CLEANUP) {
    console.log('\n=== Cleanup ===')
    await cleanup(question.id)
    await prisma.$disconnect()
    return
  }

  // ── Preconditions, said plainly rather than failing halfway through ──────────
  const openRun = session.runs[0]
  if (!openRun) {
    throw new Error('No run is open for that session. Open it in Pulse first — that is what a student scanning would need too.')
  }

  const themesOn = question.liveThemes ?? session.class.liveThemesDefault
  if (!themesOn) {
    if (!ENABLE_THEMES) {
      throw new Error('Live themes are off for this question. Turn them on in Pulse, or re-run with --enable-themes.')
    }
    await prisma.question.update({ where: { id: question.id }, data: { liveThemes: true } })
    console.log('  themes   : switched on for this question')
  } else {
    console.log('  themes   : on')
  }

  // Never pollute a question that has real answers in it.
  const existing = await prisma.response.findMany({
    where: { questionId: question.id },
    select: { student: { select: { netId: true } } },
  })
  const real = existing.filter((r) => !r.student.netId.startsWith(PREFIX)).length
  if (real > 0 && !FORCE) {
    throw new Error(
      `That question already has ${real} answer(s) from real accounts. Refusing to add fake ones. Pass --force if you are sure.`
    )
  }
  if (existing.length > real) {
    console.log(`  note     : ${existing.length - real} rehearsal answers already present; they cannot answer twice`)
  }

  const answers = await generateAnswers(question.text, STUDENTS)
  const spread = answers.reduce<Record<string, number>>((acc, a) => {
    acc[a.kind] = (acc[a.kind] ?? 0) + 1
    return acc
  }, {})
  console.log(`  mix      : ${Object.entries(spread).map(([k, v]) => `${v} ${k}`).join(', ')}`)

  if (DRY_RUN) {
    console.log('\n--- generated answers (nothing submitted) ---')
    answers.forEach((a, i) => console.log(`  [${String(i).padStart(2)}] (${a.kind}) ${a.text}`))
    await prisma.$disconnect()
    return
  }

  // ── Build the fake class ────────────────────────────────────────────────────
  const stamp = Date.now().toString(36)
  const hash = await bcrypt.hash(`rehearse-${stamp}`, 4)
  console.log(`\n  creating ${STUDENTS} accounts…`)

  await prisma.student.createMany({
    data: answers.map((_, i) => ({
      netId: `${PREFIX}${stamp}-${i}`,
      email: `${PREFIX}${stamp}-${i}@example.invalid`,
      passwordHash: hash,
    })),
  })
  const students = await prisma.student.findMany({
    where: { netId: { startsWith: `${PREFIX}${stamp}-` } },
    select: { id: true, netId: true },
  })
  const byIndex = new Map(students.map((s) => [Number(s.netId.split('-').pop()), s.id]))

  // Match the open run's section, or a section-specific run would reject every answer.
  await prisma.enrollment.createMany({
    data: students.map((s) => ({
      studentId: s.id,
      classId: session.classId,
      sectionId: openRun.sectionId,
    })),
    skipDuplicates: true,
  })

  // ── Play the class in ───────────────────────────────────────────────────────
  const offsets = arrivalOffsets(answers.length)
  const span = offsets[offsets.length - 1] ?? 0
  console.log(`  answers arrive over ${(span / 1000).toFixed(0)}s${SPEED !== 1 ? ` (${SPEED}x)` : ''}`)
  console.log('\n  Watch /present now.\n')

  const started = Date.now()
  let sent = 0
  let failed = 0

  for (let i = 0; i < answers.length; i++) {
    const wait = offsets[i]! - (Date.now() - started)
    if (wait > 0) await sleep(wait)

    const studentId = byIndex.get(i)
    if (!studentId) continue

    try {
      const res = await fetch(`${BASE}/api/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenFor(studentId, 'student')}`,
        },
        body: JSON.stringify({ questionId: question.id, responseText: answers[i]!.text }),
      })
      if (res.ok) sent++
      else {
        failed++
        const body = await res.json().catch(() => null)
        console.log(`  [${((Date.now() - started) / 1000).toFixed(1)}s] REJECTED ${res.status}: ${(body as any)?.error ?? ''}`)
      }
    } catch (err) {
      failed++
      console.log(`  submit failed: ${err instanceof Error ? err.message : String(err)}`)
    }

    const t = ((Date.now() - started) / 1000).toFixed(1)
    process.stdout.write(`\r  [${t.padStart(5)}s] ${sent}/${answers.length} answered${failed ? `, ${failed} rejected` : ''}   `)
  }

  console.log('\n')

  // ── Let the worker finish, then report what the room produced ───────────────
  console.log('  waiting for classification to settle…')
  let last: any = null
  for (let i = 0; i < 90; i++) {
    await sleep(2000)
    const set = await prisma.themeSet.findFirst({
      where: { questionId: question.id, runId: openRun.id },
      include: { categories: { orderBy: { order: 'asc' } } },
    })
    if (!set) continue
    const counts = await prisma.responseTheme.groupBy({
      by: ['categoryId'],
      where: { category: { themeSetId: set.id } },
      _count: { _all: true },
    })
    const classified = counts.reduce((s, c) => s + c._count._all, 0)
    const total = await prisma.response.count({ where: { questionId: question.id, runId: openRun.id } })
    last = { set, counts: new Map(counts.map((c) => [c.categoryId, c._count._all])), classified, total }
    if (classified >= total) break
  }

  console.log('\n=== What the room produced ===')
  if (!last) {
    console.log('  No themes were derived. Fewer than 8 answers landed, or the worker failed — check the server log.')
  } else {
    for (const c of last.set.categories) {
      const n = last.counts.get(c.id) ?? 0
      console.log(`  ${String(n).padStart(4)}  ${c.label}${c.isOther ? '  (forming)' : ''}`)
    }
    console.log(`\n  ${last.classified} of ${last.total} classified · model ${last.set.model} · ${last.set.classifyCalls} classify call(s)`)
  }

  console.log(`\nThe fake class is still in place so you can look at it.`)
  console.log(`Remove it with:  npm run rehearse -- --code ${CODE} --cleanup`)

  await prisma.$disconnect()
}

main().catch(async (err) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`)
  await prisma.$disconnect()
  process.exit(1)
})
