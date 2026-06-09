import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { customAlphabet } from 'nanoid'
import { prisma } from '../db/index.js'
import { AppError } from '../middleware/error.middleware.js'
import { requireProfessor, ProfessorRequest } from '../middleware/auth.middleware.js'
import { generateUniqueCode } from '../utils/codes.js'
import { generateQr } from '../utils/qr.js'
import { p } from '../utils/params.js'
import { config } from '../config/index.js'
import { toInchi } from '../utils/indigo.js'

const nanoidDigits = customAlphabet('0123456789', 4)

const generateUniqueQuestionCode = () =>
  generateUniqueCode(
    nanoidDigits,
    (code) => prisma.question.findUnique({ where: { accessCode: code } }).then(Boolean),
    20
  )

const router = Router()

// ─── Helpers ──────────────────────────────────────────────────────────────────

type ParentType = 'session' | 'assignment'

/** Find a session owned by this professor, checking it exists. */
async function getSession(sessionId: string, professorId: string) {
  const session = await prisma.session.findFirst({
    where: { id: sessionId, class: { professorId } },
    include: { questions: { orderBy: { order: 'desc' }, take: 1 } },
  })
  if (!session) throw new AppError('Session not found', 404)
  return session
}

/** Find an assignment owned by this professor, checking it exists. */
async function getAssignment(assignmentId: string, professorId: string) {
  const assignment = await prisma.assignment.findFirst({
    where: { id: assignmentId, class: { professorId } },
    include: { questions: { orderBy: { order: 'desc' }, take: 1 } },
  })
  if (!assignment) throw new AppError('Assignment not found', 404)
  return assignment
}

// ─── Session question routes ──────────────────────────────────────────────────

// Add a question to a session
router.post('/sessions/:id/questions', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const { text, type, options, groupId, correctAnswer, tolerance, unit } = z.object({
      text: z.string().min(1),
      type: z.enum(['FREE_TEXT', 'MULTIPLE_CHOICE', 'RATING', 'YES_NO', 'NUMERIC', 'MULTI_SELECT', 'ORDERING', 'STRUCTURE']),
      options: z.array(z.string()).optional(),
      groupId: z.string().optional(),
      correctAnswer: z.string().optional(),
      tolerance: z.number().optional(),
      unit: z.string().optional(),
    }).parse(req.body)

    const session = await getSession(p(req.params.id), professor.id)

    // For session questions, check no OPEN run exists when editing (sessions allow edits while DRAFT or when not actively running)
    const openRun = await prisma.sessionRun.findFirst({ where: { sessionId: session.id, status: 'OPEN' } })
    if (openRun) throw new AppError('Cannot add questions while a run is open', 400)

    if (groupId) {
      const group = await prisma.questionGroup.findFirst({ where: { id: groupId, sessionId: session.id } })
      if (!group) throw new AppError('Group not found in this session', 404)
    }

    const nextOrder = (session.questions[0]?.order ?? -1) + 1
    const accessCode = await generateUniqueQuestionCode()

    const question = await prisma.question.create({
      data: {
        sessionId: session.id,
        groupId: groupId ?? null,
        text,
        type: type as import('@prisma/client').QuestionType,
        options: options && options.length > 0 ? options : undefined,
        order: nextOrder,
        accessCode,
        correctAnswer: type === 'NUMERIC' ? (correctAnswer ?? null)
          : type === 'ORDERING' && options && options.length > 0 ? JSON.stringify(options)
          : type === 'MULTI_SELECT' ? (correctAnswer ?? null)
          : undefined,
        tolerance: type === 'NUMERIC' ? (tolerance ?? null) : undefined,
        unit: type === 'NUMERIC' ? (unit ?? null) : undefined,
      },
    })

    const qrDataUrl = await generateQr(`${config.baseUrl}/q/${question.id}`)
    res.status(201).json({ success: true, data: { question: { ...question, qrDataUrl } } })
  } catch (err) {
    next(err)
  }
})

