/**
 * Whose paper is whose, and the grades out as a CSV.
 *
 * A quiz is linked to one of the professor's classes; each scanned paper gets the NetID the
 * professor picks from that class's roster while looking at the paper's name and NetID
 * crops. Nothing here is ever sent to a model.
 */
import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { prisma } from '../db/index.js'
import { AppError } from '../middleware/error.middleware.js'
import { requireProfessor, ProfessorRequest } from '../middleware/auth.middleware.js'
import { ownedClass, ownedQuizContent } from '../utils/ownership.js'
import { p } from '../utils/params.js'
import { assessmentSchema, layoutSchema } from '../quizGrader/content.js'
import { parseSource } from '../quizGrader/store.js'
import { effectiveResults, pageTotals } from '../quizGrader/review.js'

const router = Router()
const viewer = (req: Request) => (req as ProfessorRequest).professor

async function ownedQuiz(req: Request) {
  const q = await prisma.quizContent.findFirst({
    where: { id: p(req.params.id), ...ownedQuizContent(viewer(req)), kind: 'ASSESSMENT' },
    select: { id: true, slug: true, source: true, professorId: true, classId: true, updatedAt: true },
  })
  if (!q) throw new AppError('Not found', 404)
  return q
}

/** The layout slot ids of the student name and NetID boxes, for showing their crops. */
async function identityBoxes(quiz: { source: string; professorId: string }): Promise<{ name: string | null; netid: string | null }> {
  try {
    const a = assessmentSchema.parse(parseSource(quiz.source))
    const row = await prisma.quizContent.findUnique({
      where: { professorId_kind_slug: { professorId: quiz.professorId, kind: 'LAYOUT', slug: a.layout } },
      select: { source: true },
    })
    const slots = row ? layoutSchema.parse(parseSource(row.source)).slots : []
    return {
      name: slots.find((s) => s.ref === 'student.name' && s.box)?.id ?? null,
      netid: slots.find((s) => s.ref === 'student.netid' && s.box)?.id ?? null,
    }
  } catch {
    return { name: null, netid: null }
  }
}

async function roster(classId: string | null): Promise<{ netId: string; email: string }[]> {
  if (!classId) return []
  const rows = await prisma.enrollment.findMany({
    where: { classId },
    select: { student: { select: { netId: true, email: true } } },
  })
  return rows.map((r) => r.student).sort((a, b) => a.netId.localeCompare(b.netId))
}

const normNetId = (s: string) => s.trim().toLowerCase()

// Everything the matching screen needs: the class, its roster, and every paper.
router.get('/quiz-grader/content/:id/match', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const quiz = await ownedQuiz(req)
    const [classes, students, boxes, pages] = await Promise.all([
      prisma.class.findMany({ where: ownedClass(viewer(req)), select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      roster(quiz.classId),
      identityBoxes(quiz),
      prisma.quizPage.findMany({
        where: { batch: { assessmentId: quiz.id } },
        select: { id: true, batchId: true, index: true, status: true, slots: true, studentNetId: true, batch: { select: { fileName: true } } },
        orderBy: [{ batch: { createdAt: 'asc' } }, { index: 'asc' }],
      }),
    ])
    res.json({
      success: true,
      data: {
        classId: quiz.classId,
        classes,
        roster: students,
        pages: pages.map((pg) => {
          // Crops exist only for boxes the page was cut with.
          const cut = new Set(((pg.slots ?? []) as { id: string }[]).map((s) => s.id))
          return {
            id: pg.id, batchId: pg.batchId, index: pg.index, status: pg.status, fileName: pg.batch.fileName,
            netId: pg.studentNetId,
            nameBox: boxes.name && cut.has(boxes.name) ? boxes.name : null,
            netidBox: boxes.netid && cut.has(boxes.netid) ? boxes.netid : null,
          }
        }),
      },
    })
  } catch (err) {
    next(err)
  }
})

// Link the quiz to a class (or unlink it with null).
router.put('/quiz-grader/content/:id/class', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const quiz = await ownedQuiz(req)
    const { classId } = z.object({ classId: z.string().nullable() }).parse(req.body)
    if (classId && !(await prisma.class.findFirst({ where: { id: classId, ...ownedClass(viewer(req)) }, select: { id: true } }))) {
      throw new AppError('Class not found', 404)
    }
    // Not through the YAML: the class is not part of the quiz's files, and updatedAt is the
    // files' edit guard, so it is left alone.
    await prisma.quizContent.update({ where: { id: quiz.id }, data: { classId, updatedAt: quiz.updatedAt } })
    res.json({ success: true, data: { classId, roster: await roster(classId) } })
  } catch (err) {
    next(err)
  }
})

