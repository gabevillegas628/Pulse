import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { prisma } from '../db/index.js'
import { AppError } from '../middleware/error.middleware.js'
import { requireProfessor, ProfessorRequest } from '../middleware/auth.middleware.js'
import { generateUniqueCode } from '../utils/codes.js'
import { generateQuestionQr } from '../utils/qr.js'
import { p } from '../utils/params.js'
import { customAlphabet } from 'nanoid'

const nanoidDigits = customAlphabet('0123456789', 4)

const router = Router()
router.use(requireProfessor)

/**
 * Endpoints backing the PowerPoint add-in.
 *
 * The add-in's job is to keep a deck's printed access codes true. Slides bind to a
 * question by its `accessCode` (see utils/qr.ts for why the QR is code-based), so
 * "keeping the deck true" means either confirming the code still resolves, or moving
 * the code onto whichever question the slide is now meant to point at.
 */

// ─── Preflight: do these codes still resolve, and to what? ────────────────────

const verifySchema = z.object({
  codes: z.array(z.string().min(1).max(16)).min(1).max(500),
})

router.post('/verify', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const { codes } = verifySchema.parse(req.body)

    // De-duplicate: a deck may legitimately repeat a code across slides
    const unique = [...new Set(codes)]

    const questions = await prisma.question.findMany({
      where: { accessCode: { in: unique } },
      select: {
        id: true,
        accessCode: true,
        title: true,
        text: true,
        type: true,
        order: true,
        session: {
          select: {
            id: true,
            title: true,
            status: true,
            classId: true,
            class: { select: { id: true, name: true, professorId: true } },
            runs: { where: { status: 'OPEN' }, select: { id: true } },
          },
        },
        assignment: {
          select: {
            id: true,
            title: true,
            status: true,
            class: { select: { id: true, name: true, professorId: true } },
          },
        },
      },
    })

    const byCode = new Map(questions.map((q) => [q.accessCode, q]))

    const results = unique.map((code) => {
      const q = byCode.get(code)
      if (!q) return { code, status: 'not_found' as const }

      const owner = q.session?.class ?? q.assignment?.class ?? null
      // Codes are globally unique, so a lookup can land on another professor's question.
      // Report it as unknown rather than leaking their class or question text.
      if (!owner || owner.professorId !== professor.id) {
        return { code, status: 'not_found' as const }
      }

      return {
        code,
        status: 'ok' as const,
        question: { id: q.id, title: q.title, text: q.text, type: q.type, order: q.order },
        class: { id: owner.id, name: owner.name },
        session: q.session
          ? {
              id: q.session.id,
              title: q.session.title,
              status: q.session.status,
              // Whether a student scanning right now would actually get in
              isLive: q.session.runs.length > 0,
            }
          : null,
        assignment: q.assignment
          ? { id: q.assignment.id, title: q.assignment.title, status: q.assignment.status }
          : null,
      }
    })

    res.json({ success: true, data: { results } })
  } catch (err) {
    next(err)
  }
})

// ─── Adopt: move a code onto a question, so the deck needn't change ───────────

const adoptSchema = z.object({
  questionId: z.string().min(1),
  code: z.string().regex(/^\d{4}$/, 'Code must be 4 digits'),
})

/** Load a question the professor owns, via either its session's or assignment's class. */
async function findOwnedQuestion(questionId: string, professorId: string) {
  return prisma.question.findFirst({
    where: {
      id: questionId,
      OR: [
        { session: { class: { professorId } } },
        { assignment: { class: { professorId } } },
      ],
    },
    select: { id: true, accessCode: true },
  })
}

router.post('/adopt-code', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const { questionId, code } = adoptSchema.parse(req.body)

    const target = await findOwnedQuestion(questionId, professor.id)
    if (!target) throw new AppError('Question not found', 404)

    if (target.accessCode === code) {
      return res.json({ success: true, data: { changed: false, accessCode: code } })
    }

    const holder = await prisma.question.findUnique({
      where: { accessCode: code },
      select: { id: true },
    })

    // Free code — straight rename, no swap needed.
    if (!holder) {
      const updated = await prisma.question.update({
        where: { id: target.id },
        data: { accessCode: code },
        select: { accessCode: true },
      })
      return res.json({ success: true, data: { changed: true, accessCode: updated.accessCode } })
    }

    // Held by someone else's question: refuse rather than steal it.
    const ownedHolder = await findOwnedQuestion(holder.id, professor.id)
    if (!ownedHolder) {
      throw new AppError('That code belongs to another professor’s question', 409)
    }

    // Held by one of the professor's own questions: swap, so neither is left without a
    // code. accessCode is globally unique, so this needs a temporary parking value —
    // the same three-step dance the class duplication route uses.
    const tempCode = await generateUniqueCode(
      nanoidDigits,
      (c) => prisma.question.findUnique({ where: { accessCode: c } }).then(Boolean),
      20
    )

    const result = await prisma.$transaction(async (tx) => {
      await tx.question.update({ where: { id: ownedHolder.id }, data: { accessCode: tempCode } })
      await tx.question.update({ where: { id: target.id }, data: { accessCode: code } })
      await tx.question.update({
        where: { id: ownedHolder.id },
        data: { accessCode: target.accessCode },
      })
      return { swappedWith: ownedHolder.id, swappedWithCode: target.accessCode }
    })

    res.json({ success: true, data: { changed: true, accessCode: code, ...result } })
  } catch (err) {
    next(err)
  }
})

