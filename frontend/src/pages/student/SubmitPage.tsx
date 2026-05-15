import { useEffect, useState } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { useForm, Controller } from 'react-hook-form'
import { api } from '@/api/client'
import { useStudentAuth } from '@/context/StudentAuthContext'
import StudentLayout from '@/components/layout/StudentLayout'
import { io } from 'socket.io-client'
import type { Question } from 'shared'

interface SessionData {
  id: string
  title: string
  status: string
  questions: Question[]
  class: { name: string }
}

export default function SubmitPage() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const { isAuthenticated, isLoading: authLoading } = useStudentAuth()

  const [session, setSession] = useState<SessionData | null>(null)
  const [alreadySubmitted, setAlreadySubmitted] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [submitError, setSubmitError] = useState('')
  const [sessionClosed, setSessionClosed] = useState(false)

  const { control, handleSubmit, register, formState: { isSubmitting } } = useForm<Record<string, string>>()

  // Redirect to login if not authenticated
  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      navigate(`/login?next=${location.pathname}`, { replace: true })
    }
  }, [authLoading, isAuthenticated, navigate, location.pathname])

  // Load session
  useEffect(() => {
    if (!isAuthenticated || !sessionId) return
    api.get(`/student/sessions/${sessionId}`)
      .then((r) => {
        setSession(r.data.data.session)
        setAlreadySubmitted(r.data.data.alreadySubmitted)
        if (r.data.data.session.status !== 'OPEN') setSessionClosed(true)
      })
      .catch((e) => {
        const msg = e?.response?.data?.error
        setLoadError(msg ?? 'Session not found')
      })
  }, [isAuthenticated, sessionId])

  // Listen for session close
  useEffect(() => {
    if (!sessionId) return
    const socket = io({ path: '/socket.io' })
    socket.emit('join_session', sessionId)
    socket.on('session_status', ({ status }: { status: string }) => {
      if (status === 'CLOSED') setSessionClosed(true)
    })
    return () => { socket.disconnect() }
  }, [sessionId])

  async function onSubmit(data: Record<string, string>) {
    if (!session) return
    setSubmitError('')
    try {
      const responses = session.questions.map((q) => ({
        questionId: q.id,
        responseText: data[q.id] ?? '',
      }))
      await api.post('/responses', { sessionId: session.id, responses })
      navigate(`/s/${session.id}/confirmation`)
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error
      setSubmitError(msg ?? 'Submission failed — please try again')
    }
  }

  if (authLoading || (!session && !loadError)) {
    return (
      <StudentLayout>
        <div className="text-center py-16 text-gray-400">Loading…</div>
      </StudentLayout>
    )
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

  if (alreadySubmitted) {
    return (
      <StudentLayout>
        <div className="bg-white rounded-2xl border border-gray-200 p-8 text-center">
          <p className="text-xl font-semibold text-gray-700 mb-2">Already submitted</p>
          <p className="text-gray-400 text-sm">You've already responded to this session.</p>
        </div>
      </StudentLayout>
    )
  }

  return (
    <StudentLayout>
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
        <div className="bg-primary-600 px-6 py-4">
          <p className="text-primary-100 text-xs font-medium uppercase tracking-wide">{session!.class.name}</p>
          <h1 className="text-white text-lg font-semibold mt-0.5">{session!.title}</h1>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="p-6 space-y-6">
          {session!.questions.map((q, idx) => (
            <div key={q.id}>
              <label className="block text-sm font-medium text-gray-800 mb-2">
                {session!.questions.length > 1 && <span className="text-primary-500 mr-1">Q{idx + 1}.</span>}
                {q.text}
              </label>

              {q.type === 'FREE_TEXT' && (
                <textarea
                  {...register(q.id)}
                  rows={4}
                  placeholder="Write your response…"
                  className="w-full border border-gray-300 rounded-lg px-3 py-3 text-base focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none"
                />
              )}

              {q.type === 'MULTIPLE_CHOICE' && q.options && (
                <Controller
                  name={q.id}
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
                  name={q.id}
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
                  name={q.id}
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
          ))}

          {submitError && (
            <p className="text-red-500 text-sm bg-red-50 rounded-lg px-3 py-2">{submitError}</p>
          )}

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full bg-primary-600 text-white rounded-xl py-4 text-base font-semibold hover:bg-primary-700 disabled:opacity-50 transition-colors"
          >
            {isSubmitting ? 'Submitting…' : 'Submit response'}
          </button>
        </form>
      </div>
    </StudentLayout>
  )
}
