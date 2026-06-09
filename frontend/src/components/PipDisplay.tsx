import type { QuestionWithResponses } from 'shared'
import ResultsSummary from './ResultsSummary'

interface Props {
  question: QuestionWithResponses
  questionNumber: number
  totalQuestions: number
  sessionTitle: string
}

export default function PipDisplay({ question, questionNumber, totalQuestions, sessionTitle }: Props) {
  const total = question.responses.length

  return (
    <div className="p-4 bg-surface min-h-screen">
      <div className="mb-3">
        <p className="text-xs text-muted uppercase tracking-wide truncate mb-1">{sessionTitle}</p>
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs font-bold text-signal bg-signal-soft px-2 py-0.5 rounded-full">
            Q{questionNumber}{totalQuestions > 1 ? ` of ${totalQuestions}` : ''}
          </span>
          <span className="text-xs text-muted font-mono">{total} response{total !== 1 ? 's' : ''}</span>
        </div>
        <p className="text-sm font-semibold text-ink leading-snug">{question.text}</p>
      </div>

      <ResultsSummary question={question} />

      {total === 0 && (
        <p className="text-sm text-muted text-center py-10">Waiting for responses…</p>
      )}
    </div>
  )
}