// Create a question group for a session
router.post('/sessions/:id/groups', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const { title, text } = z.object({
      title: z.string().min(1),
      text: z.string().optional(),
    }).parse(req.body)

    const session = await prisma.session.findFirst({
      where: { id: p(req.params.id), class: { professorId: professor.id } },
      include: { groups: { orderBy: { order: 'desc' }, take: 1 } },
    })
    if (!session) throw new AppError('Session not found', 404)

    const nextOrder = (session.groups[0]?.order ?? -1) + 1
    const group = await prisma.questionGroup.create({
      data: { sessionId: session.id, title, text: text ?? null, order: nextOrder },
    })
    res.status(201).json({ success: true, data: { group } })
  } catch (err) {
    next(err)
  }
})

// Update a question group for a session
router.patch('/sessions/:id/groups/:groupId', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const { title, text } = z.object({
      title: z.string().min(1).optional(),
      text: z.string().nullable().optional(),
    }).parse(req.body)

    const group = await prisma.questionGroup.findFirst({
      where: { id: p(req.params.groupId), sessionId: p(req.params.id), session: { class: { professorId: professor.id } } },
    })
    if (!group) throw new AppError('Group not found', 404)

    const updated = await prisma.questionGroup.update({
      where: { id: group.id },
      data: {
        ...(title !== undefined && { title }),
        ...(text !== undefined && { text }),
      },
    })
    res.json({ success: true, data: { group: updated } })
  } catch (err) {
    next(err)
  }
})

// Delete a question group for a session
router.delete('/sessions/:id/groups/:groupId', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const group = await prisma.questionGroup.findFirst({
      where: { id: p(req.params.groupId), sessionId: p(req.params.id), session: { class: { professorId: professor.id } } },
    })
    if (!group) throw new AppError('Group not found', 404)

    await prisma.question.updateMany({ where: { groupId: group.id }, data: { groupId: null } })
    await prisma.questionGroup.delete({ where: { id: group.id } })
    res.json({ success: true, data: null })
  } catch (err) {
    next(err)
  }
})

