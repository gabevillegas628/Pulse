import { useState } from 'react'
import { apiError } from '@/lib/errors'

interface Props {
  open: boolean
  role: 'professor' | 'student'
  identifier: string // email for professor, netId for student
  onLogin: (credential: string, password: string) => Promise<void>
  onDismiss: () => void
}

export default function SessionExpiredModal({ open, role, identifier, onLogin, onDismiss }: Props) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await onLogin(identifier, password)
      setPassword('')
    } catch (err: unknown) {
      setError(apiError(err, 'Incorrect password'))
    } finally {
      setLoading(false)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 px-4">
      <div className="bg-surface rounded-[14px] shadow-pop border border-hairline w-full max-w-sm p-6">
        <h2 className="text-base font-semibold text-ink mb-1">Session expired</h2>
        <p className="text-sm text-muted mb-5">
          Enter your password to continue as <span className="text-ink font-medium">{identifier}</span>.
        </p>

        <form onSubmit={handleSubmit} className="space-y-3">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            autoFocus
            className="w-full border border-hairline rounded-sm px-3 py-2.5 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-signal"
          />
          {error && <p className="text-red-500 text-xs">{error}</p>}
          <div className="flex justify-between items-center pt-1">
            <button
              type="button"
              onClick={onDismiss}
              className="text-sm text-muted hover:text-ink transition-colors"
            >
              {role === 'professor' ? 'Go to login' : 'Go to login'}
            </button>
            <button
              type="submit"
              disabled={!password || loading}
              className="px-4 py-2 bg-signal text-white rounded-sm text-sm font-bold hover:bg-[var(--signal-bright)] disabled:opacity-50 transition-colors"
            >
              {loading ? 'Signing in…' : 'Continue'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
