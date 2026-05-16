import { ReactNode, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useProfessorAuth } from '@/context/ProfessorAuthContext'
import { LogOut, KeyRound, X } from 'lucide-react'
import { api } from '@/api/client'

export default function ProfessorLayout({ children }: { children: ReactNode }) {
  const { professor, logout } = useProfessorAuth()
  const navigate = useNavigate()
  const [showPwModal, setShowPwModal] = useState(false)
  const [currentPw, setCurrentPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [pwError, setPwError] = useState('')
  const [pwSuccess, setPwSuccess] = useState(false)
  const [pwLoading, setPwLoading] = useState(false)

  function handleLogout() {
    logout()
    navigate('/professor/login')
  }

  function openPwModal() {
    setCurrentPw(''); setNewPw(''); setPwError(''); setPwSuccess(false)
    setShowPwModal(true)
  }

  async function handlePasswordChange(e: React.FormEvent) {
    e.preventDefault()
    setPwError('')
    setPwLoading(true)
    try {
      await api.patch('/auth/professor/me/password', { currentPassword: currentPw, newPassword: newPw })
      setPwSuccess(true)
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      setPwError(msg ?? 'Something went wrong')
    } finally {
      setPwLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between">
          <Link to="/professor" className="font-semibold text-primary-700 text-lg tracking-tight">
            Pulse
          </Link>
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-500">{professor?.name}</span>
            <button onClick={openPwModal} className="text-gray-400 hover:text-gray-600" title="Change password">
              <KeyRound size={15} />
            </button>
            <button
              onClick={handleLogout}
              className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800 transition-colors"
            >
              <LogOut size={15} />
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="max-w-6xl mx-auto px-4 py-8">{children}</main>

      {showPwModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold">Change password</h2>
              <button onClick={() => setShowPwModal(false)}><X size={18} className="text-gray-400" /></button>
            </div>

            {pwSuccess ? (
              <div className="text-center py-4">
                <p className="text-green-600 font-medium mb-1">Password updated</p>
                <button onClick={() => setShowPwModal(false)} className="text-sm text-primary-600 hover:underline mt-4 block mx-auto">Close</button>
              </div>
            ) : (
              <form onSubmit={handlePasswordChange} className="space-y-3">
                <input
                  type="password"
                  value={currentPw}
                  onChange={(e) => setCurrentPw(e.target.value)}
                  placeholder="Current password"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                  autoFocus
                />
                <input
                  type="password"
                  value={newPw}
                  onChange={(e) => setNewPw(e.target.value)}
                  placeholder="New password (min 8 chars)"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
                {pwError && <p className="text-red-500 text-xs">{pwError}</p>}
                <div className="flex justify-end gap-3 pt-1">
                  <button type="button" onClick={() => setShowPwModal(false)} className="px-4 py-2 text-sm text-gray-600">Cancel</button>
                  <button
                    type="submit"
                    disabled={!currentPw || newPw.length < 8 || pwLoading}
                    className="px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50"
                  >
                    {pwLoading ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
