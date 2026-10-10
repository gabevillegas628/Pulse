import { useMutation, useQueryClient } from '@tanstack/react-query'
import { SkipForward } from 'lucide-react'
import type { QuestionWithResponses, SessionDetail, SessionRun } from 'shared'
import { api } from '@/api/client'
import Button from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { isSkippedFor, runSections } from '@/lib/skips'

interface Props {
  sessionId: string
  question: QuestionWithResponses
  runs: SessionRun[]
}

/**
 * Skip this question: for the one cut for time while its QR code stayed in the deck.
 *
 * One button when the session has run in one section, which is most classes. One chip
 * per section once it has run in several, because a question skipped at 10am may still
 * be asked at 2pm. The live section's chip comes first, so mid-lecture it is still one
 * tap. Nothing shows before the first run: there is nothing yet to skip.
 */
export default function SkipControl({ sessionId, question, runs }: Props) {
  const qc = useQueryClient()
  const sections = runSections(runs)

  const toggle = useMutation({
    mutationFn: ({ sectionId, skipped }: { sectionId: string | null; skipped: boolean }) =>
      api.put(`/sessions/${sessionId}/questions/${question.id}/skip`, { sectionId, skipped })
        .then((r) => r.data.data.skips as Array<{ sectionId: string | null }>),
    onSuccess: (skips) => {
      qc.setQueryData<SessionDetail>(['session', sessionId], (prev) => prev && {
        ...prev,
        questions: prev.questions.map((q) => (q.id === question.id ? { ...q, skips } : q)),
      })
    },
  })

  if (sections.length === 0) return null

  if (sections.length === 1) {
    const sectionId = sections[0].id
    const skipped = isSkippedFor(question, sectionId)
    return (
      <>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => toggle.mutate({ sectionId, skipped: !skipped })}
          disabled={toggle.isPending}
          title={skipped
            ? 'Count this question again'
            : 'Not asking this one: refuse new answers, and keep any that came in out of grades and participation'}
        >
          <SkipForward size={12} /> {skipped ? 'Unskip' : 'Skip question'}
        </Button>
        {toggle.isError && <span className="text-xs text-red-500">Could not change that — try again.</span>}
      </>
    )
  }

  return (
    <span className="flex items-center gap-1.5 flex-wrap">
      <span className="text-xs text-muted inline-flex items-center gap-1">
        <SkipForward size={12} /> Skip for:
      </span>
      {sections.map((s) => {
        const skipped = isSkippedFor(question, s.id)
        return (
          <button
            key={s.id ?? 'all'}
            onClick={() => toggle.mutate({ sectionId: s.id, skipped: !skipped })}
            disabled={toggle.isPending}
            aria-pressed={skipped}
            className={cn(
              'text-xs px-2 py-1 rounded-sm border transition-colors disabled:opacity-50',
              skipped
                ? 'border-warn bg-warn-soft text-ink font-medium'
                : 'border-hairline-strong bg-surface text-ink-2 hover:bg-surface-2',
            )}
          >
            {s.name ? `Section ${s.name}` : 'All sections'}
            {s.isLive && ' · live'}
            {skipped && ' ✓'}
          </button>
        )
      })}
      {toggle.isError && <span className="text-xs text-red-500">Could not change that — try again.</span>}
    </span>
  )
}
