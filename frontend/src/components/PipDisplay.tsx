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
    <div className="p-4 bg-white min-h-screen">
      <div className="mb-3">
        <p className="text-xs text-gray-400 uppercase tracking-wide truncate mb-1">{sessionTitle}</p>
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs font-bold text-primary-700 bg-primary-100 px-2 py-0.5 rounded-full">
            Q{questionNumber}{totalQuestions > 1 ? ` of ${totalQuestions}` : ''}
          </span>
          <span className="text-xs text-gray-400">{total} response{total !== 1 ? 's' : ''}</span>
        </div>
        <p className="text-sm font-semibold text-gray-800 leading-snug">{question.text}</p>
      </div>

      <ResultsSummary question={question} />

      {total === 0 && (
        <p className="text-sm text-gray-400 text-center py-10">Waiting for responses…</p>
      )}
    </div>
  )
}
