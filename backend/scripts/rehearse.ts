/**
 * Rehearsal driver — plays a fake class into a real question so you can watch.
 *
 * The smoke test proves the system is correct; it tears everything down in seconds with
 * nobody looking. This is the opposite: it drives the real student route at a realistic
 * pace and leaves the data standing, so you can sit in front of the projector and watch
 * categories assemble the way a room would make them.
 *
 * It exercises the whole chain — student submit, the socket, /present, and the add-in if
 * you have the deck open — against a question you actually intend to ask. On FREE_TEXT it
 * also drives the theme chain: the debounced worker, the Opus bootstrap, the Haiku
 * classifier.
 *
 * Answers are generated for whatever question the code resolves to, so this works on
 * your real slide rather than only on a question someone wrote fixtures for.
 *
 * Every question type is playable except STRUCTURE:
 *
 *   FREE_TEXT        Opus writes a class's worth of answers to this specific question.
 *   MULTIPLE_CHOICE  A leader, a distractor that pulled people, and a thin tail.
 *   MULTI_SELECT     Mostly the correct set, with dropped and spurious picks around it.
 *   YES_NO           Roughly two to one, leaning toward the correct side when one is set.
 *   RATING           A bell centred on the correct value, or on 4 when none is set.
 *   ORDERING         The right order, near-misses an adjacent swap away, a few shuffles.
 *   NUMERIC          A cluster inside tolerance, near misses, decimal-place errors.
 *
 * Only FREE_TEXT costs a model call. The rest are shaped locally, so iterating on how a
 * type looks on the projector is instant and free.
 *
 * Usage (run it directly — see the note below):
 *   npx tsx scripts/rehearse.ts --code 4821                 # 30 students, realistic pace
 *   npx tsx scripts/rehearse.ts --code 4821 --students 60
 *   npx tsx scripts/rehearse.ts --code 4821 --speed 4       # 4x faster, for a quick check
 *   npx tsx scripts/rehearse.ts --code 4821 --preview       # generate answers, submit nothing
 *   npx tsx scripts/rehearse.ts --code 4821 --cleanup       # remove the fake class afterwards
 *
 * Prefer the direct form over `npm run`. PowerShell drops the `--` separator, so npm
 * reads the flags as its own config and swallows them — `--dry-run` and `--force` are
 * genuinely npm flags, and unknown ones get eaten too. The code is also accepted as a
 * bare positional (`npm run rehearse -- 4821`) so the mangled form still works.
 *
 * Before running: open the session so a run is live, and have /present up.
 *
 * This writes to whatever DATABASE_URL points at. It refuses to touch a question that
 * already has real answers unless you pass --allow-real.
 */

import 'dotenv/config'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import Anthropic from '@anthropic-ai/sdk'
import * as z4 from 'zod/v4'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { prisma } from '../src/db/index.js'
import { config } from '../src/config/index.js'

/**
 * Where to submit answers. Its own variable on purpose.
 *
 * Not `BASE_URL` — that is the public address baked into QR codes, so it points at the
 * deployed app. Sending there mints tokens with the local JWT_SECRET and hands them to a
 * server running a different one, which rejects every submission as 401. This wants a
 * server that shares this .env, which in practice means the local dev server.
 */
const BASE = process.env.REHEARSE_BASE ?? 'http://127.0.0.1:3001'

/** Every account this script creates carries this prefix, and cleanup keys off it. */
const PREFIX = 'rehearsal-'

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey })

// ─── Arguments ────────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const flag = (...names: string[]) => names.some((n) => process.argv.includes(`--${n}`))

/**
 * The code may be given as `--code 8039` or bare. Bare matters: PowerShell drops the
 * `--` separator in `npm run rehearse -- --code 8039`, so npm treats what follows as its
 * own config and swallows it, forwarding only the loose number. Accepting a positional
 * means the mangled form still works.
 */
const positional = process.argv.slice(2).find((a) => /^\d{3,6}$/.test(a))
const CODE = arg('code') ?? positional

const STUDENTS = Number(arg('students') ?? 30)
const SPEED = Number(arg('speed') ?? 1)
const CLEANUP = flag('cleanup')
// `--dry-run` and `--force` are npm's own flags and never survive `npm run`. The real
// names are ones npm has no opinion about; the originals stay as aliases for anyone
// invoking the script directly.
const DRY_RUN = flag('preview', 'dry-run')
const FORCE = flag('allow-real', 'force')
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

