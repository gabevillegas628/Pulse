import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { customAlphabet } from 'nanoid'
import QRCode from 'qrcode'
import { prisma } from '../db/index.js'
import { config } from '../config/index.js'
import { AppError } from '../middleware/error.middleware.js'
import { requireProfessor, ProfessorRequest } from '../middleware/auth.middleware.js'
import { getIo } from '../socket.js'
import { SessionStatus } from 'shared'

const nanoidDigits = customAlphabet('0123456789', 4)

const router = Router()
const p = (v: string | string[]): string => (Array.isArray(v) ? v[0] : v)

const questionInputSchema = z.object({
  text: z.string().min(1),
  type: z.enum(['FREE_TEXT', 'MULTIPLE_CHOICE', 'RATING', 'YES_NO']),
  options: z.array(z.string()).optional(),
  order: z.number().int().min(0),
})

const createSessionSchema = z.object({
  title: z.string().min(1),
  questions: z.array(questionInputSchema).min(1),
})

async function generateQr(sessionId: string): Promise<string> {
  const url = `${config.baseUrl}/s/${sessionId}`
  return QRCode.toDataURL(url, { width: 400, margin: 2 })
}

// --- Professor-owned session routes ---

router.post('/classes/:classId/sessions', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const body = createSessionSchema.parse(req.body)

    const cls = await prisma.class.findFirst({
      where: { id: p(req.params.classId), professorId: professor.id },
    })
    if (!cls) throw new AppError('Class not found', 404)

    let accessCode: string
    let attempts = 0
    do {
      accessCode = nanoidDigits()
      attempts++
      if (attempts > 20) throw new AppError('Failed to generate unique access code', 500)
    } while (await prisma.session.findUnique({ where: { accessCode } }))

    const session = await prisma.session.create({
      data: {
        classId: cls.id,
        title: body.title,
        accessCode,
        questions: {
          create: body.questions.map((q) => ({
            text: q.text,
            type: q.type,
            options: q.options && q.options.length > 0 ? q.options : undefined,
            order: q.order,
          })),
        },
      },
      include: { questions: { orderBy: { order: 'asc' } } },
    })

    const qrDataUrl = await generateQr(session.id)
    res.status(201).json({ success: true, data: { session, qrDataUrl } })
  } catch (err) {
    next(err)
  }
})

router.get('/classes/:classId/sessions', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const cls = await prisma.class.findFirst({
      where: { id: p(req.params.classId), professorId: professor.id },
    })
    if (!cls) throw new AppError('Class not found', 404)

    const sessions = await prisma.session.findMany({
      where: { classId: cls.id },
      orderBy: { createdAt: 'desc' },
      include: {
        questions: { orderBy: { order: 'asc' } },
        _count: { select: { questions: true } },
      },
    })
    res.json({ success: true, data: { sessions } })
  } catch (err) {
    next(err)
  }
})

router.get('/sessions/:id', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const session = await prisma.session.findFirst({
      where: { id: p(req.params.id), class: { professorId: professor.id } },
      include: {
        class: { select: { id: true, name: true } },
        questions: {
          orderBy: { order: 'asc' },
          include: {
            responses: {
              include: { student: { select: { id: true, netId: true, name: true } } },
              orderBy: { submittedAt: 'desc' },
            },
          },
        },
      },
    })
    if (!session) throw new AppError('Session not found', 404)

    const qrDataUrl = await generateQr(session.id)
    res.json({ success: true, data: { session: { ...session, qrDataUrl } } })
  } catch (err) {
    next(err)
  }
})

router.patch('/sessions/:id', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const { status } = z.object({ status: z.nativeEnum(SessionStatus) }).parse(req.body)

    const existing = await prisma.session.findFirst({
      where: { id: p(req.params.id), class: { professorId: professor.id } },
    })
    if (!existing) throw new AppError('Session not found', 404)

    const updated = await prisma.session.update({
      where: { id: p(req.params.id) },
      data: {
        status,
        closedAt: status === SessionStatus.CLOSED && !existing.closedAt ? new Date() : existing.closedAt,
      },
    })

    getIo().to(p(req.params.id)).emit('session_status', { status })
    res.json({ success: true, data: { session: updated } })
  } catch (err) {
    next(err)
  }
})

router.delete('/sessions/:id', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const existing = await prisma.session.findFirst({
      where: { id: p(req.params.id), class: { professorId: professor.id } },
    })
    if (!existing) throw new AppError('Session not found', 404)
    await prisma.session.delete({ where: { id: p(req.params.id) } })
    res.json({ success: true, data: null })
  } catch (err) {
    next(err)
  }
})

// CSV export
router.get('/sessions/:id/export', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const session = await prisma.session.findFirst({
      where: { id: p(req.params.id), class: { professorId: professor.id } },
      include: {
        questions: {
          orderBy: { order: 'asc' },
          include: {
            responses: {
              include: { student: { select: { netId: true, name: true } } },
            },
          },
        },
      },
    })
    if (!session) throw new AppError('Session not found', 404)

    // Build wide-format CSV: one row per student
    const studentMap = new Map<string, { netId: string; name: string; answers: string[] }>()

    for (const question of session.questions) {
      for (const resp of question.responses) {
        const key = resp.student.netId
        if (!studentMap.has(key)) {
          studentMap.set(key, { netId: resp.student.netId, name: resp.student.name, answers: [] })
        }
      }
    }

    // Fill answers in question order
    for (const question of session.questions) {
      const responseByNetId = new Map(question.responses.map((r) => [r.student.netId, r]))
      for (const [netId, row] of studentMap) {
        const r = responseByNetId.get(netId)
        row.answers.push(r ? r.responseText : '')
      }
    }

    const questionHeaders = session.questions.map((q, i) => `Q${i + 1}: ${q.text.replace(/,/g, ' ')}`)

    const header = ['NetID', 'Name', ...questionHeaders, 'SubmittedAt'].join(',')
    const rows = [...studentMap.values()].map((row) => {
      return [row.netId, `"${row.name}"`, ...row.answers.map((a) => `"${a.replace(/"/g, '""')}"`), ''].join(',')
    })

    const csv = [header, ...rows].join('\n')
    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', `attachment; filename="session-${session.id}.csv"`)
    res.send(csv)
  } catch (err) {
    next(err)
  }
})

// --- Public session lookup (no auth) ---
router.get('/sessions/by-code/:code', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const session = await prisma.session.findUnique({
      where: { accessCode: p(req.params.code) },
      include: { questions: { orderBy: { order: 'asc' } } },
    })
    if (!session) throw new AppError('Session not found', 404)
    if (session.status === 'CLOSED' || session.status === 'ARCHIVED') {
      throw new AppError('Session is closed', 409)
    }
    res.json({ success: true, data: { sessionId: session.id, title: session.title } })
  } catch (err) {
    next(err)
  }
})

export default router
