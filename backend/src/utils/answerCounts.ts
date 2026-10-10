import { prisma } from '../db/index.js'

/**
 * Every student's answers to these questions, counted per run, keyed by question.
 *
 * The shape `sectionResponseCount` takes, for the routes that grade one student and so do
 * not otherwise load the whole class's responses. One grouped query instead of the rows.
 */
export async function runAnswerCounts(
  questionIds: string[],
): Promise<Map<string, Array<{ runId: string | null; n: number }>>> {
  const byQuestion = new Map<string, Array<{ runId: string | null; n: number }>>()
  if (questionIds.length === 0) return byQuestion
  const rows = await prisma.response.groupBy({
    by: ['questionId', 'runId'],
    where: { questionId: { in: questionIds } },
    _count: { _all: true },
  })
  for (const row of rows) {
    const list = byQuestion.get(row.questionId) ?? []
    list.push({ runId: row.runId, n: row._count._all })
    byQuestion.set(row.questionId, list)
  }
  return byQuestion
}
