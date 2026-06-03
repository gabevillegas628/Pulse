import { useState, useRef } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Sparkles } from 'lucide-react'
import type { SummaryCategory } from 'shared'
import StructureRenderer from '@/components/StructureRenderer'
import type { QWithGroup } from './types'
import { Editor } from 'ketcher-react'
import { RemoteStructServiceProvider } from 'ketcher-core'
import type { Ketcher } from 'ketcher-core'

const structServiceProvider = new RemoteStructServiceProvider('/api/indigo')

interface Props {
  q: QWithGroup
  rubricDraft: Record<string, string>
  setRubricDraft: React.Dispatch<React.SetStateAction<Record<string, string>>>
  gradeMutation: ReturnType<typeof useMutation<{ id: string; studentId: string; aiScore: number; reason: string }[], unknown, string>>
  setCorrectAnswerMutation: ReturnType<typeof useMutation<unknown, unknown, { questionId: string; correctAnswer: string | null }>>
  summarizeMutation: ReturnType<typeof useMutation<SummaryCategory[], unknown, string>>
  summary: SummaryCategory[] | null
  summaryQuestionId: string | null
  setSummary: (s: SummaryCategory[] | null) => void
  setSummaryQuestionId: (id: string | null) => void
}

export default function GradingControls({
  q, rubricDraft, setRubricDraft, gradeMutation, setCorrectAnswerMutation,
  summarizeMutation, summary, summaryQuestionId, setSummary, setSummaryQuestionId,
}: Props) {
  const [editingStructure, setEditingStructure] = useState(false)
  const ketcherRef = useRef<Ketcher | null>(null)
  const initialStruct = useRef('')

  return (
    <div className="flex items-center gap-3 flex-wrap py-2 border-t border-gray-100">
      {(q.type === 'MULTIPLE_CHOICE' || q.type === 'YES_NO') && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">Correct answer:</span>
          <select
            value={q.correctAnswer ?? ''}
            onChange={(e) => setCorrectAnswerMutation.mutate({ questionId: q.id, correctAnswer: e.target.value || null })}
            className="text-xs border border-gray-200 rounded px-2 py-1 bg-white text-gray-700 focus:outline-none focus:ring-1 focus:ring-primary-500"
          >
            <option value="">— none set</option>
            {q.type === 'YES_NO' ? (
              <><option value="Yes">Yes</option><option value="No">No</option></>
            ) : (
              (q.options as string[] ?? []).map((opt) => <option key={opt} value={opt}>{opt}</option>)
            )}
          </select>
        </div>
      )}
      {(q.type as string) === 'NUMERIC' && (
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <span>Answer:</span>
          <span className="font-mono text-gray-800">{q.correctAnswer ?? '—'}</span>
          {q.tolerance != null && <span>± {q.tolerance}</span>}
          {q.unit && <span className="text-gray-400">{q.unit}</span>}
        </div>
      )}
      {(q.type as string) === 'MULTI_SELECT' && Array.isArray(q.options) && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-gray-500">Correct answers (check all that apply):</span>
          <div className="flex flex-wrap gap-3">
            {(q.options as string[]).map((opt) => {
              let current: string[] = []
              try { current = q.correctAnswer ? JSON.parse(q.correctAnswer) : [] } catch { /* ignore */ }
              const isChecked = current.includes(opt)
              return (
                <label key={opt} className="flex items-center gap-1.5 text-xs cursor-pointer">
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => {
                      const next = isChecked ? current.filter(v => v !== opt) : [...current, opt]
                      setCorrectAnswerMutation.mutate({ questionId: q.id, correctAnswer: next.length ? JSON.stringify(next) : null })
                    }}
                    className="text-primary-600"
                  />
                  {opt}
                </label>
              )
            })}
          </div>
        </div>
      )}
      {(q.type as string) === 'STRUCTURE' && (
        <div className="w-full pt-1">
          {editingStructure ? (
            <div className="space-y-2">
              <div className="h-[500px] border border-gray-200 rounded-xl overflow-hidden">
                <Editor
                  staticResourcesUrl=""
                  structServiceProvider={structServiceProvider}
                  errorHandler={(err) => console.error('Ketcher error:', err)}
                  onInit={async (ketcher) => {
                    ketcherRef.current = ketcher
                    if (initialStruct.current) {
                      await ketcher.setMolecule(initialStruct.current)
                    }
                  }}
                />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={async () => {
                    const molfile = ketcherRef.current ? await ketcherRef.current.getMolfile() : ''
                    setCorrectAnswerMutation.mutate({ questionId: q.id, correctAnswer: molfile || null })
                    setEditingStructure(false)
                  }}
                  disabled={setCorrectAnswerMutation.isPending}
                  className="text-xs text-white bg-primary-600 hover:bg-primary-700 px-3 py-1.5 rounded-lg disabled:opacity-50"
                >Save</button>
                <button onClick={() => setEditingStructure(false)} className="text-xs text-gray-500 px-2 py-1.5">Cancel</button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              {q.correctAnswer ? (
                <>
                  <StructureRenderer inchi={q.correctAnswer ?? ''} width={180} height={120} />
                  <div className="flex flex-col gap-1.5">
                    <button
                      onClick={() => { initialStruct.current = q.correctAnswer ?? ''; setEditingStructure(true) }}
                      className="text-xs text-primary-600 hover:text-primary-800 border border-primary-200 px-2.5 py-1 rounded"
                    >Change</button>
                    <button
                      onClick={() => setCorrectAnswerMutation.mutate({ questionId: q.id, correctAnswer: null })}
                      disabled={setCorrectAnswerMutation.isPending}
                      className="text-xs text-gray-500 hover:text-red-600 border border-gray-200 px-2.5 py-1 rounded disabled:opacity-50"
                    >Clear</button>
                  </div>
                </>
              ) : (
                <button
                  onClick={() => { initialStruct.current = ''; setEditingStructure(true) }}
                  className="text-xs text-primary-600 hover:text-primary-800 border border-primary-200 px-2.5 py-1.5 rounded"
                >Set correct structure…</button>
              )}
            </div>
          )}
        </div>
      )}
      {(q.type as string) === 'ORDERING' && q.correctAnswer && (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-gray-500">Correct order:</span>
          <ol className="text-xs text-gray-700 list-decimal list-inside space-y-0.5">
            {(() => { try { return (JSON.parse(q.correctAnswer) as string[]).map((item, i) => <li key={i}>{item}</li>) } catch { return null } })()}
          </ol>
        </div>
      )}
      {q.type === 'FREE_TEXT' && (
        <>
          <input
            value={rubricDraft[q.id] ?? q.correctAnswer ?? ''}
            onChange={(e) => setRubricDraft((prev) => ({ ...prev, [q.id]: e.target.value }))}
            onBlur={() => {
              const val = rubricDraft[q.id]
              if (val !== undefined)
                setCorrectAnswerMutation.mutate({ questionId: q.id, correctAnswer: val || null })
            }}
            placeholder="Reference answer (optional, used by AI grader)"
            className="text-xs border border-gray-200 rounded px-2.5 py-1.5 text-gray-700 focus:outline-none focus:ring-1 focus:ring-primary-500 w-56"
          />
          <button
            onClick={() => gradeMutation.mutate(q.id)}
            disabled={gradeMutation.isPending || q.responses.length === 0}
            className="flex items-center gap-1.5 text-xs text-white bg-primary-600 hover:bg-primary-700 px-3 py-1.5 rounded-lg disabled:opacity-50"
          >
            <Sparkles size={12} />
            {gradeMutation.isPending ? 'Grading…' : 'AI grade all'}
          </button>
        </>
      )}
      {q.type === 'FREE_TEXT' && q.responses.length > 0 && (
        summarizeMutation.isPending && summaryQuestionId === q.id ? (
          <span className="text-xs text-gray-400">Summarizing…</span>
        ) : (
          <button
            onClick={() => {
              if (summaryQuestionId === q.id) { setSummary(null); setSummaryQuestionId(null) }
              else summarizeMutation.mutate(q.id)
            }}
            className="text-xs text-gray-500 hover:text-gray-700 underline underline-offset-2"
          >
            {summaryQuestionId === q.id ? 'Hide summary' : 'Summarize responses'}
          </button>
        )
      )}
      {summary && summaryQuestionId === q.id && (
        <div className="w-full grid grid-cols-1 sm:grid-cols-2 gap-3 mt-1">
          {summary.map((cat) => (
            <div key={cat.label} className="bg-blue-50 border border-blue-100 rounded-xl p-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-blue-900">{cat.label}</span>
                <span className="text-xs text-blue-500">{cat.count} student{cat.count !== 1 ? 's' : ''}</span>
              </div>
              <p className="text-xs text-blue-700">{cat.description}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
