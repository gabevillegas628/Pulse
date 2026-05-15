import { useEffect, useState } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { useForm, Controller } from 'react-hook-form'
import { api } from '@/api/client'
import { useStudentAuth } from '@/context/StudentAuthContext'
import StudentLayout from '@/components/layout/StudentLayout'
import { io } from 'socket.io-client'
import type { StudentQuestion } from 'shared'

export default function QuestionPage() {
  const { questionId } = useParams<{ questionId: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const { isAuthenticated, isLoading: authLoading } = useStudentAuth()

  const [question, setQuestion] = useState<StudentQuestion | null>(null)
  const [loadError, setLoadError] = useState('')
  const [submitError, setSubmitError] = useState('')
  const [sessionClosed, setSessionClosed] = useState(false)

  const { control, handleSubmit, register, formState: { isSubmitting } } = useForm<{ response: string }>()

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      navigate(`/student/login?next=${location.pathname}`, { replace: true })
    }
  }, [authLoading, isAuthenticated, navigate, location.pathname])

  useEffect(() => {
    if (!isAuthenticated || !questionId) return
    api.get(`/student/questions/${questionId}`)
      .then((r) => {
        const q: StudentQuestion = r.data.data.question
        setQuestion(q)
        if (q.session.status !== 'OPEN') setSessionClosed(true)
      })
      .catch((e) => {
        const msg = e?.response?.data?.error
        setLoadError(msg ?? 'Question not found')
      })
  }, [isAuthenticated, questionId])

  useEffect(() => {
    if (!question) return
    const socket = io({ path: '/socket.io' })
    socket.emit('join_session', question.session.id)
    socket.on('session_status', ({ status }: { status: string }) => {
      if (status !== 'OPEN') setSessionClosed(true)
    })
    return () => { socket.disconnect() }
  }, [question])

  async function onSubmit(data: { response: string }) {
    if (!question) return
    setSubmitError('')
    try {
      await api.post('/responses', { questionId: question.id, responseText: data.response ?? '' })
      navigate(`/q/${question.id}/confirmation`)
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error
      setSubmitError(msg ?? 'Submission failed — please try again')
    }
  }

  if (authLoading || (!question && !loadError)) {
    return <StudentLayout><div className="text-center py-16 text-gray-400">Loading…</div></StudentLayout>
  }

  if (loadError) {
    return (
      <StudentLayout>
        <div className="bg-white rounded-2xl border border-gray-200 p-8 text-center">
          <p className="text-gray-500">{loadError}</p>
        </div>
      </StudentLayout>
    )
  }

  if (sessionClosed) {
    return (
      <StudentLayout>
        <div className="bg-white rounded-2xl border border-gray-200 p-8 text-center">
          <p className="text-xl font-semibold text-gray-700 mb-2">Session closed</p>
          <p className="text-gray-400 text-sm">This session is no longer accepting responses.</p>
        </div>
      </StudentLayout>
    )
  }

  if (question!.alreadyAnswered) {
    return (
      <StudentLayout>
        <div className="bg-white rounded-2xl border border-gray-200 p-8 text-center">
          <p className="text-xl font-semibold text-gray-700 mb-2">Already submitted</p>
          <p className="text-gray-400 text-sm">You've already answered this question.</p>
        </div>
      </StudentLayout>
    )
  }

  const q = question!

  return (
    <StudentLayout>
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
        <div className="bg-primary-600 px-6 py-4">
          <p className="text-primary-100 text-xs font-medium uppercase tracking-wide">{q.session.class.name}</p>
          <h1 className="text-white text-base font-semibold mt-0.5">{q.session.title}</h1>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="p-6 space-y-6">
          <div>
            {q.type === 'FREE_TEXT' && (
              <textarea
                {...register('response')}
                rows={4}
                placeholder="Write your response…"
                className="w-full border border-gray-300 rounded-lg px-3 py-3 text-base focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none"
              />
            )}

            {q.type === 'MULTIPLE_CHOICE' && q.options && (
              <Controller
                name="response"
                control={control}
                render={({ field }) => (
                  <div className="space-y-2">
                    {q.options!.map((opt) => (
                      <label key={opt} className="flex items-center gap-3 p-3 border border-gray-200 rounded-lg cursor-pointer hover:bg-gray-50">
                        <input
                          type="radio"
                          value={opt}
                          checked={field.value === opt}
                          onChange={() => field.onChange(opt)}
                          className="accent-primary-600"
                        />
                        <span className="text-gray-800">{opt}</span>
                      </label>
                    ))}
                  </div>
                )}
              />
            )}

            {q.type === 'RATING' && (
              <Controller
                name="response"
                control={control}
                render={({ field }) => (
                  <div className="flex gap-3">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => field.onChange(String(n))}
                        className={`flex-1 py-3 rounded-lg border-2 text-lg font-semibold transition-colors ${
                          field.value === String(n)
                            ? 'border-primary-600 bg-primary-50 text-primary-700'
                            : 'border-gray-200 text-gray-500 hover:border-gray-300'
                        }`}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                )}
              />
            )}

            {q.type === 'YES_NO' && (
              <Controller
                name="response"
                control={control}
                render={({ field }) => (
                  <div className="flex gap-3">
                    {['Yes', 'No'].map((opt) => (
                      <button
                        key={opt}
                        type="button"
                        onClick={() => field.onChange(opt.toLowerCase())}
                        className={`flex-1 py-3 rounded-lg border-2 font-medium transition-colors ${
                          field.value === opt.toLowerCase()
                            ? 'border-primary-600 bg-primary-50 text-primary-700'
                            : 'border-gray-200 text-gray-600 hover:border-gray-300'
                        }`}
                      >
                        {opt}
                      </button>
                    ))}
                  </div>
                )}
              />
            )}
          </div>

          {submitError && (
            <p className="text-red-500 text-sm bg-red-50 rounded-lg px-3 py-2">{submitError}</p>
          )}

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full bg-primary-600 text-white rounded-xl py-4 text-base font-semibold hover:bg-primary-700 disabled:opacity-50 transition-colors"
          >
            {isSubmitting ? 'Submitting…' : 'Submit'}
          </button>
        </form>
      </div>
    </StudentLayout>
  )
}
