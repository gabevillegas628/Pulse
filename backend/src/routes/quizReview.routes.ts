/**
 * Reviewing graded quiz boxes: by item (every paper's answer to one box, grouped), with
 * decisions for a whole group or one paper, answers added to the key, and the audit log.
 * Professor-only; everything is scoped to the requesting professor's assessments.
 */
import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { prisma } from '../db/index.js'
import { AppError } from '../middleware/error.middleware.js'
import { requireProfessor, ProfessorRequest } from '../middleware/auth.middleware.js'
import { ownedQuizContent } from '../utils/ownership.js'
import { p } from '../utils/params.js'
import { contextFor } from '../quizGrader/grading.js'
import { acceptedNames } from '../quizGrader/grade.js'
import { addAlias, decideGroup, decidePaper, effectiveResults, type EffectiveResult } from '../quizGrader/review.js'

const router = Router()
const viewer = (req: Request) => (req as ProfessorRequest).professor

async function ownedAssessment(req: Request) {
  const a = await prisma.quizContent.findFirst({
    where: { id: p(req.params.id), ...ownedQuizContent(viewer(req)), kind: 'ASSESSMENT' },
    select: { id: true, professorId: true },
  })
  if (!a) throw new AppError('Not found', 404)
  return a
}

/** Human names for boxes: "Step 6 enzyme", "1,3-Bisphosphoglycerate". */
async function slotLabels(assessmentId: string) {
  const ctx = await contextFor(assessmentId)
  const out = new Map<string, { label: string; kind: string; order: number; accept?: string[]; features?: string[] }>()
  ctx.layout.slots.forEach((s, order) => {
    const m = /^step\.(\w+)\.(enzyme|cofactors)$/.exec(s.ref)
    const im = /^intermediate\.(\w+)$/.exec(s.ref)
    const nm = /^intermediate\.(\w+)\.name$/.exec(s.ref)
    if (nm) {
      const it = ctx.key.intermediates[nm[1]!]
      out.set(s.id, { label: `${it?.name ?? nm[1]} (name)`, kind: 'name', order, accept: it ? acceptedNames(it) : undefined })
      return
    }
    if (m) {
      const step = ctx.key.steps[m[1]!]
      out.set(s.id, {
        label: `Step ${m[1]} ${m[2] === 'enzyme' ? 'enzyme' : 'cofactors'}`,
        kind: m[2] === 'enzyme' ? 'enzyme' : 'cofactors',
        order,
        accept: m[2] === 'enzyme' ? step?.enzyme.accept : undefined,
      })
    } else if (im) {
      const it = ctx.key.intermediates[im[1]!]
      out.set(s.id, { label: it?.name ?? im[1]!, kind: 'structure', order, features: it?.features })
    }
  })
  return out
}

// What is left to review, box by box.
router.get('/quiz-grader/content/:id/review', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const a = await ownedAssessment(req)
    const [results, labels] = await Promise.all([effectiveResults({ assessmentId: a.id }), slotLabels(a.id)])
    const bySlot = new Map<string, EffectiveResult[]>()
    for (const r of results) bySlot.set(r.slotId, [...(bySlot.get(r.slotId) ?? []), r])
    const slots = [...bySlot.entries()]
      .map(([slotId, rs]) => ({
        slotId,
        label: labels.get(slotId)?.label ?? slotId,
        kind: rs[0]!.kind,
        papers: rs.length,
        open: rs.filter((r) => r.open).length,
        // Why each open box is open (its first reason), for the page's tally.
        reasons: rs.filter((r) => r.open).map((r) => (Array.isArray(r.reviewReasons) ? String(r.reviewReasons[0] ?? '') : '')),
        groups: rs[0]!.kind === 'structure' ? rs.length : new Set(rs.map((r) => r.groupKey)).size,
        order: labels.get(slotId)?.order ?? 999,
      }))
      .sort((x, y) => x.order - y.order)
    res.json({ success: true, data: { slots, open: results.filter((r) => r.open).length, boxes: results.length } })
  } catch (err) {
    next(err)
  }
})

