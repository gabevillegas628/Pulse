/**
 * Read-only forensics for a live run. Point DATABASE_URL at production and run it
 * after a lecture to find out what the room actually experienced.
 *
 *   npx tsx scripts/postmortem.ts [--since 2026-09-01] [--run <runId>]
 *
 * It replays each question's real `Response.submittedAt` values through the real clock
 * service. Two things follow from "real":
 *
 *  - The counts are facts. n, participation, and skipped-while-present describe what
 *    happened and do not depend on the clock rules at all.
 *  - The deadlines are the rules as they stand *today*. Replaying an old lecture after
 *    changing clock.service therefore answers "how would this room have fared under the
 *    current code", which is the useful question when checking whether a fix landed —
 *    but it is not a recording of the deadlines that lecture actually hit.
 *
 * Students refused by the countdown leave no row behind, so their number is inferred
 * two ways: answers still landing as the deadline passed, and students who answered on
 * both sides of a question they skipped.
 */
import { prisma } from '../src/db/index.js'
import { touch, closesAt, clearRun, autoCloseEnabled } from '../src/services/clock.service.js'

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

const fmt = (d: Date) => d.toISOString().slice(11, 19)
/** Mirrors armThresholdFor() in clock.service, which is private to that module. */
const armThresholdOf = (roster: number) => (roster <= 0 ? 2 : Math.min(15, Math.max(2, Math.ceil(roster * 0.1))))
const pct = (n: number, d: number) => (d === 0 ? '  —  ' : `${((n / d) * 100).toFixed(0).padStart(3)}%`)

