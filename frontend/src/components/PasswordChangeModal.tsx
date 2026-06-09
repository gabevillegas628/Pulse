import { useState } from 'react'
import { X } from 'lucide-react'
import { api } from '@/api/client'
import { apiError } from '@/lib/errors'

interface Props {
  endpoint: string
  open: boolean
  onClose: () => void
}

export default function PasswordChangeModal({ endpoint, open, onClose }: Props) {
  const [currentPw, setCurrentPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)
  const [loading, setLoading] = useState(false)

  function handleClose() {
    setCurrentPw(''); setNewPw(''); setError(''); setSuccess(false)
    onClose()
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await api.patch(endpoint, { currentPassword: currentPw, newPassword: newPw })
      setSuccess(true)
    } catch (err: unknown) {
      setError(apiError(err, 'Something went wrong'))
    } finally {
      setLoading(false)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
      <div className="bg-surface rounded-[14px] shadow-pop border border-hairline w-full max-w-sm p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-ink">Change password</h2>
          <button onClick={handleClose} className="text-muted hover:text-ink-2 transition-colors">
            <X size={18} />
          </button>
        </div>

        {success ? (
          <div className="text-center py-4">
            <p className="text-good font-medium mb-1">Password updated</p>
            <button onClick={handleClose} className="text-sm text-signal hover:underline mt-4 block mx-auto">Close</button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            <input
              type="password"
              value={currentPw}
              onChange={(e) => setCurrentPw(e.target.value)}
              placeholder="Current password"
              className="w-full border border-hairline rounded-sm px-3 py-2.5 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-signal"
              autoFocus
            />
            <input
              type="password"
              value={newPw}
              onChange={(e) => setNewPw(e.target.value)}
              placeholder="New password (min 8 chars)"
              className="w-full border border-hairline rounded-sm px-3 py-2.5 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-signal"
            />
            {error && <p className="text-red-500 text-xs">{error}</p>}
            <div className="flex justify-end gap-3 pt-1">
              <button type="button" onClick={handleClose} className="px-4 py-2 text-sm text-muted hover:text-ink transition-colors">Cancel</button>
              <button
                type="submit"
                disabled={!currentPw || newPw.length < 8 || loading}
                className="px-4 py-2 bg-signal text-white rounded-sm text-sm font-bold hover:bg-[var(--signal-bright)] disabled:opacity-50 transition-colors"
              >
                {loading ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