// ─── Answer generation: every other type ──────────────────────────────────────

/**
 * The remaining types are shaped here rather than by a model.
 *
 * For a fixed set of options a model call buys nothing and costs a wait: what makes a
 * distribution worth looking at on a projector is its shape, not its prose. Shaping it
 * here also means the shape is deliberate — a leader, a distractor that genuinely pulled
 * people, a thin tail — rather than whatever the sampler felt like on that run. A flat
 * five-way split reads as a bug from the back of a room.
 */

const OPTION_TYPES = ['MULTIPLE_CHOICE', 'MULTI_SELECT', 'ORDERING']

type Generated = { text: string; kind: string }

/** Question.options is a Json column, so it arrives as unknown and has to be narrowed. */
function optionList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((o): o is string => typeof o === 'string') : []
}

/** A JSON array of strings, or null when the column holds anything else. */
function jsonList(raw: string | null): string[] | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) && parsed.every((v) => typeof v === 'string')
      ? (parsed as string[])
      : null
  } catch {
    return null
  }
}

/** One weighted draw. Weights are relative; they need not sum to anything. */
function weightedPick<T>(entries: [T, number][]): T {
  const total = entries.reduce((s, [, w]) => s + w, 0)
  let r = Math.random() * total
  for (const [value, w] of entries) {
    r -= w
    if (r <= 0) return value
  }
  return entries[entries.length - 1]![0]
}

function shuffled<T>(xs: T[]): T[] {
  return [...xs].sort(() => Math.random() - 0.5)
}

function multipleChoice(opts: string[], correct: string | null, n: number): Generated[] {
  // With no correct answer there is still a leader — just an arbitrary one. Drawing it
  // rather than taking opts[0] keeps option A from winning every rehearsal.
  const leader = correct && opts.includes(correct)
    ? correct
    : opts[Math.floor(Math.random() * opts.length)]!
  const rest = opts.filter((o) => o !== leader)
  const distractor = rest.length > 0 ? rest[Math.floor(Math.random() * rest.length)]! : null
  const tail = Math.max(1, rest.length - 1)
  const weights: [string, number][] = opts.map((o) => [
    o,
    o === leader ? 46 : o === distractor ? 24 : 30 / tail,
  ])
  return Array.from({ length: n }, () => {
    const text = weightedPick<string>(weights)
    return { text, kind: !correct ? 'answer' : text === correct ? 'correct' : 'incorrect' }
  })
}

function multiSelect(opts: string[], correct: string | null, n: number): Generated[] {
  // Option order throughout, not pick order, so the same set always serialises the same
  // way and the per-option tally lines up.
  const declared = jsonList(correct)
  // No declared set, so the class still converges on something — just not on anything
  // meaningful. Drawn rather than taken off the front, so option A does not win every
  // rehearsal. Either way the result is re-read in option order below.
  const wanted = declared ?? shuffled(opts).slice(0, Math.max(1, Math.round(opts.length / 2)))
  const target = opts.filter((o) => wanted.includes(o))

  return Array.from({ length: n }, () => {
    const move = weightedPick<'exact' | 'dropped' | 'extra' | 'wild'>([
      ['exact', 44], ['dropped', 24], ['extra', 20], ['wild', 12],
    ])
    let chosen = [...target]
    if (move === 'dropped' && chosen.length > 1) {
      chosen.splice(Math.floor(Math.random() * chosen.length), 1)
    } else if (move === 'extra') {
      const spare = opts.filter((o) => !chosen.includes(o))
      if (spare.length > 0) chosen.push(spare[Math.floor(Math.random() * spare.length)]!)
    } else if (move === 'wild') {
      chosen = shuffled(opts).slice(0, 1 + Math.floor(Math.random() * opts.length))
    }
    // The answer page will not submit an empty selection, so neither does this.
    if (chosen.length === 0) chosen = [opts[0]!]

    const ordered = opts.filter((o) => chosen.includes(o))
    // Judge the result, not the intent: dropping from a single-item set is a no-op, and
    // two swaps can land back where they started.
    const exact = ordered.length === target.length && ordered.every((o, i) => o === target[i])
    // Only call it correct when the question says what correct is. Otherwise this is the
    // set the room happened to converge on, which is not the same claim.
    return {
      text: JSON.stringify(ordered),
      kind: !declared ? 'answer' : exact ? 'correct' : 'incorrect',
    }
  })
}

