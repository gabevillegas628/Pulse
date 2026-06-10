import type { QuestionWithResponses } from 'shared'
import type { useMutation } from '@tanstack/react-query'

/** QuestionWithResponses enriched with the groupId field from the DB. */
export type QWithGroup = QuestionWithResponses & { groupId: string | null }

export type GradeResultItem = { id: string; studentId: string; aiScore: number; reason: string }

export type GradeMutationType = ReturnType<typeof useMutation<
  { grades: GradeResultItem[]; failedCount: number },
  unknown,
  { questionId: string; mode: 'all' | 'ungraded' }
>>
