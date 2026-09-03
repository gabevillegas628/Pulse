import type { Prisma, Professor } from '@prisma/client'

/**
 * What "this is yours" means, in one place.
 *
 * Ownership was previously answered inline at every query â some fifty
 * `professorId: professor.id` clauses across the route files â which is fine
 * while a professor owns exactly what they created and nobody else may look.
 * It stops being fine the moment there is a second kind of professor: an admin
 * with a system view, a co-instructor, a TA. Each of those is a change to what
 * ownership means, and answering it in fifty places means changing it in fifty
 * places and finding out about the one that was missed from a support email.
 *
 * So the predicates live here. They compose along the schema's own path back to
 * Class â a Question belongs to a Session or an Assignment, both of which belong
 * to a Class, which belongs to a Professor â and each returns the Prisma filter
 * for its own model, so a predicate spread into the wrong query is a type error
 * rather than a silent widening.
 *
 * An admin role arrived (September 2026) and deliberately did not widen these
 * predicates. Admin power lives only under /api/admin (admin.routes.ts), as
 * explicitly unscoped queries behind requireAdmin — so `ownedClass` still means
 * "the class you created" for everyone, an admin using the normal professor UI
 * is just a professor, and the lecture-room check in socket.ts is untouched.
 * The widening this module was built to allow — `Viewer` carrying a role, an
 * institution, co-taught class ids — remains available for the feature that
 * genuinely needs to act as someone else: "view as", or a co-instructor.
 */

/**
 * Who is asking, for the purpose of what they may see and act on.
 *
 * The id alone today, which is all ownership currently depends on. It is a type
 * rather than a bare string so that widening it â to carry a role, an
 * institution, a set of co-taught class ids â does not touch the call sites.
 */
export type Viewer = Pick<Professor, 'id'>

/** Classes this viewer may act on. */
export function ownedClass(viewer: Viewer): Prisma.ClassWhereInput {
  return { professorId: viewer.id }
}

/** Sessions, by way of the class that holds them. */
export function ownedSession(viewer: Viewer): Prisma.SessionWhereInput {
  return { class: ownedClass(viewer) }
}

/** Assignments, by way of the class that holds them. */
export function ownedAssignment(viewer: Viewer): Prisma.AssignmentWhereInput {
  return { class: ownedClass(viewer) }
}

/** Runs of a session. */
export function ownedSessionRun(viewer: Viewer): Prisma.SessionRunWhereInput {
  return { session: ownedSession(viewer) }
}

/**
 * A question hangs off either a session or an assignment, never both, so the two
 * routes to its class are separate predicates rather than one. Callers know
 * which kind of question they are asking about; `ownedQuestion` is for the few
 * that don't.
 */
export function ownedSessionQuestion(viewer: Viewer): Prisma.QuestionWhereInput {
  return { session: ownedSession(viewer) }
}

export function ownedAssignmentQuestion(viewer: Viewer): Prisma.QuestionWhereInput {
  return { assignment: ownedAssignment(viewer) }
}

/** Either parent, for the callers that legitimately don't know which. */
export function ownedQuestion(viewer: Viewer): Prisma.QuestionWhereInput {
  return { OR: [ownedSessionQuestion(viewer), ownedAssignmentQuestion(viewer)] }
}

/** Question groups hang off either parent too, and split the same way. */
export function ownedSessionQuestionGroup(viewer: Viewer): Prisma.QuestionGroupWhereInput {
  return { session: ownedSession(viewer) }
}

export function ownedAssignmentQuestionGroup(viewer: Viewer): Prisma.QuestionGroupWhereInput {
  return { assignment: ownedAssignment(viewer) }
}

/**
 * The same question asked of a record already in hand rather than of the
 * database â a class loaded through a relation, say, where re-querying to check
 * ownership would be a second round trip for something already known.
 *
 * Kept here with the predicates because it is the same policy: when an admin
 * can see everything, this has to agree with `ownedClass` about that, and the
 * only way to be sure of it is for both to be in one file.
 *
 * A type guard rather than a plain boolean, so the null check it already does
 * narrows for the caller instead of being repeated next to it.
 */
export function owns<T extends { professorId: string }>(
  viewer: Viewer,
  record: T | null | undefined
): record is T {
  return record != null && record.professorId === viewer.id
}