// Say whose paper this is (a NetID), or clear it with null.
router.put('/quiz-grader/pages/:pageId/student', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { netId } = z.object({ netId: z.string().trim().max(64).nullable() }).parse(req.body)
    const page = await prisma.quizPage.findFirst({
      where: { id: p(req.params.pageId), batch: { professorId: viewer(req).id } },
      select: { id: true },
    })
    if (!page) throw new AppError('Not found', 404)
    const value = netId ? normNetId(netId) : null
    if (value !== null && !/^[\w.@-]+$/.test(value)) throw new AppError('A NetID is letters, digits and . _ - only.', 400)
    await prisma.quizPage.update({ where: { id: page.id }, data: { studentNetId: value, matchedAt: value ? new Date() : null } })
    res.json({ success: true, data: { netId: value } })
  } catch (err) {
    next(err)
  }
})

/** One CSV cell: quoted when needed, and never read by a spreadsheet as a formula. */
function cell(v: string | number | null | undefined): string {
  let s = v == null ? '' : String(v)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * The grades: one row per paper (score after review decisions), then every student on the
 * class roster who has no paper, with no score. `?boxes=1` adds a column per answer box.
 */
router.get('/quiz-grader/content/:id/export.csv', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const quiz = await ownedQuiz(req)
    const withBoxes = req.query.boxes === '1'
    const [pages, results, students] = await Promise.all([
      prisma.quizPage.findMany({
        where: { batch: { assessmentId: quiz.id } },
        select: { id: true, index: true, version: true, gradeStatus: true, maxPoints: true, studentNetId: true, batch: { select: { fileName: true } } },
        orderBy: [{ batch: { createdAt: 'asc' } }, { index: 'asc' }],
      }),
      effectiveResults({ assessmentId: quiz.id }),
      roster(quiz.classId),
    ])
    const totals = pageTotals(results)
    const onRoster = new Map(students.map((s) => [s.netId.toLowerCase(), s]))
    const count = new Map<string, number>()
    for (const pg of pages) if (pg.studentNetId) count.set(pg.studentNetId, (count.get(pg.studentNetId) ?? 0) + 1)
    const boxIds = withBoxes ? [...new Set(results.map((r) => r.slotId))] : []
    const byPageBox = new Map(results.map((r) => [`${r.pageId}/${r.slotId}`, r.points]))

    const header = ['netid', 'email', 'score', 'out_of', 'boxes_to_review', 'version', 'upload', 'page', 'note', ...boxIds]
    const lines = [header.map(cell).join(',')]
    for (const pg of pages) {
      const t = totals.get(pg.id)
      const graded = pg.gradeStatus === 'GRADED' && t
      const notes = [
        !pg.studentNetId ? 'not matched to a student' : '',
        pg.studentNetId && quiz.classId && !onRoster.has(pg.studentNetId) ? 'not on the class roster' : '',
        pg.studentNetId && (count.get(pg.studentNetId) ?? 0) > 1 ? 'more than one paper has this NetID' : '',
        !graded ? 'not graded' : t!.open ? 'review not finished' : '',
      ].filter(Boolean).join('; ')
      lines.push([
        pg.studentNetId ?? '', pg.studentNetId ? onRoster.get(pg.studentNetId)?.email ?? '' : '',
        graded ? t!.points : '', graded ? (pg.maxPoints ?? t!.max) : '', graded ? t!.open : '',
        pg.version ?? '', pg.batch.fileName, pg.index + 1, notes,
        ...boxIds.map((b) => byPageBox.get(`${pg.id}/${b}`) ?? ''),
      ].map(cell).join(','))
    }
    for (const s of students) {
      if (count.has(s.netId.toLowerCase())) continue
      lines.push([s.netId, s.email, '', '', '', '', '', '', 'no paper', ...boxIds.map(() => '')].map(cell).join(','))
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${quiz.slug.replace(/[^\w.-]/g, '_')}-grades.csv"`)
    res.send(lines.join('\r\n') + '\r\n')
  } catch (err) {
    next(err)
  }
})

export default router
