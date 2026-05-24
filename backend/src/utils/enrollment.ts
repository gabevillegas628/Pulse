import { prisma } from '../db/index.js'

/**
 * Auto-enroll a student in a class, and assign them to a section if one
 * is targeted by the session and the student doesn't already have one.
 *
 * Safe to call multiple times — uses upsert semantics.
 */
export async function upsertEnrollment(
  studentId: string,
  classId: string,
  sectionId: string | null | undefined
): Promise<void> {
  const existing = await prisma.enrollment.findUnique({
    where: { studentId_classId: { studentId, classId } },
  })
  await prisma.enrollment.upsert({
    where: { studentId_classId: { studentId, classId } },
    create: { studentId, classId, sectionId: sectionId ?? null },
    update: sectionId && !existing?.sectionId ? { sectionId } : {},
  })
}
