import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '@/api/client'
import StudentLayout from '@/components/layout/StudentLayout'

export default function CodeEntryPage() {
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (code.length !== 4) { setError('Enter the 4-digit code'); return }
    setError('')
    setLoading(true)
    try {
      const r = await api.get(`/sessions/by-code/${code}`)
      navigate(`/s/${r.data.data.sessionId}`)
    } catch (e: unknown) {
      const status = (e as { response?: { status?: number } })?.response?.status
      if (status === 409) setError('This session is closed')
      else if (status === 404) setError('Code not found — check and try again')
      else setError('Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  return (
    <StudentLayout>
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8 text-center">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Enter class code</h1>
        <p className="text-sm text-gray-500 mb-8">Your professor will display a 4-digit code on screen</p>

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
            {loading ? 'Looking up…' : 'Join session'}
          </button>
        </form>
      </div>
    </StudentLayout>
  )
}
