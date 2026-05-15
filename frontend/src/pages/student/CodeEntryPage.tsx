import { useState, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { api } from '@/api/client'
import { useStudentAuth } from '@/context/StudentAuthContext'
import StudentLayout from '@/components/layout/StudentLayout'
import { ChevronLeft } from 'lucide-react'

export default function CodeEntryPage() {
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()
  const { isAuthenticated, isLoading: authLoading } = useStudentAuth()

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      navigate(`/login?next=${location.pathname}`, { replace: true })
    }
  }, [authLoading, isAuthenticated, navigate, location.pathname])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (code.length !== 4) { setError('Enter the 4-digit code'); return }
    setError('')
    setLoading(true)
    try {
      const r = await api.get(`/questions/by-code/${code}`)
      navigate(`/q/${r.data.data.questionId}`)
    } catch (e: unknown) {
      const status = (e as { response?: { status?: number } })?.response?.status
      if (status === 409) setError('This session is not open')
      else if (status === 404) setError('Code not found — check and try again')
      else setError('Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  if (authLoading) return null

  return (
    <StudentLayout>
      <button
        onClick={() => navigate('/student')}
        className="flex items-center gap-1 text-sm text-gray-400 hover:text-gray-600 mb-5"
      >
        <ChevronLeft size={16} /> My classes
      </button>

      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8 text-center">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Enter question code</h1>
        <p className="text-sm text-gray-500 mb-8">Enter the 4-digit code your professor is showing</p>

        <form onSubmit={handleSubmit} className="space-y-6">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 4))}
            className="w-full text-center text-4xl font-mono tracking-widest border-2 border-gray-300 rounded-xl px-4 py-5 focus:outline-none focus:border-primary-500"
            placeholder="0000"
            inputMode="numeric"
            maxLength={4}
            autoFocus
          />

          {error && <p className="text-red-500 text-sm">{error}</p>}

          <button
            type="submit"
            disabled={loading || code.length !== 4}
            className="w-full bg-primary-600 text-white rounded-xl py-4 text-lg font-medium hover:bg-primary-700 disabled:opacity-40 transition-colors"
          >
            {loading ? 'Looking up…' : 'Go'}
          </button>
        </form>
      </div>
    </StudentLayout>
  )
}
