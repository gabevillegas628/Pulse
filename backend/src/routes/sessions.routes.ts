import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { customAlphabet } from 'nanoid'
import { Prisma } from '@prisma/client'
import { prisma } from '../db/index.js'
import { AppError } from '../middleware/error.middleware.js'
import { requireProfessor, ProfessorRequest } from '../middleware/auth.middleware.js'
import { getIo } from '../socket.js'
import { gradeSession } from '../utils/scoring.js'
import { generateUniqueCode } from '../utils/codes.js'
import { attachQuestionQrs } from '../utils/qr.js'
import { p } from '../utils/params.js'

const nanoidDigits = customAlphabet('0123456789', 4)

const generateUniqueSessionCode = () =>
  generateUniqueCode(
    nanoidDigits,
    (code) => prisma.session.findUnique({ where: { accessCode: code } }).then(Boolean),
    20
  )

const createSessionSchema = z.object({
  title: z.string().min(1),
})

const router = Router()

// ─── Session CRUD ─────────────────────────────────────────────────────────────

// Create a Session (IN_CLASS question set)
router.post('/classes/:classId/sessions', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const body = createSessionSchema.parse(req.body)

    const cls = await prisma.class.findFirst({
      where: { id: p(req.params.classId), professorId: professor.id },
    })
    if (!cls) throw new AppError('Class not found', 404)

    const accessCode = await generateUniqueSessionCode()

    const session = await prisma.session.create({
      data: {
        classId: cls.id,
        title: body.title,
        accessCode,
        status: 'DRAFT',
      },
      include: { questions: { orderBy: { order: 'asc' } }, runs: true },
    })

    res.status(201).json({ success: true, data: { session } })
  } catch (err) {
    next(err)
  }
})

// List Sessions for a class
router.get('/classes/:classId/sessions', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const cls = await prisma.class.findFirst({
      where: { id: p(req.params.classId), professorId: professor.id },
      include: { _count: { select: { enrollments: true } } },
    })
    if (!cls) throw new AppError('Class not found', 404)

    const sessions = await prisma.session.findMany({
      where: { classId: cls.id },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { questions: true } },
        runs: {
          orderBy: { openedAt: 'desc' },
          select: { id: true, sectionId: true, status: true, openedAt: true, closedAt: true, section: { select: { name: true } } },
        },
      },
    })

    // Distinct respondent count per session (across all runs)
    const sessionIds = sessions.map((s) => s.id)
    let respondentMap: Record<string, number> = {}
    if (sessionIds.length > 0) {
      const rows = await prisma.$queryRaw<Array<{ sessionId: string; respondentCount: bigint }>>(
        Prisma.sql`
          SELECT s.id AS "sessionId", COUNT(DISTINCT r."studentId") AS "respondentCount"
          FROM "Session" s
          LEFT JOIN "SessionRun" sr ON sr."sessionId" = s.id
          LEFT JOIN "Response" r ON r."runId" = sr.id
          WHERE s.id IN (${Prisma.join(sessionIds)})
          GROUP BY s.id
        `
      )
      for (const row of rows) {
        respondentMap[row.sessionId] = Number(row.respondentCount)
      }
    }

    const result = sessions.map((s) => ({
      ...s,
      isLive: s.runs.some((r) => r.status === 'OPEN'),
      respondentCount: respondentMap[s.id] ?? 0,
    }))

    res.json({ success: true, data: { sessions: result, enrolledCount: cls._count.enrollments } })
  } catch (err) {
    next(err)
  }
})