// Update a session question
router.patch('/sessions/:sessionId/questions/:questionId', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const body = z.object({
      correctAnswer: z.string().nullable().optional(),
      groupId: z.string().nullable().optional(),
      tolerance: z.number().nullable().optional(),
      unit: z.string().nullable().optional(),
      text: z.string().min(1).optional(),
      options: z.array(z.string().min(1)).optional(),
    }).parse(req.body)

    const question = await prisma.question.findFirst({
      where: {
        id: p(req.params.questionId),
        sessionId: p(req.params.sessionId),
        session: { class: { professorId: professor.id } },
      },
      include: { session: { include: { runs: { where: { status: 'OPEN' } } } } },
    })
    if (!question) throw new AppError('Question not found', 404)

    const session = question.session!
    const hasOpenRun = session.runs.length > 0
    const updateData: Record<string, unknown> = {}

    if (body.correctAnswer !== undefined) {
      const bypassClosedCheck = ['NUMERIC', 'ORDERING', 'STRUCTURE'].includes(question.type as string)
      if (!bypassClosedCheck && hasOpenRun)
        throw new AppError('Cannot set answer key while a run is open', 400)
      const ca = body.correctAnswer
      if (ca !== null) {
        if (question.type === 'YES_NO' && !['Yes', 'No'].includes(ca))
          throw new AppError('YES_NO correctAnswer must be "Yes" or "No"', 400)
        if (question.type === 'MULTIPLE_CHOICE') {
          const opts = (question.options as string[] | null) ?? []
          if (!opts.includes(ca))
            throw new AppError('correctAnswer must be one of the question options', 400)
        }
        if (question.type === 'RATING')
          throw new AppError('Cannot set correct answer for rating questions', 400)
        if ((question.type as string) === 'NUMERIC' && isNaN(parseFloat(ca)))
          throw new AppError('NUMERIC correctAnswer must be a valid number', 400)
        if ((question.type as string) === 'MULTI_SELECT') {
          let arr: unknown
          try { arr = JSON.parse(ca) } catch { throw new AppError('MULTI_SELECT correctAnswer must be a JSON array', 400) }
          if (!Array.isArray(arr)) throw new AppError('MULTI_SELECT correctAnswer must be a JSON array', 400)
          const opts = (question.options as string[] | null) ?? []
          if (!(arr as string[]).every(v => opts.includes(v)))
            throw new AppError('MULTI_SELECT correctAnswer values must be among the question options', 400)
        }
        if ((question.type as string) === 'ORDERING') {
          let arr: unknown
          try { arr = JSON.parse(ca) } catch { throw new AppError('ORDERING correctAnswer must be a JSON array', 400) }
          if (!Array.isArray(arr)) throw new AppError('ORDERING correctAnswer must be a JSON array', 400)
          const opts = new Set((question.options as string[] | null) ?? [])
          if ((arr as string[]).length !== opts.size || !(arr as string[]).every(v => opts.has(v)))
            throw new AppError('ORDERING correctAnswer must contain exactly the question options', 400)
        }
      }
      updateData.correctAnswer = (question.type as string) === 'STRUCTURE' && ca !== null
        ? await toInchi(ca)
        : ca
    }

    if (body.tolerance !== undefined) updateData.tolerance = body.tolerance
    if (body.unit !== undefined) updateData.unit = body.unit

    if (body.groupId !== undefined) {
      if (body.groupId !== null) {
        const group = await prisma.questionGroup.findFirst({
          where: { id: body.groupId, sessionId: question.sessionId },
        })
        if (!group) throw new AppError('Group not found in this session', 404)
      }
      updateData.groupId = body.groupId
    }

    if (body.text !== undefined || body.options !== undefined) {
      if (hasOpenRun)
        throw new AppError('Cannot edit question text/options while a run is open', 400)
    }

    if (body.text !== undefined) {
      updateData.text = body.text
    }

    if (body.options !== undefined) {
      const optionTypes = ['MULTIPLE_CHOICE', 'MULTI_SELECT', 'ORDERING']
      if (!optionTypes.includes(question.type as string))
        throw new AppError('This question type does not support options', 400)
      if (body.options.length < 2)
        throw new AppError('Must have at least 2 options', 400)
      updateData.options = body.options

      if (question.correctAnswer !== null) {
        const newOpts = new Set(body.options)
        if (question.type === 'MULTIPLE_CHOICE' && !newOpts.has(question.correctAnswer)) {
          updateData.correctAnswer = null
        }
        if (question.type === 'MULTI_SELECT' || (question.type as string) === 'ORDERING') {
          try {
            const arr = JSON.parse(question.correctAnswer) as string[]
            if (!arr.every(v => newOpts.has(v))) updateData.correctAnswer = null
          } catch { /* malformed stored value — leave as-is */ }
        }
      }
    }

    const updated = await prisma.question.update({ where: { id: question.id }, data: updateData })
    res.json({ success: true, data: { question: updated } })
  } catch (err) {
    next(err)
  }
})

// Delete a session question (no open run)
router.delete('/sessions/:sessionId/questions/:questionId', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const question = await prisma.question.findFirst({
      where: {
        id: p(req.params.questionId),
        sessionId: p(req.params.sessionId),
        session: { class: { professorId: professor.id } },
      },
      include: { session: { include: { runs: { where: { status: 'OPEN' } } } } },
    })
    if (!question) throw new AppError('Question not found', 404)
    if (question.session!.runs.length > 0) throw new AppError('Cannot delete questions while a run is open', 400)
    await prisma.question.delete({ where: { id: question.id } })
    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

// Bulk reorder session questions
router.put('/sessions/:id/questions/reorder', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const items = z.array(z.object({ id: z.string(), order: z.number().int() })).parse(req.body)

    const session = await prisma.session.findFirst({
      where: { id: p(req.params.id), class: { professorId: professor.id } },
    })
    if (!session) throw new AppError('Session not found', 404)

    await prisma.$transaction(
      items.map(({ id, order }) =>
        prisma.question.updateMany({ where: { id, sessionId: session.id }, data: { order } })
      )
    )
    res.json({ success: true, data: null })
  } catch (err) {
    next(err)
  }
})

