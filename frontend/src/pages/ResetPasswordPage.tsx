import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '@/api/client'
import PulseMark from '@/components/ui/PulseMark'
import { apiError } from '@/lib/errors'

type State =
  | { status: 'checking' }
  /** The link is good; `netId` names the account about to change. */
  | { status: 'ready'; netId: string }
  | { status: 'dead'; reason: string }
  | { status: 'done' }

export default function ResetPasswordPage() {
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const navigate = useNavigate()

  const [state, setState] = useState<State>({ status: 'checking' })
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  /**
   * The link is checked before the form is shown, so a student who opens a
   * day-old email is told so immediately rather than after choosing a password.
   */
  useEffect(() => {
    if (!token) {
      setState({ status: 'dead', reason: 'This reset link is incomplete. Request a new one.' })
      return
    }
    let cancelled = false
    api
      .post('/auth/student/reset-password/verify', { token })
      .then((res) => {
        if (!cancelled) setState({ status: 'ready', netId: res.data.data.netId })
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setState({ status: 'dead', reason: apiError(e, 'This reset link is not valid. Request a new one.') })
        }
      })
    return () => { cancelled = true }
  }, [token])

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (password !== confirm) {
      setError('Those two passwords do not match')
      return
    }
    setSaving(true)
    try {
      await api.post('/auth/student/reset-password', { token, newPassword: password })
      setState({ status: 'done' })
      // Long enough to read the confirmation, short enough that nobody wonders
      // whether the page has stalled.
      setTimeout(() => navigate('/login', { replace: true }), 2500)
    } catch (err: unknown) {
      setError(apiError(err, 'Could not reset your password. Request a new link.'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="min-h-screen bg-canvas flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center gap-2 mb-8">
          <PulseMark size={32} />
          <h1 className="text-2xl font-extrabold text-ink" style={{ letterSpacing: '-0.02em' }}>Pulse</h1>
        </div>

        <div className="bg-surface rounded-[14px] shadow-card border border-hairline p-8">
          {state.status === 'checking' && (
            <p className="text-sm text-muted text-center">Checking your link…</p>
          )}

          {state.status === 'dead' && (
            <div className="text-center">
              <h2 className="text-base font-semibold text-ink mb-2">This link no longer works</h2>
              <p className="text-sm text-muted">{state.reason}</p>
              <Link to="/forgot-password" className="text-sm text-signal font-medium mt-6 inline-block">
                Send a new link
              </Link>
            </div>
          )}

          {state.status === 'done' && (
            <div className="text-center">
              <p className="text-good font-medium mb-1">Password updated</p>
              <p className="text-sm text-muted">Taking you to sign in…</p>
            </div>
          )}

          {state.status === 'ready' && (
            <>
              <h2 className="text-base font-semibold text-ink mb-1">Choose a new password</h2>
              <p className="text-sm text-muted mb-6">
                For <span className="font-medium text-ink-2">{state.netId}</span>
              </p>

              <form onSubmit={onSubmit} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-ink-2 mb-1">New password</label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="At least 8 characters"
                    autoFocus
                    autoComplete="new-password"
                    className="w-full border border-hairline rounded-sm px-3 py-3 text-base bg-surface focus:outline-none focus:ring-2 focus:ring-signal"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-ink-2 mb-1">Confirm password</label>
                  <input
                    type="password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    autoComplete="new-password"
                    className="w-full border border-hairline rounded-sm px-3 py-3 text-base bg-surface focus:outline-none focus:ring-2 focus:ring-signal"
                  />
                </div>

                {error && <p className="text-red-500 text-sm bg-red-50 rounded-sm px-3 py-2">{error}</p>}

                <button
                  type="submit"
                  disabled={password.length < 8 || !confirm || saving}
                  className="w-full bg-signal text-white rounded-sm py-3 text-base font-bold hover:bg-[var(--signal-bright)] disabled:opacity-50 transition-colors"
                >
                  {saving ? 'Saving…' : 'Set new password'}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
