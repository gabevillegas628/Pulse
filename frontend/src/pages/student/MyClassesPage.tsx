import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/api/client'
import { useStudentAuth } from '@/context/StudentAuthContext'
import StudentLayout from '@/components/layout/StudentLayout'
import { BookOpen, LogOut, KeyRound, X } from 'lucide-react'

type GradeSession = { id: string; title: string; earned: number; max: number }

function ClassGrades({ classId }: { classId: string }) {
  const { data } = useQuery<{ sessions: GradeSession[]; totalEarned: number; totalMax: number }>({
    queryKey: ['student-grades', classId],
    queryFn: () => api.get(`/student/classes/${classId}/grades`).then((r) => r.data.data),
  })

  if (!data || data.sessions.length === 0) return null

  return (
    <div className="mt-3 pt-3 border-t border-gray-100">
      <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-2">Grades</p>
      <div className="space-y-1.5">
        {data.sessions.map((s) => (
          <div key={s.id} className="flex justify-between items-center">
            <p className="text-xs text-gray-600 truncate pr-2">{s.title}</p>
            <p className="text-xs font-medium text-gray-900 shrink-0">{s.earned}/{s.max}</p>
          </div>
        ))}
      </div>
      {data.sessions.length > 1 && (
        <div className="flex justify-between mt-2 pt-2 border-t border-gray-100">
          <p className="text-xs text-gray-400">Total</p>
          <p className="text-xs font-semibold text-gray-900">{data.totalEarned}/{data.totalMax}</p>
        </div>
      )}
    </div>
  )
}

export default function MyClassesPage() {
  const { student, logout } = useStudentAuth()
  const navigate = useNavigate()
  const [showPwModal, setShowPwModal] = useState(false)
  const [currentPw, setCurrentPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [pwError, setPwError] = useState('')
  const [pwSuccess, setPwSuccess] = useState(false)
  const [pwLoading, setPwLoading] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: ['student-classes'],
    queryFn: () => api.get('/student/classes').then((r) => r.data.data.enrollments),
  })

  function handleLogout() {
    logout()
    navigate('/student/login')
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
      await api.patch('/student/me/password', { currentPassword: currentPw, newPassword: newPw })
      setPwSuccess(true)
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      setPwError(msg ?? 'Something went wrong')
    } finally {
      setPwLoading(false)
    }
  }

  return (
    <StudentLayout>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">My Classes</h1>
          <p className="text-sm text-gray-500">{student?.name} · {student?.netId}</p>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={openPwModal} className="text-gray-400 hover:text-gray-600" title="Change password">
            <KeyRound size={18} />
          </button>
          <button onClick={handleLogout} className="text-gray-400 hover:text-gray-600" title="Log out">
            <LogOut size={18} />
          </button>
        </div>
      </div>

      {/* Code entry — primary action */}
      <button
        onClick={() => navigate('/student/enter-code')}
        className="w-full bg-primary-600 text-white rounded-2xl p-5 text-left mb-6 hover:bg-primary-700 transition-colors"
      >
        <p className="text-lg font-semibold mb-0.5">Enter question code</p>
        <p className="text-primary-200 text-sm">Enter the 4-digit code your professor displays</p>
      </button>

      {/* Enrolled classes — context only */}
      <div className="mb-3">
        <p className="text-xs font-medium text-gray-400 uppercase tracking-wide">Your classes</p>
      </div>

      {isLoading ? (
        <p className="text-gray-400 text-center py-8">Loading…</p>
      ) : data?.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          <BookOpen className="mx-auto mb-3" size={32} />
          <p className="text-sm">No classes yet — you'll be enrolled automatically when you answer your first question</p>
        </div>
      ) : (
        <div className="space-y-3">
          {data?.map((enrollment: {
            class: {
              id: string
              name: string
              professor: { name: string }
              sessions: Array<{ id: string; title: string; status: string }>
            }
          }) => (
            <div key={enrollment.class.id} className="bg-white border border-gray-200 rounded-2xl p-5">
              <p className="font-semibold text-gray-900">{enrollment.class.name}</p>
              <p className="text-xs text-gray-400">{enrollment.class.professor.name}</p>
              {enrollment.class.sessions.length > 0 && (
                <p className="text-xs text-green-600 mt-1.5 font-medium">Session in progress</p>
              )}
              <ClassGrades classId={enrollment.class.id} />
            </div>
          ))}
        </div>
      )}
      {/* Change password modal */}
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
    </StudentLayout>
  )
}
