import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/api/client'
import { useStudentAuth } from '@/context/StudentAuthContext'
import StudentLayout from '@/components/layout/StudentLayout'
import { BookOpen, LogOut, Plus } from 'lucide-react'

export default function MyClassesPage() {
  const { student, logout } = useStudentAuth()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [joinCode, setJoinCode] = useState('')
  const [joinError, setJoinError] = useState('')

  const { data, isLoading } = useQuery({
    queryKey: ['student-classes'],
    queryFn: () => api.get('/student/classes').then((r) => r.data.data.enrollments),
  })

  const enrollMutation = useMutation({
    mutationFn: (code: string) => api.post('/student/enroll', { joinCode: code }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['student-classes'] }); setJoinCode('') },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error
      setJoinError(msg ?? 'Join failed')
    },
  })

  function handleJoin(e: React.FormEvent) {
    e.preventDefault()
    setJoinError('')
    enrollMutation.mutate(joinCode)
  }

  function handleLogout() {
    logout()
    navigate('/student/login')
  }

  return (
    <StudentLayout>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">My Classes</h1>
          <p className="text-sm text-gray-500">{student?.name} · {student?.netId}</p>
        </div>
        <button onClick={handleLogout} className="text-gray-400 hover:text-gray-600">
          <LogOut size={18} />
        </button>
      </div>

      {/* Join a class */}
      <form onSubmit={handleJoin} className="bg-white border border-gray-200 rounded-2xl p-4 mb-6">
        <p className="text-sm font-medium text-gray-700 mb-3">Join a class</p>
        <div className="flex gap-2">
          <input
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value.toUpperCase().slice(0, 6))}
            placeholder="Class code (e.g. BIO4F2)"
            className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
          <button
            type="submit"
            disabled={joinCode.length < 3 || enrollMutation.isPending}
            className="flex items-center gap-1 bg-primary-600 text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-40"
          >
            <Plus size={15} />
            Join
          </button>
        </div>
        {joinError && <p className="text-red-500 text-xs mt-2">{joinError}</p>}
      </form>

      {/* Class list */}
      {isLoading ? (
        <p className="text-gray-400 text-center py-8">Loading…</p>
      ) : data?.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          <BookOpen className="mx-auto mb-3" size={32} />
          <p className="text-sm">No classes yet — enter a join code above</p>
        </div>
      ) : (
        <div className="space-y-3">
          {data?.map((enrollment: { class: { id: string; name: string; professor: { name: string }; sessions: Array<{ id: string; title: string; status: string }> }; enrolledAt: string }) => (
            <div key={enrollment.class.id} className="bg-white border border-gray-200 rounded-2xl p-5">
              <p className="font-semibold text-gray-900">{enrollment.class.name}</p>
              <p className="text-xs text-gray-400 mb-3">{enrollment.class.professor.name}</p>

              {enrollment.class.sessions.length > 0 ? (
                <div className="space-y-2">
                  {enrollment.class.sessions.map((s) => (
                    <Link
                      key={s.id}
                      to={`/s/${s.id}`}
                      className="flex items-center justify-between p-3 bg-primary-50 border border-primary-100 rounded-xl hover:bg-primary-100 transition-colors"
                    >
                      <div>
                        <p className="text-sm font-medium text-primary-800">{s.title}</p>
                        <p className="text-xs text-primary-500">Open now</p>
                      </div>
                      <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium">Open</span>
                    </Link>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-gray-400">No open sessions right now</p>
              )}
            </div>
          ))}
        </div>
      )}
    </StudentLayout>
  )
}