// Bulk reorder session groups
router.put('/sessions/:id/groups/reorder', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const items = z.array(z.object({ id: z.string(), order: z.number().int() })).parse(req.body)

    const session = await prisma.session.findFirst({
      where: { id: p(req.params.id), class: { professorId: professor.id } },
    })
    if (!session) throw new AppError('Session not found', 404)

    await prisma.$transaction(
      items.map(({ id, order }) =>
        prisma.questionGroup.updateMany({ where: { id, sessionId: session.id }, data: { order } })
      )
    )
    res.json({ success: true, data: null })
  } catch (err) {
    next(err)
  }
})

// ─── Assignment question routes ───────────────────────────────────────────────

// Add a question to an assignment
router.post('/assignments/:id/questions', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const { text, type, options, groupId, correctAnswer, tolerance, unit } = z.object({
      text: z.string().min(1),
      type: z.enum(['FREE_TEXT', 'MULTIPLE_CHOICE', 'RATING', 'YES_NO', 'NUMERIC', 'MULTI_SELECT', 'ORDERING', 'STRUCTURE']),
      options: z.array(z.string()).optional(),
      groupId: z.string().optional(),
      correctAnswer: z.string().optional(),
      tolerance: z.number().optional(),
      unit: z.string().optional(),
    }).parse(req.body)

    const assignment = await getAssignment(p(req.params.id), professor.id)

    if (assignment.status === 'CLOSED' || assignment.status === 'ARCHIVED')
      throw new AppError('Cannot add questions to a closed or archived assignment', 400)

    if (groupId) {
      const group = await prisma.questionGroup.findFirst({ where: { id: groupId, assignmentId: assignment.id } })
      if (!group) throw new AppError('Group not found in this assignment', 404)
    }

    const nextOrder = (assignment.questions[0]?.order ?? -1) + 1
    const accessCode = await generateUniqueQuestionCode()

    const question = await prisma.question.create({
      data: {
        assignmentId: assignment.id,
        groupId: groupId ?? null,
        text,
        type: type as import('@prisma/client').QuestionType,
        options: options && options.length > 0 ? options : undefined,
        order: nextOrder,
        accessCode,
        correctAnswer: type === 'NUMERIC' ? (correctAnswer ?? null)
          : type === 'ORDERING' && options && options.length > 0 ? JSON.stringify(options)
          : type === 'MULTI_SELECT' ? (correctAnswer ?? null)
          : undefined,
        tolerance: type === 'NUMERIC' ? (tolerance ?? null) : undefined,
        unit: type === 'NUMERIC' ? (unit ?? null) : undefined,
      },
    })

    const qrDataUrl = await generateQr(`${config.baseUrl}/q/${question.id}`)
    res.status(201).json({ success: true, data: { question: { ...question, qrDataUrl } } })
  } catch (err) {
    next(err)
  }
})

// Create a question group for an assignment
router.post('/assignments/:id/groups', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const { title, text } = z.object({
      title: z.string().min(1),
      text: z.string().optional(),
    }).parse(req.body)

    const assignment = await prisma.assignment.findFirst({
      where: { id: p(req.params.id), class: { professorId: professor.id } },
      include: { groups: { orderBy: { order: 'desc' }, take: 1 } },
    })
    if (!assignment) throw new AppError('Assignment not found', 404)

    const nextOrder = (assignment.groups[0]?.order ?? -1) + 1
    const group = await prisma.questionGroup.create({
      data: { assignmentId: assignment.id, title, text: text ?? null, order: nextOrder },
    })
    res.status(201).json({ success: true, data: { group } })
  } catch (err) {
    next(err)
  }
})

