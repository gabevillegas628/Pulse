import { useEffect, useState } from 'react'
import { useNavigate, useParams, useLocation } from 'react-router-dom'
import { api } from '@/api/client'
import { useStudentAuth } from '@/context/StudentAuthContext'
import StudentLayout from '@/components/layout/StudentLayout'

export default function QuestionRedirectPage() {
  const { code } = useParams<{ code: string }>()
  const [error, setError] = useState('')
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
    api
      .get(`/questions/by-code/${code}`)
      .then((r) => navigate(`/q/${r.data.data.questionId}`, { replace: true }))
      .catch((e: unknown) => {
        const status = (e as { response?: { status?: number } })?.response?.status
        if (status === 409) setError('This session is not open yet')
        else if (status === 404) setError('Question not found')
        else setError('Something went wrong')
      })
  }, [isAuthenticated, code, navigate])

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
