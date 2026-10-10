import type { QuestionWithResponses, SessionRun } from 'shared'
import { SessionStatus } from 'shared'

/**
 * Skipping a question, as the session page sees it. The server decides what counts for
 * grades; this mirrors it so the page shows the same thing: answers from a section that
 * skipped the question are kept but drop out of the counts, the list and the grading.
 */

/** A section this session has been run in. `id` null is a run opened for everyone. */
export interface RunSectionOption {
  id: string | null
  name: string | null
  isLive: boolean
}

/** Each section the session has run in, once, with the one live now first. */
export function runSections(runs: SessionRun[]): RunSectionOption[] {
  const byId = new Map<string | null, RunSectionOption>()
  for (const r of runs) {
    const prev = byId.get(r.sectionId)
    byId.set(r.sectionId, {
      id: r.sectionId,
      name: r.section?.name ?? prev?.name ?? null,
      isLive: (prev?.isLive ?? false) || r.status === SessionStatus.OPEN,
    })
  }
  return [...byId.values()].sort((a, b) => Number(b.isLive) - Number(a.isLive))
}

function skippedIds(q: QuestionWithResponses): Array<string | null> {
  return (q.skips ?? []).map((s) => s.sectionId)
}

export function isSkippedFor(q: QuestionWithResponses, sectionId: string | null): boolean {
  return skippedIds(q).includes(sectionId)
}

/** Skipped in every section the session has run in, so nothing about it counts. */
export function isFullySkipped(q: QuestionWithResponses, runs: SessionRun[]): boolean {
  const sections = runSections(runs)
  return sections.length > 0 && sections.every((s) => isSkippedFor(q, s.id))
}

/** The question with only the answers that count. Never write the result into the cache. */
export function countedQuestion(q: QuestionWithResponses, runs: SessionRun[]): QuestionWithResponses {
  const skipped = skippedIds(q)
  if (skipped.length === 0) return q
  const sectionOf = new Map(runs.map((r) => [r.id, r.sectionId]))
  return {
    ...q,
    responses: q.responses.filter((r) =>
      r.runId === null || !sectionOf.has(r.runId) || !skipped.includes(sectionOf.get(r.runId)!),
    ),
  }
}