// Get a single session with questions, responses, and runs
router.get('/sessions/:id', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const session = await prisma.session.findFirst({
      where: { id: p(req.params.id), class: { professorId: professor.id } },
      include: {
        class: { select: { id: true, name: true, _count: { select: { enrollments: true } } } },
        groups: { orderBy: [{ order: 'asc' }, { createdAt: 'asc' }] },
        runs: {
          orderBy: { openedAt: 'desc' },
          select: { id: true, sectionId: true, status: true, openedAt: true, closedAt: true, section: { select: { name: true } } },
        },
        questions: {
          orderBy: { order: 'asc' },
          include: {
            responses: {
              include: { student: { select: { id: true, netId: true } } },
              orderBy: { submittedAt: 'desc' },
            },
          },
        },
      },
    })
    if (!session) throw new AppError('Session not found', 404)

    const questionsWithQr = await attachQuestionQrs(
      session.questions as { id: string; accessCode: string; [key: string]: unknown }[]
    )
    const enrolledCount = (session.class as typeof session.class & { _count: { enrollments: number } })._count.enrollments
    res.json({ success: true, data: { session: { ...session, enrolledCount, questions: questionsWithQr } } })
  } catch (err) {
    next(err)
  }
})

// Update session (title or DRAFT→ARCHIVED)
router.patch('/sessions/:id', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const body = z.object({
      title: z.string().min(1).optional(),
      status: z.enum(['ARCHIVED']).optional(),
    }).parse(req.body)

    const existing = await prisma.session.findFirst({
      where: { id: p(req.params.id), class: { professorId: professor.id } },
    })
    if (!existing) throw new AppError('Session not found', 404)

    const updated = await prisma.session.update({
      where: { id: p(req.params.id) },
      data: {
        ...(body.title !== undefined && { title: body.title }),
        ...(body.status !== undefined && { status: body.status }),
      },
    })

    res.json({ success: true, data: { session: updated } })
  } catch (err) {
    next(err)
  }
})

// Delete a session (DRAFT only — no runs)
router.delete('/sessions/:id', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const existing = await prisma.session.findFirst({
      where: { id: p(req.params.id), class: { professorId: professor.id } },
      include: { _count: { select: { runs: true } } },
    })
    if (!existing) throw new AppError('Session not found', 404)
    if (existing.status !== 'DRAFT') throw new AppError('Can only delete DRAFT sessions', 400)
    if ((existing._count as { runs: number }).runs > 0) throw new AppError('Cannot delete a session that has runs', 400)
    await prisma.session.delete({ where: { id: p(req.params.id) } })
    res.json({ success: true, data: null })
  } catch (err) {
    next(err)
  }
})

// CSV grade export — section-aware, per-run
router.get('/sessions/:id/export', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const session = await prisma.session.findFirst({
      where: { id: p(req.params.id), class: { professorId: professor.id } },
      include: {
        class: {
          include: {
            enrollments: {
              include: {
                student: { select: { id: true, netId: true } },
                section: { select: { id: true, name: true } },
              },
            },
          },
        },
        runs: { select: { id: true, sectionId: true, status: true } },
        questions: {
          orderBy: { order: 'asc' },
          include: {
            responses: { select: { studentId: true, responseText: true, wordCount: true, aiScore: true, runId: true } },
          },
        },
      },
    })
    if (!session) throw new AppError('Session not found', 404)

    const students = session.class.enrollments.map((e) => ({
      student: e.student,
      sectionId: e.section?.id ?? null,
    }))

    const runIds = session.runs.map((r) => r.id)

    const rows = students.map(({ student, sectionId }) => {
      // Relevant runs for this student's section
      const relevantRunIds = session.runs
        .filter((r) => r.sectionId === null || r.sectionId === sectionId)
        .map((r) => r.id)

      const gradeResult = gradeSession('IN_CLASS', session.questions.map((q) => {
        const sectionResponses = q.responses.filter((r) => relevantRunIds.includes(r.runId ?? ''))
        return {
          id: q.id,
          type: q.type,
          correctAnswer: q.correctAnswer,
          tolerance: q.tolerance,
          totalResponseCount: q.responses.filter((r) => runIds.includes(r.runId ?? '')).length,
          sectionResponseCount: sectionResponses.length,
          hasAnyAiScore: q.responses.some((r) => r.aiScore !== null),
          studentResponse: q.responses.find((r) => r.studentId === student.id) ?? null,
        }
      }))

      return { netId: student.netId, gradeResult }
    })

    const sampleResult = rows[0]?.gradeResult ?? gradeSession('IN_CLASS', [])
    const grandMax = sampleResult.max

    const qHeaders = session.questions.map((q, i) => {
      const qr = sampleResult.questions.find((r) => r.id === q.id)
      return qr?.counted ? `Q${i + 1}` : `Q${i + 1} (ungraded)`
    })
    const header = ['NetID', ...qHeaders, 'Total', `Max (${grandMax})`].join(',')
    const csvRows = rows.map(({ netId, gradeResult: gr }) => {
      const scores = session.questions.map((q) => {
        const qr = gr.questions.find((r) => r.id === q.id)!
        return qr.counted ? qr.score.toFixed(1) : '—'
      })
      return [netId, ...scores, gr.earned.toFixed(1), grandMax.toFixed(1)].join(',')
    })

    const csv = [header, ...csvRows].join('\n')
    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', `attachment; filename="session-${session.id}-grades.csv"`)
    res.send(csv)
  } catch (err) {
    next(err)
  }
})

