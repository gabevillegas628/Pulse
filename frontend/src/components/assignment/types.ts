import type { QuestionWithResponses } from 'shared'

/** QuestionWithResponses enriched with the groupId field from the DB. */
export type QWithGroup = QuestionWithResponses & { groupId: string | null }
