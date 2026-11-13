/**
 * Paper quiz scores for the class gradebook. One place works out where each quiz stands,
 * so the release check, the professor's gradebook, its CSV and the student's view agree.
 *
 * A paper counts for the student whose NetID it was matched to, with its score after
 * review decisions (review.ts). A roster student with no paper scores 0 unless excused.
 * Papers that cannot be placed (not matched, NetID not on the roster, two papers with one
 * NetID) are left out and listed, never guessed at. Only released quizzes reach the
 * gradebook; after release it stays live.
 */
import { prisma } from '../db/index.js'
import { effectiveResults, pageTotals } from './review.js'
import { parseSource, titleOf } from './store.js'

export interface PaperScore { pageId: string; points: number; max: number }

export interface QuizStanding {
  id: string
  title: string
  classId: string | null
  releasedAt: Date | null
  /** When the quiz was given: its first upload. */
  date: Date | null
  /** Points the quiz is out of: what most graded papers are out of. */
  max: number
  /** Graded papers by matched NetID, for NetIDs with exactly one paper. */
  scores: Map<string, PaperScore>
  roster: { netId: string; email: string }[]
  excused: Set<string>
  /** NetIDs whose score is not settled: two papers, or a matched paper not graded yet. */
  pending: Set<string>
  /** Roster students with no paper and not excused: they score 0. */
  missing: string[]
  problems: {
    /** Boxes still flagged for review, across graded papers. */
    openBoxes: number
    /** Papers not lined up or not graded yet. */
    notGraded: number
    /** Graded papers not matched to a student. */
    unmatched: number
    /** Matched NetIDs that are not on the class roster. */
    offRoster: string[]
    /** NetIDs matched to more than one paper. */
    duplicates: string[]
  }
}

const lower = (s: string) => s.trim().toLowerCase()

/** Where one quiz stands. Null if it is not a quiz. */
export async function quizStanding(assessmentId: string): Promise<QuizStanding | null> {
  const quiz = await prisma.quizContent.findUnique({
    where: { id: assessmentId },
    select: { id: true, kind: true, slug: true, source: true, classId: true, releasedAt: true, excusals: { select: { netId: true } } },
  })
  if (!quiz || quiz.kind !== 'ASSESSMENT') return null
  let title = quiz.slug
  try { title = titleOf('ASSESSMENT', parseSource(quiz.source)) } catch { /* the file name will do */ }

  const [pages, results, enrolled, firstBatch] = await Promise.all([
    prisma.quizPage.findMany({
      where: { batch: { assessmentId } },
      select: { id: true, gradeStatus: true, maxPoints: true, studentNetId: true },
    }),
    effectiveResults({ assessmentId }),
    quiz.classId
      ? prisma.enrollment.findMany({ where: { classId: quiz.classId }, select: { student: { select: { netId: true, email: true } } } })
      : Promise.resolve([]),
    prisma.quizBatch.findFirst({ where: { assessmentId }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
  ])
  const totals = pageTotals(results)
  const graded = pages.filter((pg) => pg.gradeStatus === 'GRADED' && totals.has(pg.id))

  // Out of: the most common total among graded papers (versions normally match).
  const counts = new Map<number, number>()
  for (const pg of graded) { const m = pg.maxPoints ?? totals.get(pg.id)!.max; counts.set(m, (counts.get(m) ?? 0) + 1) }
  const max = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0

  const roster = enrolled.map((e) => e.student).sort((a, b) => a.netId.localeCompare(b.netId))
  const onRoster = new Set(roster.map((s) => lower(s.netId)))
  const byNetId = new Map<string, typeof graded>()
  for (const pg of graded) {
    if (!pg.studentNetId) continue
    const k = lower(pg.studentNetId)
    byNetId.set(k, [...(byNetId.get(k) ?? []), pg])
  }
  const scores = new Map<string, PaperScore>()
  const duplicates: string[] = []
  for (const [netId, papers] of byNetId) {
    if (papers.length > 1) { duplicates.push(netId); continue }
    const pg = papers[0]!
    const t = totals.get(pg.id)!
    scores.set(netId, { pageId: pg.id, points: t.points, max: pg.maxPoints ?? t.max })
  }
  const excused = new Set(quiz.excusals.map((e) => lower(e.netId)))
  const pending = new Set([
    ...duplicates,
    ...pages.filter((pg) => pg.studentNetId && !graded.includes(pg)).map((pg) => lower(pg.studentNetId!)),
  ].filter((n) => !scores.has(n) || duplicates.includes(n)))
  return {
    id: quiz.id,
    title,
    classId: quiz.classId,
    releasedAt: quiz.releasedAt,
    date: firstBatch?.createdAt ?? null,
    max,
    scores,
    roster,
    excused,
    pending,
    missing: roster.map((s) => lower(s.netId)).filter((n) => !byNetId.has(n) && !excused.has(n) && !pending.has(n)),
    problems: {
      openBoxes: graded.reduce((n, pg) => n + (totals.get(pg.id)?.open ?? 0), 0),
      notGraded: pages.length - graded.length,
      unmatched: graded.filter((pg) => !pg.studentNetId).length,
      offRoster: [...byNetId.keys()].filter((n) => !onRoster.has(n)).sort(),
      duplicates: duplicates.sort(),
    },
  }
}

/** One student's cell for one quiz: a score, a 0 for no paper, or excused (no score). */
export interface QuizCell {
  quizId: string
  earned: number
  /** 0 when the cell does not count: excused, or pending. */
  max: number
  excused: boolean
  /** Two papers carry this NetID, or its paper is not graded yet: no score until settled. */
  pending: boolean
  pageId: string | null
}

/** A class's released quizzes, as gradebook columns, and each roster student's cells. */
export async function classQuizGrades(classId: string): Promise<{
  quizzes: { id: string; title: string; date: string | null; max: number }[]
  cell: (netId: string, quizId: string) => QuizCell | null
}> {
  const released = await prisma.quizContent.findMany({
    where: { classId, kind: 'ASSESSMENT', releasedAt: { not: null } },
    select: { id: true },
    orderBy: { releasedAt: 'asc' },
  })
  const standings = (await Promise.all(released.map((q) => quizStanding(q.id)))).filter((s): s is QuizStanding => !!s)
  standings.sort((a, b) => (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0))
  const byId = new Map(standings.map((s) => [s.id, s]))
  return {
    quizzes: standings.map((s) => ({ id: s.id, title: s.title, date: (s.date ?? s.releasedAt)?.toISOString() ?? null, max: s.max })),
    cell(netId, quizId) {
      const s = byId.get(quizId)
      if (!s) return null
      const k = lower(netId)
      if (s.excused.has(k)) return { quizId, earned: 0, max: 0, excused: true, pending: false, pageId: null }
      if (s.pending.has(k)) return { quizId, earned: 0, max: 0, excused: false, pending: true, pageId: null }
      const sc = s.scores.get(k)
      // A paper is out of its own total (versions normally match); no paper is a 0.
      if (sc) return { quizId, earned: sc.points, max: sc.max, excused: false, pending: false, pageId: sc.pageId }
      return { quizId, earned: 0, max: s.max, excused: false, pending: false, pageId: null }
    },
  }
}
