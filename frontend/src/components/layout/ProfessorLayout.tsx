import { ReactNode, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useProfessorAuth } from '@/context/ProfessorAuthContext'
import { LogOut, KeyRound } from 'lucide-react'
import PasswordChangeModal from '@/components/PasswordChangeModal'
import PulseMark from '@/components/ui/PulseMark'

export default function ProfessorLayout({ children }: { children: ReactNode }) {
  const { professor, logout } = useProfessorAuth()
  const navigate = useNavigate()
  const [showPwModal, setShowPwModal] = useState(false)

  function handleLogout() {
    logout()
    navigate('/professor/login')
  }

  return (
    <div className="min-h-screen bg-canvas">
      <header className="bg-surface border-b border-hairline">
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between">
          <Link to="/professor" className="inline-flex items-center gap-2">
            <PulseMark size={20} />
            <span className="font-extrabold text-ink text-lg tracking-tight" style={{ letterSpacing: '-0.02em' }}>Pulse</span>
          </Link>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted">{professor?.name}</span>
            <button onClick={() => setShowPwModal(true)} className="text-muted hover:text-ink-2 transition-colors" title="Change password">
              <KeyRound size={15} />
            </button>
            <button
              onClick={handleLogout}
              className="flex items-center gap-1 text-sm text-muted hover:text-ink transition-colors"
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
