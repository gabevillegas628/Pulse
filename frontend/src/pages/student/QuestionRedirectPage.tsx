import { useEffect, useState } from 'react'
import { useNavigate, useParams, useLocation } from 'react-router-dom'
import { api } from '@/api/client'
import { useStudentAuth } from '@/context/StudentAuthContext'
import StudentLayout from '@/components/layout/StudentLayout'

// While the session is not open yet, keep asking. The scan is also what tells the
// professor's slide that students are waiting, so each retry keeps this student counted.
// Spread out so a hall of phones does not ask in step.
const RETRY_MS = 8000
const RETRY_JITTER_MS = 4000
// Matches how long the server remembers a waiting student.
const GIVE_UP_MS = 10 * 60 * 1000

export default function QuestionRedirectPage() {
  const { code } = useParams<{ code: string }>()
  const [error, setError] = useState('')
  const [waiting, setWaiting] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()
  const { isAuthenticated, isLoading: authLoading } = useStudentAuth()

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      navigate(`/login?next=${location.pathname}`, { replace: true })
    }
  }, [authLoading, isAuthenticated, navigate, location.pathname])

  useEffect(() => {
    if (!isAuthenticated || !code) return
    let cancelled = false
    let timer: number | undefined
    const startedAt = Date.now()

    function attempt() {
      api
        .get(`/questions/by-code/${code}`)
        .then((r) => { if (!cancelled) navigate(`/q/${r.data.data.questionId}`, { replace: true }) })
        .catch((e: unknown) => {
          if (cancelled) return
          const res = (e as { response?: { status?: number; data?: { code?: string; error?: string } } })?.response
          if (res?.status === 409 && res.data?.code === 'SESSION_NOT_OPEN') {
            if (Date.now() - startedAt < GIVE_UP_MS) {
              setWaiting(true)
              timer = window.setTimeout(attempt, RETRY_MS + Math.random() * RETRY_JITTER_MS)
            } else {
              setWaiting(false)
              setError('This session is not open yet')
            }
          } else if (res?.status === 409) setError(res.data?.error ?? 'This session is not open yet')
          else if (res?.status === 404) setError('Question not found')
          else setError('Something went wrong')
        })
    }

    attempt()
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [isAuthenticated, code, navigate])

  if (waiting && !error) {
    return (
      <StudentLayout>
        <div className="text-center mt-20">
          <p className="font-medium text-lg text-ink">Waiting for your instructor to start…</p>
          <p className="text-sm text-muted mt-2">Keep this page open. It will continue on its own.</p>
        </div>
      </StudentLayout>
    )
  }

  if (authLoading || (!error && isAuthenticated)) {
    return (
      <StudentLayout>
        <p className="text-gray-400 text-center mt-20">Loading…</p>
      </StudentLayout>
    )
  }

  return (
    <StudentLayout>
      <div className="text-center mt-20">
        <p className="text-red-500 font-medium text-lg">{error}</p>
        <button
          onClick={() => navigate('/student')}
          className="mt-4 text-sm text-gray-500 hover:text-gray-700"
        >
          Go home
        </button>
      </div>
    </StudentLayout>
  )
}
