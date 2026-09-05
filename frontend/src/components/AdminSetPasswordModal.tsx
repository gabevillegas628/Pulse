import { useState } from 'react'
import { X } from 'lucide-react'
import { api } from '@/api/client'
import { apiError } from '@/lib/errors'
import Button from '@/components/ui/Button'

interface Props {
  /** POST target; null keeps the modal closed. */
  endpoint: string | null
  /** Who is being reset, for the title — a netID or a name. */
  who: string
  onClose: () => void
}

/**
 * The admin sets a temporary password and hands it over out of band — the reset
 * of last resort, for when the email on the account is the broken part and a
 * link cannot arrive. Shared by the Professors and Students tabs; only the
 * endpoint differs.
 */
export default function AdminSetPasswordModal({ endpoint, who, onClose }: Props) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)

  function handleClose() {
    setPassword(''); setError(''); setDone(false)
    onClose()
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!endpoint) return
    setError('')
    setLoading(true)
    try {
      await api.post(endpoint, { newPassword: password })
      setDone(true)
    } catch (err: unknown) {
      setError(apiError(err, 'Failed to set password'))
    } finally {
      setLoading(false)
    }
  }

  if (!endpoint) return null

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
      <div className="bg-surface rounded-[14px] shadow-pop border border-hairline w-full max-w-sm p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-ink">Set password for {who}</h2>
          <button onClick={handleClose} className="text-muted hover:text-ink-2 transition-colors">
            <X size={18} />
          </button>
        </div>

        {done ? (
          <div className="py-2">
            <p className="text-good font-medium mb-2">Password set</p>
            <p className="text-sm text-muted">
              Hand it over out of band — they can change it themselves once signed in.
              Any sign-in lockout has been cleared.
            </p>
            <button onClick={handleClose} className="text-sm text-signal hover:underline mt-4">Close</button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            <input
              type="text"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Temporary password (min 8 chars)"
              className="w-full border border-hairline rounded-sm px-3 py-2.5 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-signal"
              autoFocus
            />
            {error && <p className="text-sm text-warn">{error}</p>}
            <Button variant="primary" type="submit" disabled={loading || password.length < 8} className="w-full">
              {loading ? 'Setting…' : 'Set password'}
            </Button>
          </form>
        )}
      </div>
    </div>
  )
}
