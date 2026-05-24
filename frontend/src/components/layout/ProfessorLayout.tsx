import { ReactNode, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useProfessorAuth } from '@/context/ProfessorAuthContext'
import { LogOut, KeyRound } from 'lucide-react'
import PasswordChangeModal from '@/components/PasswordChangeModal'

export default function ProfessorLayout({ children }: { children: ReactNode }) {
  const { professor, logout } = useProfessorAuth()
  const navigate = useNavigate()
  const [showPwModal, setShowPwModal] = useState(false)

  function handleLogout() {
    logout()
    navigate('/professor/login')
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
            <button onClick={() => setShowPwModal(true)} className="text-gray-400 hover:text-gray-600" title="Change password">
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

      <PasswordChangeModal
        endpoint="/auth/professor/me/password"
        open={showPwModal}
        onClose={() => setShowPwModal(false)}
      />
    </div>
  )
}
