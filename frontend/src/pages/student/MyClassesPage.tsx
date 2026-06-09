import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/api/client'
import { useStudentAuth } from '@/context/StudentAuthContext'
import StudentLayout from '@/components/layout/StudentLayout'
import Pill from '@/components/ui/Pill'
import LiveDot from '@/components/ui/LiveDot'
import Empty from '@/components/ui/Empty'
import { BookOpen, LogOut, KeyRound, Clock } from 'lucide-react'
import PasswordChangeModal from '@/components/PasswordChangeModal'
import type { UpcomingAssignment } from 'shared'

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

  const { data: upcomingData } = useQuery<{ assignments: UpcomingAssignment[] }>({
    queryKey: ['student-upcoming-assignments'],
    queryFn: () => api.get('/student/upcoming-assignments').then((r) => r.data.data),
  })

  function handleLogout() {
    logout()
    navigate('/student/login')
  }

  const upcoming = upcomingData?.assignments ?? []
  const liveEnrollments = data?.filter((e) => e.class.sessions.length > 0) ?? []
  const hasLive = liveEnrollments.length > 0

  // Count due assignments per class for per-card badge
  const dueCountByClass: Record<string, number> = {}
  for (const a of upcoming) {
    dueCountByClass[a.classId] = (dueCountByClass[a.classId] ?? 0) + 1
  }

  function formatDeadline(iso: string): string {
    const d = new Date(iso)
    const now = new Date()
    const diffDays = Math.round((d.getTime() - now.getTime()) / 86400000)
    if (diffDays === 0) return 'Due today'
    if (diffDays === 1) return 'Due tomorrow'
    if (diffDays <= 6) return `Due ${d.toLocaleDateString('en-US', { weekday: 'long' })}`
    return `Due ${d.toLocaleDateString()}`
  }

  return (
    <StudentLayout>
      {/* User row */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-ink">My Classes</h1>
          <p className="text-sm text-muted font-mono">{student?.netId}</p>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => setShowPwModal(true)} className="text-muted hover:text-ink-2 transition-colors" title="Change password">
            <KeyRound size={18} />
          </button>
          <button onClick={handleLogout} className="text-muted hover:text-ink-2 transition-colors" title="Log out">
            <LogOut size={18} />
          </button>
        </div>
      </div>

      {/* Live now — primary CTA when session is open */}
      {hasLive && (
        <div className="mb-5 space-y-2">
          {liveEnrollments.map((e) => (
            <div
              key={e.class.id}
              className="bg-signal-soft border border-signal/20 rounded-[14px] p-5 flex items-center justify-between gap-4"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <LiveDot />
                  <span className="text-xs font-bold text-signal uppercase tracking-wide">Live now</span>
                </div>
                <p className="font-semibold text-ink truncate">{e.class.name}</p>
                <p className="text-xs text-muted mt-0.5">{e.class.sessions[0].title}</p>
              </div>
              <Link
                to="/student/enter-code"
                className="shrink-0 inline-flex items-center gap-2 bg-signal text-white px-4 py-2 rounded-sm text-sm font-bold hover:bg-[var(--signal-bright)] transition-colors"
              >
                Answer now
              </Link>
            </div>
          ))}
        </div>
      )}

      {/* Code entry — primary when no live, secondary when live */}
      {hasLive ? (
        <button
          onClick={() => navigate('/student/enter-code')}
          className="w-full text-sm text-muted hover:text-ink text-center py-2 mb-5 transition-colors"
        >
          Enter a question code manually
        </button>
      ) : (
        <button
          onClick={() => navigate('/student/enter-code')}
          className="w-full bg-signal text-white rounded-[14px] p-5 text-left mb-6 hover:bg-[var(--signal-bright)] transition-colors"
        >
          <p className="text-lg font-semibold mb-0.5">Enter question code</p>
          <p className="text-white/70 text-sm">Enter the 4-digit code your professor displays</p>
        </button>
      )}

      {/* Due soon strip */}
      {upcoming.length > 0 && (
        <div className="mb-5 space-y-2">
          {upcoming.map((a) => {
            const pct = a.questionCount > 0 ? Math.round((a.submittedCount / a.questionCount) * 100) : 0
            return (
              <Link
                key={a.id}
                to={`/student/assignments/${a.id}`}
                className="flex items-center justify-between bg-warn-soft border border-warn/20 rounded-[14px] px-4 py-3 hover:shadow-card transition-shadow"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Clock size={13} className="text-warn shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink truncate">{a.title}</p>
                    <p className="text-xs text-muted">{a.className}</p>
                  </div>
                </div>
                <div className="shrink-0 text-right ml-3">
                  <p className="text-xs font-medium text-warn">{formatDeadline(a.deadline)}</p>
                  <p className="text-xs text-muted font-mono">{pct}% done</p>
                </div>
              </Link>
            )
          })}
        </div>
      )}

      {/* Class list */}
      {isLoading ? (
        <Empty icon={BookOpen} message="Loading classes…" />
      ) : data?.length === 0 ? (
        <Empty icon={BookOpen} message="No classes yet — you'll be enrolled when you answer your first question." />
      ) : (
        <div className="space-y-3">
          {data?.map((enrollment) => {
            const { class: cls, section } = enrollment
            const isLive = cls.sessions.length > 0
            const dueCount = dueCountByClass[cls.id] ?? 0
            return (
              <Link
                key={cls.id}
                to={`/student/classes/${cls.id}`}
                className="block bg-surface border border-hairline rounded-[14px] px-5 py-4 hover:shadow-card transition-shadow"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-ink truncate">{cls.name}</p>
                    <p className="text-xs text-muted mt-0.5">
                      {cls.professor.name}
                      {section && <span> · Section {section.name}</span>}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {isLive && <Pill variant="live" dot>Live</Pill>}
                    {!isLive && dueCount > 0 && (
                      <Pill variant="warn">{dueCount} due</Pill>
                    )}
                  </div>
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
