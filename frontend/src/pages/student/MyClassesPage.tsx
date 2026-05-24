import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/api/client'
import { useStudentAuth } from '@/context/StudentAuthContext'
import StudentLayout from '@/components/layout/StudentLayout'
import { BookOpen, LogOut, KeyRound, Radio } from 'lucide-react'
import PasswordChangeModal from '@/components/PasswordChangeModal'

interface ClassInfo {
  id: string
  name: string
  textbookRepo: string | null
  professor: { name: string }
  sessions: Array<{ id: string; title: string; status: string }>
}

interface Enrollment {
  section: { id: string; name: string } | null
  class: ClassInfo
}

export default function MyClassesPage() {
  const { student, logout } = useStudentAuth()
  const navigate = useNavigate()
  const [showPwModal, setShowPwModal] = useState(false)

  const { data, isLoading } = useQuery<Enrollment[]>({
    queryKey: ['student-classes'],
    queryFn: () => api.get('/student/classes').then((r) => r.data.data.enrollments),
  })

  function handleLogout() {
    logout()
    navigate('/student/login')
  }

  return (
    <StudentLayout>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">My Classes</h1>
          <p className="text-sm text-gray-500">{student?.netId}</p>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => setShowPwModal(true)} className="text-gray-400 hover:text-gray-600" title="Change password">
            <KeyRound size={18} />
          </button>
          <button onClick={handleLogout} className="text-gray-400 hover:text-gray-600" title="Log out">
            <LogOut size={18} />
          </button>
        </div>
      </div>

      {/* Primary action */}
      <button
        onClick={() => navigate('/student/enter-code')}
        className="w-full bg-primary-600 text-white rounded-2xl p-5 text-left mb-6 hover:bg-primary-700 transition-colors"
      >
        <p className="text-lg font-semibold mb-0.5">Enter question code</p>
        <p className="text-primary-200 text-sm">Enter the 4-digit code your professor displays</p>
      </button>

      {/* Class list */}
      {isLoading ? (
        <p className="text-gray-400 text-center py-8">Loading…</p>
      ) : data?.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          <BookOpen className="mx-auto mb-3" size={32} />
          <p className="text-sm">No classes yet — you'll be enrolled automatically when you answer your first question</p>
        </div>
      ) : (
        <div className="space-y-3">
          {data?.map((enrollment) => {
            const { class: cls, section } = enrollment
            const isLive = cls.sessions.length > 0
            return (
              <Link
                key={cls.id}
                to={`/student/classes/${cls.id}`}
                className="block bg-white border border-gray-200 rounded-2xl px-5 py-4 hover:shadow-sm transition-shadow"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-gray-900 truncate">{cls.name}</p>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {cls.professor.name}
                      {section && <span> · Section {section.name}</span>}
                    </p>
                  </div>
                  {isLive && (
                    <span className="shrink-0 flex items-center gap-1.5 text-xs font-medium text-green-700 bg-green-50 border border-green-200 px-2.5 py-1 rounded-full">
                      <Radio size={11} className="animate-pulse" /> Live
                    </span>
                  )}
                </div>
              </Link>
            )
          })}
        </div>
      )}

      <PasswordChangeModal
        endpoint="/student/me/password"
        open={showPwModal}
        onClose={() => setShowPwModal(false)}
      />
    </StudentLayout>
  )
}