// ─── SessionRun routes ────────────────────────────────────────────────────────

// Open a new SessionRun
router.post('/sessions/:id/runs', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const body = z.object({
      sectionId: z.string().optional(),
    }).parse(req.body)

    const session = await prisma.session.findFirst({
      where: { id: p(req.params.id), class: { professorId: professor.id } },
      include: { runs: true },
    })
    if (!session) throw new AppError('Session not found', 404)

    const hasOpenRun = session.runs.some((r) => r.status === 'OPEN')
    if (hasOpenRun) throw new AppError('A run is already open for this session', 409)

    if (body.sectionId) {
      const section = await prisma.section.findFirst({
        where: { id: body.sectionId, classId: session.classId },
      })
      if (!section) throw new AppError('Section not found in this class', 404)
    }

    const [run] = await prisma.$transaction([
      prisma.sessionRun.create({
        data: {
          sessionId: session.id,
          sectionId: body.sectionId ?? null,
          status: 'OPEN',
          openedAt: new Date(),
        },
        include: { section: { select: { id: true, name: true } } },
      }),
      // Transition session from DRAFT to OPEN on first run
      prisma.session.update({
        where: { id: session.id },
        data: {
          status: session.status === 'DRAFT' ? 'OPEN' : session.status,
        },
      }),
    ])

    getIo().to(session.id).emit('run_status', {
      runId: run.id,
      status: run.status,
      sectionId: run.sectionId,
    })

    res.status(201).json({ success: true, data: { run } })
  } catch (err) {
    next(err)
  }
})

// Update a SessionRun status (OPEN → CLOSED → ARCHIVED)
router.patch('/sessions/:id/runs/:runId', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const body = z.object({
      status: z.enum(['CLOSED', 'ARCHIVED']),
    }).parse(req.body)

    const session = await prisma.session.findFirst({
      where: { id: p(req.params.id), class: { professorId: professor.id } },
      include: { runs: true },
    })
    if (!session) throw new AppError('Session not found', 404)

    const existingRun = session.runs.find((r) => r.id === p(req.params.runId))
    if (!existingRun) throw new AppError('Run not found', 404)

    const updateData: { status: 'CLOSED' | 'ARCHIVED'; closedAt?: Date } = { status: body.status }
    if (body.status === 'CLOSED' && !existingRun.closedAt) {
      updateData.closedAt = new Date()
    }

    const updatedRun = await prisma.sessionRun.update({
      where: { id: existingRun.id },
      data: updateData,
      include: { section: { select: { id: true, name: true } } },
    })

    // If archiving a run, check if all runs are archived — if so, archive the session too
    if (body.status === 'ARCHIVED') {
      const allRuns = session.runs.map((r) =>
        r.id === existingRun.id ? { ...r, status: 'ARCHIVED' as const } : r
      )
      const allArchived = allRuns.length > 0 && allRuns.every((r) => r.status === 'ARCHIVED')
      if (allArchived) {
        await prisma.session.update({
          where: { id: session.id },
          data: { status: 'ARCHIVED' },
        })
      }
    }

    getIo().to(session.id).emit('run_status', {
      runId: updatedRun.id,
      status: updatedRun.status,
      sectionId: updatedRun.sectionId,
    })

    res.json({ success: true, data: { run: updatedRun } })
  } catch (err) {
    next(err)
  }
})

export default router