// Update a question group for an assignment
router.patch('/assignments/:id/groups/:groupId', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const { title, text } = z.object({
      title: z.string().min(1).optional(),
      text: z.string().nullable().optional(),
    }).parse(req.body)

    const group = await prisma.questionGroup.findFirst({
      where: { id: p(req.params.groupId), assignmentId: p(req.params.id), assignment: { class: { professorId: professor.id } } },
    })
    if (!group) throw new AppError('Group not found', 404)

    const updated = await prisma.questionGroup.update({
      where: { id: group.id },
      data: {
        ...(title !== undefined && { title }),
        ...(text !== undefined && { text }),
      },
    })
    res.json({ success: true, data: { group: updated } })
  } catch (err) {
    next(err)
  }
})

// Delete a question group for an assignment
router.delete('/assignments/:id/groups/:groupId', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const group = await prisma.questionGroup.findFirst({
      where: { id: p(req.params.groupId), assignmentId: p(req.params.id), assignment: { class: { professorId: professor.id } } },
    })
    if (!group) throw new AppError('Group not found', 404)

    await prisma.question.updateMany({ where: { groupId: group.id }, data: { groupId: null } })
    await prisma.questionGroup.delete({ where: { id: group.id } })
    res.json({ success: true, data: null })
  } catch (err) {
    next(err)
  }
})

// Update an assignment question
router.patch('/assignments/:assignmentId/questions/:questionId', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const body = z.object({
      correctAnswer: z.string().nullable().optional(),
      groupId: z.string().nullable().optional(),
      tolerance: z.number().nullable().optional(),
      unit: z.string().nullable().optional(),
      text: z.string().min(1).optional(),
      options: z.array(z.string().min(1)).optional(),
    }).parse(req.body)

    const question = await prisma.question.findFirst({
      where: {
        id: p(req.params.questionId),
        assignmentId: p(req.params.assignmentId),
        assignment: { class: { professorId: professor.id } },
      },
      include: { assignment: true },
    })
    if (!question) throw new AppError('Question not found', 404)

    const assignment = question.assignment!
    const updateData: Record<string, unknown> = {}

    if (body.correctAnswer !== undefined) {
      const bypassClosedCheck = ['NUMERIC', 'ORDERING', 'STRUCTURE'].includes(question.type as string)
      if (!bypassClosedCheck && assignment.status === 'OPEN') {
        // Allow setting answer keys even while open for assignments
      } else if (!bypassClosedCheck && assignment.status === 'ARCHIVED') {
        throw new AppError('Cannot set answer key on archived assignment', 400)
      }
      const ca = body.correctAnswer
      if (ca !== null) {
        if (question.type === 'YES_NO' && !['Yes', 'No'].includes(ca))
          throw new AppError('YES_NO correctAnswer must be "Yes" or "No"', 400)
        if (question.type === 'MULTIPLE_CHOICE') {
          const opts = (question.options as string[] | null) ?? []
          if (!opts.includes(ca))
            throw new AppError('correctAnswer must be one of the question options', 400)
        }
        if (question.type === 'RATING')
          throw new AppError('Cannot set correct answer for rating questions', 400)
        if ((question.type as string) === 'NUMERIC' && isNaN(parseFloat(ca)))
          throw new AppError('NUMERIC correctAnswer must be a valid number', 400)
        if ((question.type as string) === 'MULTI_SELECT') {
          let arr: unknown
          try { arr = JSON.parse(ca) } catch { throw new AppError('MULTI_SELECT correctAnswer must be a JSON array', 400) }
          if (!Array.isArray(arr)) throw new AppError('MULTI_SELECT correctAnswer must be a JSON array', 400)
          const opts = (question.options as string[] | null) ?? []
          if (!(arr as string[]).every(v => opts.includes(v)))
            throw new AppError('MULTI_SELECT correctAnswer values must be among the question options', 400)
        }
        if ((question.type as string) === 'ORDERING') {
          let arr: unknown
          try { arr = JSON.parse(ca) } catch { throw new AppError('ORDERING correctAnswer must be a JSON array', 400) }
          if (!Array.isArray(arr)) throw new AppError('ORDERING correctAnswer must be a JSON array', 400)
          const opts = new Set((question.options as string[] | null) ?? [])
          if ((arr as string[]).length !== opts.size || !(arr as string[]).every(v => opts.has(v)))
            throw new AppError('ORDERING correctAnswer must contain exactly the question options', 400)
        }
      }
      updateData.correctAnswer = (question.type as string) === 'STRUCTURE' && ca !== null
        ? await toInchi(ca)
        : ca
    }

    if (body.tolerance !== undefined) updateData.tolerance = body.tolerance
    if (body.unit !== undefined) updateData.unit = body.unit

    if (body.groupId !== undefined) {
      if (body.groupId !== null) {
        const group = await prisma.questionGroup.findFirst({
          where: { id: body.groupId, assignmentId: question.assignmentId },
        })
        if (!group) throw new AppError('Group not found in this assignment', 404)
      }
      updateData.groupId = body.groupId
    }

    if (body.text !== undefined || body.options !== undefined) {
      if (assignment.status === 'ARCHIVED')
        throw new AppError('Cannot edit questions on an archived assignment', 400)
    }

    if (body.text !== undefined) {
      updateData.text = body.text
    }

    if (body.options !== undefined) {
      const optionTypes = ['MULTIPLE_CHOICE', 'MULTI_SELECT', 'ORDERING']
      if (!optionTypes.includes(question.type as string))
        throw new AppError('This question type does not support options', 400)
      if (body.options.length < 2)
        throw new AppError('Must have at least 2 options', 400)
      updateData.options = body.options

      if (question.correctAnswer !== null) {
        const newOpts = new Set(body.options)
        if (question.type === 'MULTIPLE_CHOICE' && !newOpts.has(question.correctAnswer)) {
          updateData.correctAnswer = null
        }
        if (question.type === 'MULTI_SELECT' || (question.type as string) === 'ORDERING') {
          try {
            const arr = JSON.parse(question.correctAnswer) as string[]
            if (!arr.every(v => newOpts.has(v))) updateData.correctAnswer = null
          } catch { /* malformed stored value — leave as-is */ }
        }
      }
    }

    const updated = await prisma.question.update({ where: { id: question.id }, data: updateData })
    res.json({ success: true, data: { question: updated } })
  } catch (err) {
    next(err)
  }
})

