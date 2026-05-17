import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/api/client'
import StudentLayout from '@/components/layout/StudentLayout'
import RichTextRenderer from '@/components/RichTextRenderer'
import { ChevronLeft, Clock, Check } from 'lucide-react'

interface AssignmentQuestion {
  id: string
  text: string
  type: string
  options: string[] | null
  order: number
  existingResponse: { id: string; responseText: string; submittedAt: string } | null
}

interface AssignmentData {
  id: string
  title: string
  deadline: string | null
  isPastDue: boolean
  class: { id: string; name: string }
  questions: AssignmentQuestion[]
}

export default function AssignmentPage() {
  const { assignmentId } = useParams<{ assignmentId: string }>()
  const qc = useQueryClient()
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [submitted, setSubmitted] = useState<Record<string, boolean>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})

  const { data, isLoading } = useQuery<AssignmentData>({
    queryKey: ['student-assignment', assignmentId],
    queryFn: () => api.get(`/student/assignments/${assignmentId}`).then((r) => r.data.data.assignment),
  })

  useEffect(() => {
    if (!data) return
    const pre: Record<string, string> = {}
    const done: Record<string, boolean> = {}
    data.questions.forEach((q) => {
      if (q.existingResponse) {
        pre[q.id] = q.existingResponse.responseText
        done[q.id] = true
      }
    })
    setAnswers((prev) => ({ ...pre, ...prev }))
    setSubmitted((prev) => ({ ...done, ...prev }))
  }, [data])

  const submitMutation = useMutation({
    mutationFn: ({ questionId, responseText }: { questionId: string; responseText: string }) =>
      api.post('/responses', { questionId, responseText }),
    onSuccess: (_data, { questionId }) => {
      setSubmitted((prev) => ({ ...prev, [questionId]: true }))
      setErrors((prev) => ({ ...prev, [questionId]: '' }))
      qc.invalidateQueries({ queryKey: ['student-assignment', assignmentId] })
      qc.invalidateQueries({ queryKey: ['student-assignments'] })
    },
    onError: (err: unknown, { questionId }) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      setErrors((prev) => ({ ...prev, [questionId]: msg ?? 'Submission failed — try again' }))
    },
  })

  function handleSubmitQuestion(q: AssignmentQuestion) {
    const text = (answers[q.id] ?? '').trim()
    if (!text) {
      setErrors((prev) => ({ ...prev, [q.id]: 'Please enter an answer' }))
      return
    }
    submitMutation.mutate({ questionId: q.id, responseText: text })
  }

  if (isLoading || !data) {
    return <StudentLayout><p className="text-gray-400 text-center py-12">Loading…</p></StudentLayout>
  }

  const allDone = data.questions.every((q) => submitted[q.id] || !!q.existingResponse)

  return (
    <StudentLayout>
      <div className="mb-6">
        <Link to="/student/classes" className="flex items-center gap-1 text-sm text-gray-400 hover:text-gray-600 mb-3">
          <ChevronLeft size={16} /> {data.class.name}
        </Link>
        <div className="flex items-start justify-between gap-3">
          <h1 className="text-xl font-bold text-gray-900">{data.title}</h1>
          {data.deadline && (
            <span className={`flex items-center gap-1 text-xs shrink-0 mt-1 ${data.isPastDue ? 'text-red-500' : 'text-gray-400'}`}>
              <Clock size={12} />
              {data.isPastDue ? 'Past due' : `Due ${new Date(data.deadline).toLocaleString()}`}
            </span>
          )}
        </div>
      </div>

      {data.isPastDue && !allDone && (
        <div className="mb-5 bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700">
          This assignment is past due. No further submissions are accepted.
        </div>
      )}

      {allDone && (
        <div className="mb-5 bg-green-50 border border-green-200 rounded-xl px-4 py-3 text-sm text-green-700 flex items-center gap-2">
          <Check size={16} /> All questions submitted.
        </div>
      )}

      <div className="space-y-6">
        {data.questions.map((q, i) => {
          const isDone = submitted[q.id] || !!q.existingResponse
          const isDisabled = isDone || data.isPastDue || submitMutation.isPending

          return (
            <div key={q.id} className={`bg-white border rounded-2xl p-5 ${isDone ? 'border-green-200' : 'border-gray-200'}`}>
              <div className="flex items-start justify-between gap-3 mb-3">
                <p className="text-xs font-medium text-gray-400 uppercase tracking-wide">Question {i + 1}</p>
                {isDone && (
                  <span className="flex items-center gap-1 text-xs text-green-600 font-medium shrink-0">
                    <Check size={12} /> Submitted
                  </span>
                )}
              </div>

              <div className="mb-4">
                <RichTextRenderer content={q.text} />
              </div>

              {/* Answer input */}
              {q.type === 'FREE_TEXT' && (
                <textarea
                  rows={4}
                  value={answers[q.id] ?? ''}
                  onChange={(e) => setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
                  disabled={isDisabled}
                  placeholder={isDone ? '' : 'Your answer…'}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none disabled:bg-gray-50 disabled:text-gray-500"
                />
              )}

              {q.type === 'MULTIPLE_CHOICE' && q.options && (
                <div className="space-y-2">
                  {q.options.map((opt) => (
                    <label key={opt} className={`flex items-center gap-3 p-3 border rounded-xl cursor-pointer transition-colors ${
                      answers[q.id] === opt
                        ? 'border-primary-500 bg-primary-50'
                        : 'border-gray-200 hover:border-gray-300'
                    } ${isDisabled ? 'opacity-60 cursor-not-allowed' : ''}`}>
                      <input
                        type="radio"
                        name={`q-${q.id}`}
                        value={opt}
                        checked={answers[q.id] === opt}
                        onChange={() => !isDisabled && setAnswers((prev) => ({ ...prev, [q.id]: opt }))}
                        disabled={isDisabled}
                        className="text-primary-600"
                      />
                      <span className="text-sm text-gray-800">{opt}</span>
                    </label>
                  ))}
                </div>
              )}

              {q.type === 'YES_NO' && (
                <div className="flex gap-3">
                  {['Yes', 'No'].map((opt) => (
                    <label key={opt} className={`flex items-center gap-2 px-4 py-2.5 border rounded-xl cursor-pointer transition-colors ${
                      answers[q.id] === opt
                        ? 'border-primary-500 bg-primary-50 text-primary-700'
                        : 'border-gray-200 text-gray-700 hover:border-gray-300'
                    } ${isDisabled ? 'opacity-60 cursor-not-allowed' : ''}`}>
                      <input
                        type="radio"
                        name={`q-${q.id}`}
                        value={opt}
                        checked={answers[q.id] === opt}
                        onChange={() => !isDisabled && setAnswers((prev) => ({ ...prev, [q.id]: opt }))}
                        disabled={isDisabled}
                        className="sr-only"
                      />
                      <span className="text-sm font-medium">{opt}</span>
                    </label>
                  ))}
                </div>
              )}

              {q.type === 'RATING' && (
                <div className="flex gap-2">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button
                      key={n}
                      type="button"
                      disabled={isDisabled}
                      onClick={() => !isDisabled && setAnswers((prev) => ({ ...prev, [q.id]: String(n) }))}
                      className={`w-10 h-10 rounded-xl text-sm font-medium border transition-colors ${
                        answers[q.id] === String(n)
                          ? 'border-primary-500 bg-primary-50 text-primary-700'
                          : 'border-gray-200 text-gray-600 hover:border-gray-300'
                      } disabled:opacity-60 disabled:cursor-not-allowed`}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              )}

              {errors[q.id] && <p className="text-red-500 text-xs mt-2">{errors[q.id]}</p>}

              {!isDone && !data.isPastDue && (
                <button
                  onClick={() => handleSubmitQuestion(q)}
                  disabled={submitMutation.isPending || !answers[q.id]}
                  className="mt-4 px-5 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50"
                >
                  {submitMutation.isPending ? 'Submitting…' : 'Submit'}
                </button>
              )}
            </div>
          )
        })}
      </div>
    </StudentLayout>
  )
}
