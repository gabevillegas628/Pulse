import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/api/client'
import ProfessorLayout from '@/components/layout/ProfessorLayout'
import RichTextRenderer from '@/components/RichTextRenderer'
import { ChevronLeft, Download, Plus, Sparkles, Check } from 'lucide-react'
import type { SessionDetail, QuestionWithResponses, ResponseWithStudent } from 'shared'
import { SessionStatus } from 'shared'

interface SummaryCategory {
  label: string
  description: string
  count: number
}

function calcResponseScore(
  q: { type: string; correctAnswer: string | null },
  r: { responseText: string; aiScore: number | null }
): number | null {
  if (q.type === 'MULTIPLE_CHOICE' || q.type === 'YES_NO') {
    if (!q.correctAnswer) return null
    return r.responseText === q.correctAnswer ? 1.0 : 0.5
  }
  if (q.type === 'FREE_TEXT') return r.aiScore
  return null
}

function cycleScore(current: number | null): number {
  if (current === null || current === 1.0) return 0
  if (current === 0) return 0.5
  return 1.0
}

export default function AssignmentDetailPage() {
  const { assignmentId } = useParams<{ assignmentId: string }>()
  const qc = useQueryClient()
  const [activeTab, setActiveTab] = useState(0)
  const [summary, setSummary] = useState<SummaryCategory[] | null>(null)
  const [summaryQuestionId, setSummaryQuestionId] = useState<string | null>(null)
  const [gradeReasons, setGradeReasons] = useState<Record<string, string>>({})
  const [rubricDraft, setRubricDraft] = useState<Record<string, string>>({})
  const [showAddQuestion, setShowAddQuestion] = useState(false)
  const [aqText, setAqText] = useState('')
  const [aqType, setAqType] = useState<'FREE_TEXT' | 'MULTIPLE_CHOICE' | 'RATING' | 'YES_NO'>('FREE_TEXT')
  const [aqOptions, setAqOptions] = useState('')
  const [aqError, setAqError] = useState('')

  const { data, isLoading } = useQuery<SessionDetail>({
    queryKey: ['assignment', assignmentId],
    queryFn: () => api.get(`/sessions/${assignmentId}`).then((r) => r.data.data.session),
  })

  const statusMutation = useMutation({
    mutationFn: (status: SessionStatus) => api.patch(`/sessions/${assignmentId}`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assignment', assignmentId] }),
  })

  const gradeMutation = useMutation({
    mutationFn: (questionId: string) =>
      api.post(`/sessions/${assignmentId}/questions/${questionId}/grade`)
        .then((r) => r.data.data.grades as { id: string; studentId: string; aiScore: number; reason: string }[]),
    onSuccess: (grades, questionId) => {
      const reasons: Record<string, string> = {}
      grades.forEach((g) => { reasons[g.id] = g.reason })
      setGradeReasons((prev) => ({ ...prev, ...reasons }))
      qc.setQueryData<SessionDetail>(['assignment', assignmentId], (prev) => {
        if (!prev) return prev
        return {
          ...prev,
          questions: prev.questions.map((q) => {
            if (q.id !== questionId) return q
            return {
              ...q,
              responses: q.responses.map((r) => {
                const g = grades.find((g) => g.id === r.id)
                return g ? { ...r, aiScore: g.aiScore } : r
              }),
            }
          }),
        }
      })
    },
  })

  const setCorrectAnswerMutation = useMutation({
    mutationFn: ({ questionId, correctAnswer }: { questionId: string; correctAnswer: string | null }) =>
      api.patch(`/sessions/${assignmentId}/questions/${questionId}`, { correctAnswer }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assignment', assignmentId] }),
  })

  const overrideScoreMutation = useMutation({
    mutationFn: ({ questionId, responseId, aiScore }: { questionId: string; responseId: string; aiScore: number }) =>
      api.patch(`/sessions/${assignmentId}/questions/${questionId}/responses/${responseId}`, { aiScore }),
    onSuccess: (_data, { questionId, responseId, aiScore }) => {
      qc.setQueryData<SessionDetail>(['assignment', assignmentId], (prev) => {
        if (!prev) return prev
        return {
          ...prev,
          questions: prev.questions.map((q) => {
            if (q.id !== questionId) return q
            return { ...q, responses: q.responses.map((r) => r.id === responseId ? { ...r, aiScore } : r) }
          }),
        }
      })
    },
  })

  const summarizeMutation = useMutation({
    mutationFn: (questionId: string) =>
      api.post(`/sessions/${assignmentId}/questions/${questionId}/summarize`).then((r) => r.data.data.categories),
    onSuccess: (categories: SummaryCategory[], questionId: string) => {
      setSummary(categories)
      setSummaryQuestionId(questionId)
    },
  })

  const addQuestionMutation = useMutation({
    mutationFn: () => api.post(`/sessions/${assignmentId}/questions`, {
      text: aqText,
      type: aqType,
      options: aqType === 'MULTIPLE_CHOICE' ? aqOptions.split('\n').map(s => s.trim()).filter(Boolean) : undefined,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['assignment', assignmentId] })
      setShowAddQuestion(false)
      setAqText(''); setAqType('FREE_TEXT'); setAqOptions(''); setAqError('')
    },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error
      setAqError(msg ?? 'Failed to add question')
    },
  })

  if (isLoading || !data) return <ProfessorLayout><p className="text-gray-400">Loading…</p></ProfessorLayout>

  const deadline = (data as unknown as { deadline: string | null }).deadline
  const totalResponses = data.questions.reduce((sum, q) => sum + q.responses.length, 0)
  const activeQuestion = data.questions[activeTab] as QuestionWithResponses | undefined

  return (
    <ProfessorLayout>
      {/* Header */}
      <div className="mb-6">
        <Link to={`/professor/classes/${data.class.id}`} className="flex items-center gap-1 text-sm text-gray-400 hover:text-gray-600 mb-3">
          <ChevronLeft size={16} /> {data.class.name}
        </Link>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{data.title}</h1>
            <p className="text-sm text-gray-500 mt-1">
              {totalResponses} submission{totalResponses !== 1 ? 's' : ''}
              {deadline && (
                <span className={`ml-2 ${new Date(deadline) < new Date() ? 'text-red-500' : 'text-gray-400'}`}>
                  · Due {new Date(deadline).toLocaleString()}
                </span>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <a
              href={`/api/sessions/${assignmentId}/export`}
              className="flex items-center gap-1.5 border border-gray-200 text-gray-600 px-3 py-2 rounded-lg text-sm hover:bg-gray-50"
            >
              <Download size={14} /> Export CSV
            </a>
            {data.status === SessionStatus.DRAFT ? (
              <button
                onClick={() => statusMutation.mutate(SessionStatus.OPEN)}
                disabled={statusMutation.isPending}
                className="bg-primary-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50"
              >
                Publish
              </button>
            ) : data.status === SessionStatus.OPEN ? (
              <button
                onClick={() => statusMutation.mutate(SessionStatus.CLOSED)}
                disabled={statusMutation.isPending}
                className="bg-red-50 text-red-600 border border-red-200 px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-100 disabled:opacity-50"
              >
                Close
              </button>
            ) : data.status === SessionStatus.CLOSED ? (
              <div className="flex gap-2">
                <button
                  onClick={() => statusMutation.mutate(SessionStatus.OPEN)}
                  disabled={statusMutation.isPending}
                  className="bg-green-50 text-green-700 border border-green-200 px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-100 disabled:opacity-50"
                >
                  Reopen
                </button>
                <button
                  onClick={() => statusMutation.mutate(SessionStatus.ARCHIVED)}
                  disabled={statusMutation.isPending}
                  className="text-gray-400 border border-gray-200 px-4 py-2 rounded-lg text-sm hover:bg-gray-50 disabled:opacity-50"
                >
                  Archive
                </button>
              </div>
            ) : (
              <span className="text-xs text-gray-400 border border-gray-200 px-3 py-2 rounded-lg">Archived</span>
            )}
          </div>
        </div>
      </div>

      {/* Question tabs */}
      <div className="flex items-center gap-1 mb-6 border-b border-gray-200">
        {data.questions.map((q, i) => (
          <button
            key={q.id}
            onClick={() => { setActiveTab(i); setSummary(null); setSummaryQuestionId(null) }}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === i
                ? 'border-primary-600 text-primary-700'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            Q{i + 1}
            <span className="ml-1.5 text-xs text-gray-400">{q.responses.length}</span>
          </button>
        ))}
        {data.status === SessionStatus.DRAFT && (
          <button
            onClick={() => setShowAddQuestion(true)}
            className="ml-auto flex items-center gap-1 text-xs text-primary-600 hover:text-primary-800 px-3 py-2"
          >
            <Plus size={13} /> Add question
          </button>
        )}
      </div>

      {/* Add question panel */}
      {showAddQuestion && (
        <div className="mb-6 border border-gray-200 rounded-xl p-5 bg-gray-50 space-y-3">
          <h3 className="text-sm font-medium text-gray-700">New question</h3>
          <textarea
            value={aqText}
            onChange={(e) => setAqText(e.target.value)}
            placeholder="Question text…"
            rows={2}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none"
          />
          <div className="flex items-center gap-3">
            <select
              value={aqType}
              onChange={(e) => setAqType(e.target.value as typeof aqType)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary-500"
            >
              <option value="FREE_TEXT">Free text</option>
              <option value="MULTIPLE_CHOICE">Multiple choice</option>
              <option value="RATING">Rating (1–5)</option>
              <option value="YES_NO">Yes / No</option>
            </select>
            <div className="ml-auto flex gap-2">
              <button onClick={() => { setShowAddQuestion(false); setAqError('') }} className="text-sm text-gray-500 px-3 py-2">Cancel</button>
              <button
                onClick={() => { setAqError(''); addQuestionMutation.mutate() }}
                disabled={!aqText.trim() || addQuestionMutation.isPending}
                className="text-sm bg-primary-600 text-white px-4 py-2 rounded-lg hover:bg-primary-700 disabled:opacity-50"
              >
                Add
              </button>
            </div>
          </div>
          {aqType === 'MULTIPLE_CHOICE' && (
            <textarea
              value={aqOptions}
              onChange={(e) => setAqOptions(e.target.value)}
              placeholder={"Option A\nOption B\nOption C"}
              rows={3}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none"
            />
          )}
          {aqError && <p className="text-red-500 text-xs">{aqError}</p>}
        </div>
      )}

      {/* Active question detail */}
      {activeQuestion && (
        <div className="space-y-5">
          {/* Question text */}
          <div className="bg-white border border-gray-200 rounded-xl p-5">
            <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-2">
              Question {activeTab + 1} · {activeQuestion.type.replace('_', ' ').toLowerCase()}
            </p>
            <RichTextRenderer content={activeQuestion.text} />
            {activeQuestion.type === 'MULTIPLE_CHOICE' && Array.isArray(activeQuestion.options) && (
              <div className="flex flex-wrap gap-2 mt-3">
                {(activeQuestion.options as string[]).map((opt) => (
                  <span key={opt} className="text-xs bg-gray-100 px-2.5 py-1 rounded-full text-gray-600">{opt}</span>
                ))}
              </div>
            )}
          </div>

          {/* Grading controls (only when closed) */}
          {(data.status === SessionStatus.CLOSED || data.status === SessionStatus.ARCHIVED) && (
            <div className="flex items-center gap-3 flex-wrap">
              {(activeQuestion.type === 'MULTIPLE_CHOICE' || activeQuestion.type === 'YES_NO') && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500">Correct answer:</span>
                  <select
                    value={activeQuestion.correctAnswer ?? ''}
                    onChange={(e) =>
                      setCorrectAnswerMutation.mutate({
                        questionId: activeQuestion.id,
                        correctAnswer: e.target.value || null,
                      })
                    }
                    className="text-xs border border-gray-200 rounded px-2 py-1 bg-white text-gray-700 focus:outline-none focus:ring-1 focus:ring-primary-500"
                  >
                    <option value="">— none set</option>
                    {activeQuestion.type === 'YES_NO' ? (
                      <>
                        <option value="Yes">Yes</option>
                        <option value="No">No</option>
                      </>
                    ) : (
                      (activeQuestion.options as string[] ?? []).map((opt) => (
                        <option key={opt} value={opt}>{opt}</option>
                      ))
                    )}
                  </select>
                </div>
              )}
              {activeQuestion.type === 'FREE_TEXT' && (
                <>
                  <input
                    value={rubricDraft[activeQuestion.id] ?? activeQuestion.correctAnswer ?? ''}
                    onChange={(e) => setRubricDraft((prev) => ({ ...prev, [activeQuestion.id]: e.target.value }))}
                    onBlur={() => {
                      const val = rubricDraft[activeQuestion.id]
                      if (val !== undefined)
                        setCorrectAnswerMutation.mutate({ questionId: activeQuestion.id, correctAnswer: val || null })
                    }}
                    placeholder="Reference answer (optional, used by AI grader)"
                    className="text-xs border border-gray-200 rounded px-2.5 py-1.5 text-gray-700 focus:outline-none focus:ring-1 focus:ring-primary-500 w-64"
                  />
                  <button
                    onClick={() => gradeMutation.mutate(activeQuestion.id)}
                    disabled={gradeMutation.isPending || activeQuestion.responses.length === 0}
                    className="flex items-center gap-1.5 text-xs text-white bg-primary-600 hover:bg-primary-700 px-3 py-1.5 rounded-lg disabled:opacity-50"
                  >
                    <Sparkles size={13} />
                    {gradeMutation.isPending ? 'Grading…' : 'AI grade all'}
                  </button>
                </>
              )}
              {summarizeMutation.isPending ? (
                <span className="text-xs text-gray-400">Summarizing…</span>
              ) : (
                activeQuestion.type === 'FREE_TEXT' && activeQuestion.responses.length > 0 && (
                  <button
                    onClick={() => {
                      if (summaryQuestionId === activeQuestion.id) {
                        setSummary(null); setSummaryQuestionId(null)
                      } else {
                        summarizeMutation.mutate(activeQuestion.id)
                      }
                    }}
                    className="text-xs text-gray-500 hover:text-gray-700 underline underline-offset-2"
                  >
                    {summaryQuestionId === activeQuestion.id ? 'Hide summary' : 'Summarize responses'}
                  </button>
                )
              )}
            </div>
          )}

          {/* Summary */}
          {summary && summaryQuestionId === activeQuestion.id && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {summary.map((cat) => (
                <div key={cat.label} className="bg-blue-50 border border-blue-100 rounded-xl p-4">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-semibold text-blue-900">{cat.label}</span>
                    <span className="text-xs text-blue-500">{cat.count} student{cat.count !== 1 ? 's' : ''}</span>
                  </div>
                  <p className="text-xs text-blue-700">{cat.description}</p>
                </div>
              ))}
            </div>
          )}

          {/* Responses */}
          <div className="space-y-3">
            {activeQuestion.responses.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-8">No submissions yet</p>
            ) : (
              activeQuestion.responses.map((resp) => {
                const score = calcResponseScore(activeQuestion, resp as ResponseWithStudent)
                return (
                  <div key={resp.id} className="bg-white border border-gray-200 rounded-xl p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-gray-400 mb-1">
                          {(resp as ResponseWithStudent).student?.name} ·{' '}
                          <span className="font-mono">{(resp as ResponseWithStudent).student?.netId}</span>
                        </p>
                        <p className="text-sm text-gray-800 break-words">
                          {activeQuestion.type === 'FREE_TEXT'
                            ? resp.responseText
                            : <span className="font-medium">{resp.responseText}</span>
                          }
                        </p>
                        {gradeReasons[resp.id] && (
                          <p className="text-xs text-gray-400 mt-1 italic">{gradeReasons[resp.id]}</p>
                        )}
                      </div>
                      {score !== null && (data.status === SessionStatus.CLOSED || data.status === SessionStatus.ARCHIVED) && (
                        <button
                          onClick={() => overrideScoreMutation.mutate({
                            questionId: activeQuestion.id,
                            responseId: resp.id,
                            aiScore: cycleScore(resp.aiScore),
                          })}
                          title="Click to cycle score"
                          className={`shrink-0 flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-full border transition-colors ${
                            score === 1.0
                              ? 'bg-green-50 text-green-700 border-green-200 hover:bg-green-100'
                              : score === 0.5
                              ? 'bg-yellow-50 text-yellow-700 border-yellow-200 hover:bg-yellow-100'
                              : 'bg-red-50 text-red-600 border-red-200 hover:bg-red-100'
                          }`}
                        >
                          {score === 1.0 ? <Check size={11} /> : null}
                          {score === 1.0 ? 'Full' : score === 0.5 ? 'Partial' : 'None'}
                        </button>
                      )}
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>
      )}
    </ProfessorLayout>
  )
}