function yesNo(correct: string | null, n: number): Generated[] {
  // Leans toward the correct side when there is one, and otherwise picks a side to lean,
  // so the two bars are never a dead heat.
  const yesWeight = correct === 'Yes' ? 66 : correct === 'No' ? 34 : Math.random() < 0.5 ? 62 : 38
  return Array.from({ length: n }, () => {
    const text = weightedPick<string>([['yes', yesWeight], ['no', 100 - yesWeight]])
    return {
      text,
      kind: !correct ? 'answer' : text === correct.toLowerCase() ? 'correct' : 'incorrect',
    }
  })
}

function rating(correct: string | null, n: number): Generated[] {
  // Centred on the correct value when one is set, otherwise on 4: a class asked to rate
  // something rates it generously, and a bell centred on 3 looks synthetic.
  const parsed = Number(correct)
  const centre = Number.isInteger(parsed) && parsed >= 1 && parsed <= 5 ? parsed : 4
  const weights: [string, number][] = [1, 2, 3, 4, 5].map((v) => {
    const d = Math.abs(v - centre)
    return [String(v), d === 0 ? 42 : d === 1 ? 22 : d === 2 ? 8 : 3]
  })
  return Array.from({ length: n }, () => {
    const text = weightedPick<string>(weights)
    return { text, kind: `rated ${text}` }
  })
}

function ordering(opts: string[], correct: string | null, n: number): Generated[] {
  // The editor writes the right sequence into correctAnswer as JSON; option order is the
  // same thing when it has not been set.
  const declared = jsonList(correct)
  const known = !!declared && declared.length === opts.length && declared.every((o) => opts.includes(o))
  const seq = known ? declared! : opts

  function swapAdjacent(xs: string[]): string[] {
    if (xs.length < 2) return xs
    const i = Math.floor(Math.random() * (xs.length - 1))
    const out = [...xs]
    const held = out[i]!
    out[i] = out[i + 1]!
    out[i + 1] = held
    return out
  }

  return Array.from({ length: n }, () => {
    // Adjacent swaps rather than free permutations. Wrong answers then land on each other,
    // so the panel shows a few orderings with counts instead of n groups of one — which is
    // both what a real class produces and the only version that reads on a slide.
    const move = weightedPick<'exact' | 'one' | 'two' | 'wild'>([
      ['exact', 34], ['one', 36], ['two', 18], ['wild', 12],
    ])
    let out = [...seq]
    if (move === 'one') out = swapAdjacent(out)
    else if (move === 'two') out = swapAdjacent(swapAdjacent(out))
    else if (move === 'wild') out = shuffled(out)
    const exact = out.every((o, i) => o === seq[i])
    // Option order is a guess at the right order, not a statement of it.
    return { text: JSON.stringify(out), kind: !known ? 'answer' : exact ? 'correct' : 'incorrect' }
  })
}

function numeric(correct: string | null, unit: string | null, tolerance: number | null, n: number): Generated[] {
  const parsed = Number(correct)
  // With no correct answer there is nothing to be near, so the spread gets an arbitrary
  // centre. The shape stays representative even though the value means nothing — and
  // nothing generated against it gets called right or wrong.
  const known = !!correct && correct.trim() !== '' && Number.isFinite(parsed)
  const target = known ? parsed : 100
  const band = tolerance && tolerance > 0 ? tolerance : Math.abs(target) * 0.02 || 1

  const tidy = (v: number) => {
    const s = Number(v.toPrecision(4)).toString()
    return unit ? `${s} ${unit}` : s
  }

  return Array.from({ length: n }, () => {
    const move = weightedPick<'inside' | 'near' | 'decimal' | 'wild'>([
      ['inside', 58], ['near', 17], ['decimal', 15], ['wild', 10],
    ])
    const sign = Math.random() < 0.5 ? -1 : 1
    let v: number
    if (move === 'inside') v = target + sign * Math.random() * band
    else if (move === 'near') v = target + sign * band * (1.2 + Math.random())
    // Right digits, wrong place. The most common real wrong answer there is.
    else if (move === 'decimal') v = target * (Math.random() < 0.5 ? 10 : 0.1)
    else v = target * (0.2 + Math.random() * 3)
    return { text: tidy(v), kind: !known ? 'answer' : move === 'inside' ? 'correct' : move }
  })
}