// One box across every paper, grouped by what was written (structures: one per paper).
router.get('/quiz-grader/content/:id/review/:slotId', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const a = await ownedAssessment(req)
    const slotId = p(req.params.slotId)
    const [all, labels] = await Promise.all([effectiveResults({ assessmentId: a.id }), slotLabels(a.id)])
    const rs = all.filter((r) => r.slotId === slotId)
    if (!rs.length) throw new AppError('No graded papers have that box', 404)
    const info = labels.get(slotId)

    const groups = new Map<string, typeof rs>()
    for (const r of rs) {
      const k = r.groupKey ?? `paper:${r.pageId}`
      groups.set(k, [...(groups.get(k) ?? []), r])
    }
    const out = [...groups.entries()].map(([k, members]) => ({
      groupKey: members[0]!.groupKey,
      key: k,
      count: members.length,
      open: members.filter((m) => m.open).length,
      // The reading shown for the group: the most common way it was written.
      sample: mostCommon(members.map((m) => m.transcription ?? '')),
      status: members[0]!.status,
      decision: members[0]!.decision,
      members: members.map((m) => ({
        pageId: m.pageId, batchId: m.page.batchId, index: m.page.index, version: m.page.version,
        status: m.status, blankBy: m.blankBy, transcription: m.transcription, detail: m.detail,
        pointsAuto: m.pointsAuto, maxPoints: m.maxPoints, points: m.points, source: m.source,
        open: m.open, needsReview: m.needsReview, reviewReasons: m.reviewReasons, override: m.override,
      })),
    }))
    out.sort((x, y) => Number(y.open > 0) - Number(x.open > 0) || y.count - x.count)
    res.json({
      success: true,
      data: {
        slotId, label: info?.label ?? slotId, kind: rs[0]!.kind, maxPoints: rs[0]!.maxPoints,
        accept: info?.accept ?? null, features: info?.features ?? null, groups: out,
      },
    })
  } catch (err) {
    next(err)
  }
})

function mostCommon(xs: string[]): string {
  const n = new Map<string, number>()
  for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1)
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
}

// Decide a whole group: every paper that wrote this, now and later. points null withdraws.
// addAlias puts the written answer in the key as an accepted enzyme name.
router.post('/quiz-grader/content/:id/review/:slotId/group', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const a = await ownedAssessment(req)
    const slotId = p(req.params.slotId)
    const body = z.object({
      groupKey: z.string(),
      points: z.number().min(0).nullable(),
      addAlias: z.string().min(1).max(200).optional(),
    }).parse(req.body)
    const sample = await prisma.quizSlotResult.findFirst({ where: { slotId, groupKey: body.groupKey, page: { batch: { assessmentId: a.id } } } })
    if (!sample) throw new AppError('No papers wrote that', 404)
    if (body.points != null && body.points > sample.maxPoints) throw new AppError(`At most ${sample.maxPoints} points`, 400)
    await decideGroup(viewer(req).id, a.id, slotId, body.groupKey, body.points)
    let alias: string | null = null
    if (body.addAlias) {
      try {
        alias = await addAlias(a.professorId, a.id, slotId, body.addAlias)
      } catch (e) {
        throw new AppError((e as Error).message, 400)
      }
    }
    res.json({ success: true, data: { alias } })
  } catch (err) {
    next(err)
  }
})

// Decide one paper's box. points null withdraws; features (structures) set the points.
router.post('/quiz-grader/pages/:pageId/boxes/:slotId', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = await prisma.quizPage.findFirst({ where: { id: p(req.params.pageId), batch: { professorId: viewer(req).id } }, select: { id: true } })
    if (!page) throw new AppError('Not found', 404)
    const body = z.object({
      points: z.number().min(0).nullable(),
      features: z.array(z.boolean()).optional(),
      note: z.string().max(500).optional(),
    }).parse(req.body)
    let points: number | null
    try {
      points = await decidePaper(viewer(req).id, page.id, p(req.params.slotId), body)
    } catch (e) {
      throw new AppError((e as Error).message, 400)
    }
    res.json({ success: true, data: { points } })
  } catch (err) {
    next(err)
  }
})

// The audit log: every decision, newest first.
router.get('/quiz-grader/content/:id/log', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const a = await ownedAssessment(req)
    const limit = Math.min(500, Number(req.query.limit) || 100)
    const entries = await prisma.quizDecisionLog.findMany({ where: { assessmentId: a.id }, orderBy: { createdAt: 'desc' }, take: limit })
    const names = new Map((await prisma.professor.findMany({
      where: { id: { in: [...new Set(entries.map((e) => e.professorId))] } }, select: { id: true, name: true },
    })).map((x) => [x.id, x.name]))
    const pages = new Map((await prisma.quizPage.findMany({
      where: { id: { in: entries.map((e) => e.pageId).filter((x): x is string => !!x) } }, select: { id: true, index: true },
    })).map((x) => [x.id, x.index]))
    res.json({
      success: true,
      data: { entries: entries.map((e) => ({ ...e, who: names.get(e.professorId) ?? 'unknown', page: e.pageId ? (pages.get(e.pageId) ?? null) : null })) },
    })
  } catch (err) {
    next(err)
  }
})

export default router
