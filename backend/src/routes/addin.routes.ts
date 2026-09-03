import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { prisma } from '../db/index.js'
import { AppError } from '../middleware/error.middleware.js'
import { requireProfessor, ProfessorRequest } from '../middleware/auth.middleware.js'
import { Viewer, ownedClass, ownedQuestion, ownedSessionRun, owns } from '../utils/ownership.js'
import { generateUniqueCode } from '../utils/codes.js'
import { generateQuestionQr } from '../utils/qr.js'
import { p } from '../utils/params.js'
import { customAlphabet } from 'nanoid'
import { readThemeSetsForRun } from '../services/themes.service.js'
import { autoCloseEnabled, clockState } from '../services/clock.service.js'

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
      if (!owns(professor, owner)) {
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
async function findOwnedQuestion(questionId: string, viewer: Viewer) {
  return prisma.question.findFirst({
    where: { id: questionId, ...ownedQuestion(viewer) },
    select: { id: true, accessCode: true, title: true, text: true },
  })
}

router.post('/adopt-code', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor
    const { questionId, code } = adoptSchema.parse(req.body)

    const target = await findOwnedQuestion(questionId, professor)
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
    const ownedHolder = await findOwnedQuestion(holder.id, professor)
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
    const question = await findOwnedQuestion(p(req.params.id), professor)
    if (!question) throw new AppError('Question not found', 404)

    const qrDataUrl = await generateQuestionQr(question.accessCode)
    // Text comes back too: the add-in draws the full question card client-side, which
    // needs the wording, not just the code.
    res.json({
      success: true,
      data: {
        accessCode: question.accessCode,
        qrDataUrl,
        title: question.title,
        text: question.text,
      },
    })
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
async function loadClassForRebind(classId: string, viewer: Viewer) {
  const cls = await prisma.class.findFirst({
    where: { id: classId, ...ownedClass(viewer) },
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
      loadClassForRebind(fromClassId, professor),
      loadClassForRebind(toClassId, professor),
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

// ─── Live results for the in-slide display ───────────────────────────────────

/**
 * The professor's currently-open session, shaped for projection.
 *
 * Requires no configuration: the content add-in on a slide just asks "what is live
 * right now?". Opening a session in Pulse is the only action, and the slide follows.
 *
 * Student identity is stripped here rather than in the UI. This payload is rendered on
 * a lecture-hall projector, so netIDs must not be in the data at all — a rendering bug
 * should not be able to expose them.
 */
router.get('/live', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professor = (req as ProfessorRequest).professor

    const run = await prisma.sessionRun.findFirst({
      where: { status: 'OPEN', ...ownedSessionRun(professor) },
      orderBy: { openedAt: 'desc' },
      select: { id: true, sessionId: true, openedAt: true },
    })
    if (!run) return res.json({ success: true, data: { session: null } })

    const session = await prisma.session.findUnique({
      where: { id: run.sessionId },
      select: {
        id: true,
        title: true,
        class: {
          select: { name: true, liveThemesDefault: true, autoCloseDefault: true, _count: { select: { enrollments: true } } },
        },
        questions: {
          orderBy: { order: 'asc' },
          select: {
            id: true,
            title: true,
            text: true,
            type: true,
            options: true,
            order: true,
            correctAnswer: true,
            liveThemes: true,
            autoClose: true,
            responses: {
              orderBy: { submittedAt: 'desc' },
              // No student relation: identity must not reach the projector.
              select: {
                id: true,
                responseText: true,
                wordCount: true,
                isFlagged: true,
                submittedAt: true,
                aiScore: true,
              },
            },
          },
        },
      },
    })
    if (!session) return res.json({ success: true, data: { session: null } })

    // Whichever question most recently received an answer is where the class is now.
    let activeQuestionId: string | null = null
    let latest = 0
    for (const q of session.questions) {
      const t = q.responses[0] ? new Date(q.responses[0].submittedAt).getTime() : 0
      if (t > latest) { latest = t; activeQuestionId = q.id }
    }
    // Before anyone has answered, show the first question rather than nothing.
    if (!activeQuestionId) activeQuestionId = session.questions[0]?.id ?? null

    const themesByQuestion = await readThemeSetsForRun(run.id, session.questions, session.class)

    const now = Date.now()

    const questions = session.questions.map((q) => {
      const isFreeText = q.type === 'FREE_TEXT'
      const timed = autoCloseEnabled(q, session.class)
      const clock = timed ? clockState(run.id, q.id) : null
      const deadline = clock?.closesAt ?? null
      // A timed question with no clock yet has not been answered, so it is open.
      const stillOpen = timed && (deadline === null || deadline > now)
      const { correctAnswer, ...questionRest } = q
      return {
        ...questionRest,
        // Withheld while the question can still be answered. A student who has not
        // answered must not be able to read the answer key off the projector — that is
        // a copy channel entirely separate from waiting for the explanation. Stripped
        // here rather than gated in the UI so a rendering bug cannot leak it, which is
        // how student identity is already handled on this route. ResultsSummary simply
        // renders no correct option until it arrives; the bars and counts are unchanged.
        correctAnswer: stillOpen ? null : correctAnswer,
        // Absolute epoch ms, so the projector animates against a fixed point instead of
        // resetting off its own poll interval. null means untimed or not yet started.
        closesAt: deadline,
        // The span the deadline belongs to, so a bar mounting mid-drain can seek into
        // its animation rather than restarting from full.
        closeWindowMs: clock?.windowMs ?? null,
        autoCloseOn: timed,
        // Free text answers are quasi-identifying — "as I said in office hours" names a
        // student as surely as a netID does. The projector only ever needs counts and
        // categories for them, so the words do not travel at all. Every other type needs
        // responseText: ResultsSummary buckets choices and numbers by it.
        responses: isFreeText
          ? q.responses.map(({ responseText: _drop, ...rest }) => rest)
          : q.responses,
        // null means theming is off for this question, not that it has no categories yet.
        themes: isFreeText ? themesByQuestion.get(q.id) ?? null : null,
      }
    })

    res.json({
      success: true,
      data: {
        session: {
          id: session.id,
          title: session.title,
          className: session.class.name,
          enrolledCount: session.class._count.enrollments,
          questions,
        },
        activeQuestionId,
        runId: run.id,
      },
    })
  } catch (err) {
    next(err)
  }
})

export default router