/** Whatever this question needs, by type. Only FREE_TEXT reaches for a model. */
async function buildAnswers(
  q: { type: string; text: string; options: unknown; correctAnswer: string | null; unit: string | null; tolerance: number | null },
  n: number
): Promise<Generated[]> {
  const opts = optionList(q.options)
  switch (q.type) {
    case 'FREE_TEXT': return generateAnswers(q.text, n)
    case 'MULTIPLE_CHOICE': return multipleChoice(opts, q.correctAnswer, n)
    case 'MULTI_SELECT': return multiSelect(opts, q.correctAnswer, n)
    case 'YES_NO': return yesNo(q.correctAnswer, n)
    case 'RATING': return rating(q.correctAnswer, n)
    case 'ORDERING': return ordering(opts, q.correctAnswer, n)
    case 'NUMERIC': return numeric(q.correctAnswer, q.unit, q.tolerance, n)
    default: throw new Error(`Rehearsal does not know how to answer a ${q.type} question.`)
  }
}

/** JSON-encoded answers are unreadable in a terminal; everything else is already fine. */
function readable(text: string): string {
  const list = jsonList(text)
  return list ? list.join(' → ') : text
}

/** Identical answers counted together, commonest first. */
function tally(texts: string[]): [string, number][] {
  const counts = new Map<string, number>()
  for (const t of texts) counts.set(t, (counts.get(t) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])
}

// ─── Target lookup ────────────────────────────────────────────────────────────