async function main() {
  const runId = arg('run')
  const since = arg('since') ? new Date(`${arg('since')}T00:00:00Z`) : new Date(Date.now() - 24 * 3600 * 1000)

  const runs = await prisma.sessionRun.findMany({
    where: runId ? { id: runId } : { openedAt: { gte: since } },
    orderBy: { openedAt: 'asc' },
    select: {
      id: true, status: true, openedAt: true, closedAt: true, sectionId: true,
      session: {
        select: {
          id: true, title: true,
          class: { select: { name: true, autoCloseDefault: true, _count: { select: { enrollments: true } } } },
          questions: {
            orderBy: { order: 'asc' },
            select: { id: true, order: true, type: true, title: true, text: true, autoClose: true },
          },
        },
      },
    },
  })

  if (runs.length === 0) {
    console.log('No runs found. Widen --since, or pass --run <runId>.')
    return
  }

  for (const run of runs) {
    const cls = run.session.class
    const roster = cls._count.enrollments
    const lifetimeMin = ((run.closedAt ?? new Date()).getTime() - run.openedAt.getTime()) / 60000

    console.log(`\n${'='.repeat(100)}`)
    console.log(`RUN ${run.id}  ·  ${cls.name} — "${run.session.title}"`)
    console.log(`opened ${run.openedAt.toISOString()}  ${run.status}` +
      (run.closedAt ? `  closed ${run.closedAt.toISOString()}` : '  (still open)') +
      `  ·  alive ${lifetimeMin < 0 ? 'n/a (closedAt precedes openedAt — seeded data)' : `${lifetimeMin.toFixed(0)} min`}  ·  roster ${roster}`)
    if (run.closedAt && lifetimeMin >= 99 && lifetimeMin <= 101) {
      console.log('!! closed at ~100 min — this was the scheduler timeout, not a person')
    }
    console.log('='.repeat(100))

    const responses = await prisma.response.findMany({
      where: { runId: run.id },
      orderBy: { submittedAt: 'asc' },
      select: { questionId: true, studentId: true, submittedAt: true },
    })

    if (responses.length === 0) { console.log('No responses recorded for this run.'); continue }

    const answeredBy = new Map<string, Set<string>>() // questionId -> studentIds
    const perQ = new Map<string, Date[]>()
    for (const r of responses) {
      if (!answeredBy.has(r.questionId)) answeredBy.set(r.questionId, new Set())
      answeredBy.get(r.questionId)!.add(r.studentId)
      if (!perQ.has(r.questionId)) perQ.set(r.questionId, [])
      perQ.get(r.questionId)!.push(r.submittedAt)
    }
    const peak = Math.max(...[...answeredBy.values()].map((s) => s.size))

    console.log('\n  #  type        n   ofPeak  window   closed?   grace  last-3s  verdict')
    console.log('  ' + '-'.repeat(96))

    for (const q of run.session.questions) {
      const times = perQ.get(q.id) ?? []
      const n = times.length
      const timed = autoCloseEnabled(q, cls)
      if (n === 0) {
        console.log(`  ${String(q.order).padStart(2)}  ${q.type.slice(0, 10).padEnd(10)}   0    —      —        —         —       —    never answered`)
        continue
      }

      clearRun(run.id)
      for (const t of times) touch(run.session.id, run.id, q.id, t.getTime(), roster)
      // null here means one of two very different things: the question is untimed, or
      // its clock never reached the arming threshold and so never counted down.
      const close = timed ? closesAt(run.id, q.id) : null

      const first = times[0]!.getTime()
      const last = times[n - 1]!.getTime()
      const windowSec = (last - first) / 1000
      const graceSec = close ? (close - last) / 1000 : null
      // Answers landing in the final 3s before the deadline: the room was still
      // actively answering at the moment the question died.
      const lastBurst = close ? times.filter((t) => close - t.getTime() <= 3000).length : 0

      let verdict = ''
      if (!timed) verdict = 'untimed'
      else if (close === null) verdict = `never armed (needed ${armThresholdOf(roster)}, got ${n})`
      else if (graceSec !== null && graceSec <= 8.05 && lastBurst > 0) verdict = 'CLOSED ON A LIVE QUEUE'
      else if (graceSec !== null && graceSec <= 8.05) verdict = 'closed at the 8s floor'
      else verdict = 'ok'

      console.log(
        `  ${String(q.order).padStart(2)}  ${q.type.slice(0, 10).padEnd(10)} ${String(n).padStart(3)}  ${pct(n, peak)}  ` +
        `${windowSec.toFixed(0).padStart(5)}s  ` +
        `${close ? fmt(new Date(close)) : '   —    '}  ` +
        `${graceSec !== null ? `${graceSec.toFixed(1)}s`.padStart(6) : '     —'}  ` +
        `${String(lastBurst).padStart(6)}   ${verdict}`
      )
      clearRun(run.id)
    }

    // ── Students shut out mid-run ────────────────────────────────────────────
    // Answered a question before AND after one they missed. They were in the room,
    // on the app, and did not answer: the strongest signal available that the
    // countdown refused them, since a refusal writes no row.
    const orderOf = new Map(run.session.questions.map((q) => [q.id, q.order]))
    const byStudent = new Map<string, number[]>()
    for (const r of responses) {
      const o = orderOf.get(r.questionId)
      if (o === undefined) continue
      if (!byStudent.has(r.studentId)) byStudent.set(r.studentId, [])
      byStudent.get(r.studentId)!.push(o)
    }

    const gapsByQuestion = new Map<number, number>()
    let studentsWithGaps = 0
    for (const orders of byStudent.values()) {
      const set = new Set(orders)
      const lo = Math.min(...orders), hi = Math.max(...orders)
      let had = false
      for (const q of run.session.questions) {
        if (q.order > lo && q.order < hi && !set.has(q.order)) {
          gapsByQuestion.set(q.order, (gapsByQuestion.get(q.order) ?? 0) + 1)
          had = true
        }
      }
      if (had) studentsWithGaps++
    }

    console.log(`\n  Participation: peak ${peak} of ${roster} enrolled (${pct(peak, roster)})`)
    console.log(`  Students who skipped a question they were present for: ${studentsWithGaps} of ${byStudent.size} (${pct(studentsWithGaps, byStudent.size)})`)
    if (gapsByQuestion.size > 0) {
      const rows = [...gapsByQuestion.entries()].sort((a, b) => b[1] - a[1])
      console.log('  Skipped-while-present, by question:')
      for (const [order, count] of rows) console.log(`    Q${order}: ${count} student(s)`)
    }
  }

  await prisma.$disconnect()
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