// Delete an assignment question
router.delete('/assignments/:assignmentId/questions/:questionId', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const question = await prisma.question.findFirst({
      where: {
        id: p(req.params.questionId),
        assignmentId: p(req.params.assignmentId),
        assignment: { class: { professorId: professor.id } },
      },
      include: { assignment: { select: { status: true } } },
    })
    if (!question) throw new AppError('Question not found', 404)
    if (question.assignment!.status === 'ARCHIVED') throw new AppError('Cannot delete questions on an archived assignment', 400)
    await prisma.question.delete({ where: { id: question.id } })
    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

// Bulk reorder assignment questions
router.put('/assignments/:id/questions/reorder', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const items = z.array(z.object({ id: z.string(), order: z.number().int() })).parse(req.body)

    const assignment = await prisma.assignment.findFirst({
      where: { id: p(req.params.id), class: { professorId: professor.id } },
    })
    if (!assignment) throw new AppError('Assignment not found', 404)

    await prisma.$transaction(
      items.map(({ id, order }) =>
        prisma.question.updateMany({ where: { id, assignmentId: assignment.id }, data: { order } })
      )
    )
    res.json({ success: true, data: null })
  } catch (err) {
    next(err)
  }
})

// Bulk reorder assignment groups
router.put('/assignments/:id/groups/reorder', requireProfessor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const items = z.array(z.object({ id: z.string(), order: z.number().int() })).parse(req.body)

    const assignment = await prisma.assignment.findFirst({
      where: { id: p(req.params.id), class: { professorId: professor.id } },
    })
    if (!assignment) throw new AppError('Assignment not found', 404)

    await prisma.$transaction(
      items.map(({ id, order }) =>
        prisma.questionGroup.updateMany({ where: { id, assignmentId: assignment.id }, data: { order } })
      )
    )
    res.json({ success: true, data: null })
  } catch (err) {
    next(err)
  }
})

export default router
