import { useMutation } from '@tanstack/react-query'
import { Check } from 'lucide-react'
import type { ResponseWithStudent } from 'shared'
import SmilesRenderer from '@/components/SmilesRenderer'
import { calcResponseScore, cycleScore } from '@/lib/scoring'
import type { QWithGroup } from './types'

interface Props {
  q: QWithGroup
  isGradable: boolean
  gradeReasons: Record<string, string>
  overrideScoreMutation: ReturnType<typeof useMutation<unknown, unknown, { questionId: string; responseId: string; aiScore: number }>>
}

export default function ResponseList({ q, isGradable, gradeReasons, overrideScoreMutation }: Props) {
  if (q.responses.length === 0) {
    return <p className="text-sm text-gray-400 text-center py-6">No submissions yet</p>
  }
  return (
    <div className="space-y-2 mt-2">
      {q.responses.map((resp) => {
        const score = calcResponseScore(q, resp as ResponseWithStudent)
        return (
          <div key={resp.id} className="bg-gray-50 border border-gray-100 rounded-xl p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-xs text-gray-400 mb-1">
                  <span className="font-mono">{(resp as ResponseWithStudent).student?.netId}</span>
                </p>
                {(q.type as string) === 'STRUCTURE'
                  ? <SmilesRenderer smiles={resp.responseText} />
                  : <p className="text-sm text-gray-800 break-words">
                      {q.type === 'FREE_TEXT' ? resp.responseText : <span className="font-medium">{resp.responseText}</span>}
                    </p>
                }
                {gradeReasons[resp.id] && <p className="text-xs text-gray-400 mt-1 italic">{gradeReasons[resp.id]}</p>}
              </div>
              {score !== null && isGradable && (
                <button
                  onClick={() => overrideScoreMutation.mutate({ questionId: q.id, responseId: resp.id, aiScore: cycleScore(resp.aiScore) })}
                  title="Click to cycle score"
                  className={`shrink-0 flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-full border transition-colors ${
                    score === 1.0 ? 'bg-green-50 text-green-700 border-green-200 hover:bg-green-100'
                    : score === 0.5 ? 'bg-yellow-50 text-yellow-700 border-yellow-200 hover:bg-yellow-100'
                    : 'bg-red-50 text-red-600 border-red-200 hover:bg-red-100'
                  }`}
                >
                  {score === 1.0 && <Check size={11} />}
                  {score === 1.0 ? 'Full' : score === 0.5 ? 'Partial' : 'None'}
                </button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
