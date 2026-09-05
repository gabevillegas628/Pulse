import { ReactNode } from 'react'
import { Link, Navigate, useLocation } from 'react-router-dom'
import { useProfessorAuth } from '@/context/ProfessorAuthContext'
import ProfessorLayout from '@/components/layout/ProfessorLayout'
import { Shield, ChevronLeft } from 'lucide-react'

/**
 * The admin umbrella: back link, header, and the tab bar. Tabs are routes, not
 * component state, so a tab survives refresh and the back button behaves.
 *
 * The gate mirrors the server's — requireAdmin answers 403 regardless of what
 * renders here, so this is navigation, not security.
 */

const tabs = [
  { to: '/professor/admin', label: 'Professors' },
  { to: '/professor/admin/students', label: 'Students' },
]

export default function AdminLayout({ children }: { children: ReactNode }) {
  const { professor: me } = useProfessorAuth()
  const { pathname } = useLocation()

  if (me && !me.isAdmin) return <Navigate to="/professor" replace />

  return (
    <ProfessorLayout>
      <Link to="/professor" className="flex items-center gap-1 text-sm text-muted hover:text-ink mb-4 transition-colors">
        <ChevronLeft size={16} /> All classes
      </Link>
      <div className="flex items-center gap-2 mb-5">
        <Shield size={20} className="text-signal" />
        <h1 className="text-xl font-bold text-ink">Administration</h1>
      </div>

      <nav className="flex gap-5 border-b border-hairline mb-6">
        {tabs.map((t) => {
          const active = pathname === t.to
          return (
            <Link
              key={t.to}
              to={t.to}
              className={`pb-2.5 -mb-px text-sm font-bold border-b-2 transition-colors ${
                active
                  ? 'text-ink border-signal'
                  : 'text-muted border-transparent hover:text-ink-2'
              }`}
            >
              {t.label}
            </Link>
          )
        })}
      </nav>

      {children}
    </ProfessorLayout>
  )
}