// ─── QR for one question (first insert, and the re-stamp fallback) ────────────

router.get('/questions/:id/qr', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const question = await findOwnedQuestion(p(req.params.id), professor.id)
    if (!question) throw new AppError('Question not found', 404)

    const qrDataUrl = await generateQuestionQr(question.accessCode)
    res.json({ success: true, data: { accessCode: question.accessCode, qrDataUrl } })
  } catch (err) {
    next(err)
  }
})

// ─── Rebind: propose an old→new mapping after a class duplication ────────────

const rebindSchema = z.object({
  fromClassId: z.string().min(1),
  toClassId: z.string().min(1),
})

/** Sessions with their questions, for one class the professor owns. */
async function loadClassForRebind(classId: string, professorId: string) {
  const cls = await prisma.class.findFirst({
    where: { id: classId, professorId },
    select: {
      id: true,
      name: true,
      sessions: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          title: true,
          questions: {
            orderBy: { order: 'asc' },
            select: { id: true, accessCode: true, title: true, text: true, order: true },
          },
        },
      },
    },
  })
  if (!cls) throw new AppError('Class not found', 404)
  return cls
}

/**
 * Propose how a deck built against `fromClass` should re-point at `toClass`.
 *
 * Matches on session title then question order — question ids and codes both change
 * during duplication, so neither can be the join key. Read-only: the add-in shows the
 * proposal for confirmation and then calls adopt-code per row.
 */
router.post('/rebind', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const { fromClassId, toClassId } = rebindSchema.parse(req.body)

    if (fromClassId === toClassId) throw new AppError('Classes must differ', 400)

    const [from, to] = await Promise.all([
      loadClassForRebind(fromClassId, professor.id),
      loadClassForRebind(toClassId, professor.id),
    ])

    // Session titles are not unique in principle; pair same-titled sessions in order
    // so a class with two "Week 3" sessions still maps predictably.
    const toBuckets = new Map<string, typeof to.sessions>()
    for (const s of to.sessions) {
      const key = s.title.trim().toLowerCase()
      const bucket = toBuckets.get(key)
      if (bucket) bucket.push(s)
      else toBuckets.set(key, [s])
    }
    const consumed = new Map<string, number>()

    const mappings: Array<{
      fromCode: string
      fromQuestion: { id: string; title: string | null; text: string }
      sessionTitle: string
      to: { questionId: string; currentCode: string; title: string | null; text: string } | null
      reason?: string
    }> = []

    for (const srcSession of from.sessions) {
      const key = srcSession.title.trim().toLowerCase()
      const bucket = toBuckets.get(key) ?? []
      const nth = consumed.get(key) ?? 0
      const destSession = bucket[nth] ?? null
      consumed.set(key, nth + 1)

      for (const q of srcSession.questions) {
        const dest = destSession?.questions.find((d) => d.order === q.order) ?? null
        mappings.push({
          fromCode: q.accessCode,
          fromQuestion: { id: q.id, title: q.title, text: q.text },
          sessionTitle: srcSession.title,
          to: dest
            ? { questionId: dest.id, currentCode: dest.accessCode, title: dest.title, text: dest.text }
            : null,
          ...(dest
            ? {}
            : {
                reason: destSession
                  ? `No question at position ${q.order + 1} in "${srcSession.title}"`
                  : `No session titled "${srcSession.title}" in ${to.name}`,
              }),
        })
      }
    }

    res.json({
      success: true,
      data: {
        from: { id: from.id, name: from.name },
        to: { id: to.id, name: to.name },
        mappings,
        matched: mappings.filter((m) => m.to !== null).length,
        unmatched: mappings.filter((m) => m.to === null).length,
      },
    })
  } catch (err) {
    next(err)
  }
})

export default router