async function resolveTarget(code: string) {
  const question = await prisma.question.findUnique({
    where: { accessCode: code },
    select: {
      id: true,
      text: true,
      type: true,
      options: true,
      correctAnswer: true,
      unit: true,
      tolerance: true,
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
  // STRUCTURE is the one type worth refusing. A submission is a molfile that the server
  // runs through Indigo to get an InChI, so a fake answer means a real drawing rather than
  // a shaped value — and the results panel renders nothing for STRUCTURE anyway, so there
  // would be nothing on the projector to look at.
  if (question.type === 'STRUCTURE') {
    throw new Error('That question is STRUCTURE. Rehearsal cannot draw molecules, and results show nothing for it.')
  }

  // Fail here rather than generating a class's worth of answers to options that do not
  // exist and watching the server take every one of them.
  if (OPTION_TYPES.includes(question.type) && optionList(question.options).length === 0) {
    throw new Error(`That ${question.type} question has no options set. Add them in Pulse first.`)
  }

  return question
}

// ─── Preflight ────────────────────────────────────────────────────────────────

/**
 * Prove a student can actually submit, before building a class of thirty who cannot.
 *
 * Uses one throwaway account against a read-only route, then deletes it. This catches
 * the three ways the run dies partway through — nothing listening, a server whose
 * JWT_SECRET differs from this .env, and a session that is not open — and reports which,
 * rather than leaving thirty orphaned accounts and a wall of identical errors.
 */
async function preflight(code: string): Promise<void> {
  const probe = await prisma.student.create({
    data: {
      netId: `${PREFIX}probe-${Date.now().toString(36)}`,
      email: `${PREFIX}probe-${Date.now().toString(36)}@example.invalid`,
      passwordHash: await bcrypt.hash('probe', 4),
    },
  })

  try {
    let res: Awaited<ReturnType<typeof fetch>>
    try {
      res = await fetch(`${BASE}/api/questions/by-code/${code}`, {
        headers: { Authorization: `Bearer ${tokenFor(probe.id, 'student')}` },
      })
    } catch {
      throw new Error(
        `Cannot reach ${BASE}.\n` +
        `Start the backend with \`npm run dev\` first, or set REHEARSE_BASE to a server that shares this .env.`
      )
    }

    if (res.status === 401) {
      throw new Error(
        `${BASE} rejected a freshly minted student token (401).\n` +
        `That server verifies with a different JWT_SECRET than this .env holds — it is almost\n` +
        `certainly a deployed instance rather than your local dev server. Rehearsal needs one\n` +
        `that shares this .env, so run \`npm run dev\` and leave REHEARSE_BASE unset.`
      )
    }
    if (res.status === 409) {
      const body = await res.json().catch(() => null)
      throw new Error(`The server will not accept answers yet: ${(body as any)?.error ?? 'session not open'}`)
    }
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      throw new Error(`Unexpected ${res.status} from ${BASE}: ${(body as any)?.error ?? ''}`)
    }
  } finally {
    await prisma.student.delete({ where: { id: probe.id } }).catch(() => {})
  }
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

/**
 * Remove the fake students — the cohort, never the class, session or question.
 *
 * Deletes only Student rows carrying the rehearsal prefix; their enrolments and answers
 * cascade with them. Nothing owned by a real student is touched.
 *
 * The theme set is a separate judgement. Dropping it restores a rehearsed question to
 * untouched, but if real answers are also on that question the categories may have been
 * derived from them, so it is left alone in that case — better a stale set the professor
 * can regenerate than quietly deleting their real work.
 */
async function cleanup(questionId: string | null) {
  const students = await prisma.student.findMany({
    where: { netId: { startsWith: PREFIX } },
    select: { id: true },
  })
  const answers = await prisma.response.count({
    where: { student: { netId: { startsWith: PREFIX } } },
  })
  console.log(`  ${students.length} rehearsal account(s), ${answers} rehearsal answer(s)`)
  console.log('  (classes, sessions, questions and real students are not touched)')

  if (questionId) {
    const realLeft = await prisma.response.count({
      where: { questionId, student: { netId: { not: { startsWith: PREFIX } } } },
    })
    const sets = await prisma.themeSet.count({ where: { questionId } })
    if (sets === 0) {
      // nothing to say
    } else if (realLeft > 0) {
      console.log(`  keeping ${sets} theme set(s): the question also holds ${realLeft} real answer(s)`)
    } else {
      await prisma.themeSet.deleteMany({ where: { questionId } })
      console.log(`  removed ${sets} theme set(s) — no real answers remain on that question`)
    }
  }

  let removed = 0
  for (const s of students) {
    await prisma.student.delete({ where: { id: s.id } }).catch(() => {})
    removed++
  }
  console.log(`  removed ${removed} account(s) and their answers`)

  const left = await prisma.student.count({ where: { netId: { startsWith: PREFIX } } })
  console.log(left === 0 ? '  clean' : `  WARNING: ${left} account(s) remain`)
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!CODE && !CLEANUP) {
    console.error('Usage: npx tsx scripts/rehearse.ts --code <4-digit code> [--students 30] [--speed 1] [--preview] [--cleanup]')
    console.error('')
    console.error('Run it directly rather than through `npm run`: PowerShell drops the `--`')
    console.error('separator, so npm reads the flags as its own config and swallows them.')
    process.exit(1)
  }

  // Cleanup without a code is the common case after an aborted run: sweep the accounts
  // and leave every question alone, including any themes on them.
  if (CLEANUP && !CODE) {
    console.log('Pulse rehearsal — cleanup (accounts only, no question named)')
    await cleanup(null)
    await prisma.$disconnect()
    return
  }

  const question = await resolveTarget(CODE!)
  const session = question.session!

  console.log('Pulse rehearsal')
  console.log(`  class    : ${session.class.name}`)
  console.log(`  session  : ${session.title}`)
  console.log(`  question : ${question.text}`)
  console.log(`  type     : ${question.type}`)

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

  // Themes are a FREE_TEXT concern only — the flag is ignored for every other type, so
  // demanding it would block the types this script was just taught to drive.
  const isFreeText = question.type === 'FREE_TEXT'
  if (isFreeText) {
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
  }

  // Never pollute a question that has real answers in it.
  const existing = await prisma.response.findMany({
    where: { questionId: question.id },
    select: { student: { select: { netId: true } } },
  })
  const real = existing.filter((r) => !r.student.netId.startsWith(PREFIX)).length
  if (real > 0 && !FORCE) {
    throw new Error(
      `That question already has ${real} answer(s) from real accounts. Refusing to add fake ones. Pass --allow-real if you are sure.`
    )
  }
  if (existing.length > real) {
    console.log(`  note     : ${existing.length - real} rehearsal answers already present; they cannot answer twice`)
  }

  // Before spending a model call or writing a single account, prove a student can submit.
  console.log(`  target   : ${BASE}`)
  if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(BASE)) {
    console.log('  WARNING  : that is not a local server. Fake answers will land in whatever it serves.')
  }
  await preflight(CODE!)
  console.log('  preflight: a student can submit')

  const answers = await buildAnswers(question, STUDENTS)
  const spread = answers.reduce<Record<string, number>>((acc, a) => {
    acc[a.kind] = (acc[a.kind] ?? 0) + 1
    return acc
  }, {})
  console.log(`  mix      : ${Object.entries(spread).map(([k, v]) => `${v} ${k}`).join(', ')}`)

  if (DRY_RUN) {
    console.log('\n--- generated answers (nothing submitted) ---')
    answers.forEach((a, i) => console.log(`  [${String(i).padStart(2)}] (${a.kind}) ${readable(a.text)}`))
    // Only where answers repeat. A tally of free text is just the list again.
    if (!isFreeText) {
      console.log('\n--- distribution ---')
      for (const [text, n] of tally(answers.map((a) => a.text))) {
        console.log(`  ${String(n).padStart(4)}  ${readable(text)}`)
      }
    }
    await prisma.$disconnect()
    return
  }

  // ── Assemble the fake class ─────────────────────────────────────────────────
  /*
   * Reuse accounts left by earlier rehearsals and mint only the shortfall.
   *
   * Driving one question after another otherwise creates a fresh cohort every run, and
   * the pile cleanup has to sweep is the only thing that grows. Since the whole point of
   * this script is to iterate without hand-making students, it should not quietly
   * hand-make thirty more each time.
   *
   * Anyone who already answered *this* question is passed over. The route rejects a
   * second answer from the same student — correctly — so reusing them would spend the run
   * collecting 409s.
   */
  const alreadyHere = new Set(
    (await prisma.response.findMany({
      where: { questionId: question.id },
      select: { studentId: true },
    })).map((r) => r.studentId)
  )

  const spare = (await prisma.student.findMany({
    where: { netId: { startsWith: PREFIX } },
    select: { id: true },
    orderBy: { netId: 'asc' },
  })).filter((s) => !alreadyHere.has(s.id))

  const roster = spare.slice(0, answers.length).map((s) => s.id)
  const shortfall = answers.length - roster.length
  console.log(
    `\n  cohort   : ${answers.length} (${[
      roster.length > 0 ? `${roster.length} reused` : null,
      shortfall > 0 ? `${shortfall} new` : null,
    ].filter(Boolean).join(', ')})`
  )

  if (shortfall > 0) {
    const stamp = Date.now().toString(36)
    const hash = await bcrypt.hash(`rehearse-${stamp}`, 4)
    await prisma.student.createMany({
      data: Array.from({ length: shortfall }, (_, i) => ({
        netId: `${PREFIX}${stamp}-${i}`,
        email: `${PREFIX}${stamp}-${i}@example.invalid`,
        passwordHash: hash,
      })),
    })
    const fresh = await prisma.student.findMany({
      where: { netId: { startsWith: `${PREFIX}${stamp}-` } },
      select: { id: true },
    })
    roster.push(...fresh.map((s) => s.id))
  }

  // Match the open run's section, or a section-specific run rejects every answer. Upsert
  // rather than createMany: a reused account may already be enrolled in this class from a
  // run against a different section, and skipDuplicates would leave it pointed there.
  for (const studentId of roster) {
    await prisma.enrollment.upsert({
      where: { studentId_classId: { studentId, classId: session.classId } },
      create: { studentId, classId: session.classId, sectionId: openRun.sectionId },
      update: { sectionId: openRun.sectionId },
    })
  }

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

    const studentId = roster[i]
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

  // ── Report what the room produced ───────────────────────────────────────────
  if (isFreeText) {
    // Let the worker finish before reporting, or the tally is of a half-sorted set.
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
  } else {
    // Nothing to wait for — the distribution is simply whatever landed. Read it back from
    // the database rather than from what was generated, so this reports what the projector
    // is actually showing, rejections and all.
    const landed = await prisma.response.findMany({
      where: { questionId: question.id, runId: openRun.id },
      select: { responseText: true },
    })
    console.log('\n=== What the room produced ===')
    for (const [text, n] of tally(landed.map((r) => r.responseText))) {
      console.log(`  ${String(n).padStart(4)}  ${readable(text)}`)
    }
    console.log(`\n  ${landed.length} answer(s) on this run`)
  }

  console.log(`\nThe fake class is still in place so you can look at it.`)
  console.log(`Remove it with:  npx tsx scripts/rehearse.ts --code ${CODE} --cleanup`)

  await prisma.$disconnect()
}

main().catch(async (err) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`)
  await prisma.$disconnect()
  process.exit(1)
})
