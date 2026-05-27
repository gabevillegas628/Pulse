import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/api/client'
import { useStudentAuth } from '@/context/StudentAuthContext'
import TextbookPage from '@/pages/shared/TextbookPage'
import { BookOpen, ChevronLeft, Clock, KeyRound, LogOut, Radio } from 'lucide-react'
import type { AssignmentRow, GradeSession } from 'shared'
import PasswordChangeModal from '@/components/PasswordChangeModal'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ClassInfo {
  id: string
  name: string
  textbookRepo: string | null
  textbookPath: string | null
  professor: { name: string }
  sessions: Array<{ id: string; title: string; status: string }>
}

interface Enrollment {
  section: { id: string; name: string } | null
  class: ClassInfo
}

type Tab = 'sessions' | 'homework' | 'textbook' | 'gradebook'

// ─── Assignment link ───────────────────────────────────────────────────────────

function AssignmentLink({ a }: { a: AssignmentRow }) {
  const isPastDue = a.deadline && new Date(a.deadline) < new Date()
  const isComplete = a.submittedCount >= a.questionCount
  const isClosed = a.status === 'CLOSED' || a.status === 'ARCHIVED'
  return (
    <Link
      to={`/student/assignments/${a.id}`}
      className="flex items-center justify-between bg-white border border-gray-200 rounded-xl p-5 hover:shadow-sm transition-shadow"
    >
      <div>
        <p className="font-medium text-gray-900">{a.title}</p>
        {a.deadline && !isClosed && (
          <p className={`text-xs mt-0.5 flex items-center gap-1 ${isPastDue ? 'text-red-500' : 'text-gray-400'}`}>
            <Clock size={11} />
            {isPastDue ? 'Past due' : `Due ${new Date(a.deadline).toLocaleDateString()}`}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {isClosed && a.earnedScore !== null && a.maxScore !== null && (
          <span className="text-xs font-medium text-gray-700">{a.earnedScore.toFixed(1)}/{a.maxScore}</span>
        )}
        {isClosed && (a.earnedScore === null || a.maxScore === null) && (
          <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">Closed</span>
        )}
        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
          isComplete ? 'bg-green-100 text-green-700' : 'bg-yellow-50 text-yellow-700'
        }`}>
          {isComplete ? 'Done' : `${a.submittedCount}/${a.questionCount}`}
        </span>
      </div>
    </Link>
  )
}

// ─── Main page ─────────────────────────────────────────────────────────────────

export default function StudentClassPage() {
  const { classId } = useParams<{ classId: string }>()
  const navigate = useNavigate()
  const { student, logout } = useStudentAuth()
  const [tab, setTab] = useState<Tab>('sessions')
  const [showPwModal, setShowPwModal] = useState(false)

  // Block copy/paste for academic integrity (matches StudentLayout)
  useEffect(() => {
    const block = (e: Event) => e.preventDefault()
    document.addEventListener('paste', block)
    document.addEventListener('contextmenu', block)
    return () => {
      document.removeEventListener('paste', block)
      document.removeEventListener('contextmenu', block)
    }
  }, [])

  // Pull class info from the cached enrollment list
  const { data: enrollments } = useQuery<Enrollment[]>({
    queryKey: ['student-classes'],
    queryFn: () => api.get('/student/classes').then((r) => r.data.data.enrollments),
  })
  const enrollment = enrollments?.find((e) => e.class.id === classId)
  const cls = enrollment?.class

  const { data: assignmentData } = useQuery<{ assignments: AssignmentRow[] }>({
    queryKey: ['student-assignments', classId],
    queryFn: () => api.get(`/student/classes/${classId}/assignments`).then((r) => r.data.data),
    enabled: !!classId && tab === 'homework',
  })

  const { data: gradesData } = useQuery<{ sessions: GradeSession[]; totalEarned: number; totalMax: number }>({
    queryKey: ['student-grades', classId],
    queryFn: () => api.get(`/student/classes/${classId}/grades`).then((r) => r.data.data),
    enabled: !!classId && tab === 'gradebook',
  })

  const liveSessions = cls?.sessions ?? []
  const assignments = assignmentData?.assignments ?? []
  const openAssignments = assignments.filter((a) => a.status === 'OPEN')
  const pastAssignments = assignments.filter((a) => a.status === 'CLOSED' || a.status === 'ARCHIVED')

  if (enrollments && !enrollment) {
    return <div className="min-h-screen bg-gray-50 flex items-center justify-center text-gray-400">Class not found.</div>
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header — matches ProfessorLayout */}
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between">
          <Link to="/student/classes" className="font-semibold text-primary-700 text-lg tracking-tight">
            Pulse
          </Link>
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-500">{student?.netId}</span>
            <button onClick={() => setShowPwModal(true)} className="text-gray-400 hover:text-gray-600" title="Change password">
              <KeyRound size={15} />
            </button>
            <button
              onClick={() => { logout(); navigate('/login') }}
              className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800 transition-colors"
            >
              <LogOut size={15} /> Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-8">
        {/* Back link */}
        <Link to="/student/classes" className="flex items-center gap-1 text-sm text-gray-400 hover:text-gray-600 mb-4">
          <ChevronLeft size={16} /> My Classes
        </Link>

        {/* Class header */}
        <div className="flex items-start justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{cls?.name ?? '…'}</h1>
            <p className="text-sm text-gray-500 mt-0.5">
              {cls?.professor.name}
              {enrollment?.section && <span> · Section {enrollment.section.name}</span>}
            </p>
          </div>
          {liveSessions.length > 0 && (
            <Link
              to="/student/enter-code"
              className="flex items-center gap-2 bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-700 transition-colors"
            >
              <Radio size={15} className="animate-pulse" /> Enter code
            </Link>
          )}
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mb-6 border-b border-gray-200">
          {([
            { key: 'sessions', label: 'Live Sessions' },
            { key: 'homework', label: 'Homework' },
            { key: 'textbook', label: 'Textbook' },
            { key: 'gradebook', label: 'Gradebook' },
          ] as const).map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                tab === key
                  ? 'border-primary-600 text-primary-700'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Live Sessions tab */}
        {tab === 'sessions' && (
          liveSessions.length === 0 ? (
            <div className="text-center py-16 text-gray-400">
              <Radio size={32} className="mx-auto mb-3 text-gray-300" />
              <p className="text-sm">No live session right now.</p>
              <p className="text-xs mt-1">Your professor will start one in class.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {liveSessions.map((s) => (
                <div key={s.id} className="flex items-center justify-between bg-white border border-green-200 rounded-xl p-5">
                  <div>
                    <div className="flex items-center gap-2 mb-0.5">
                      <Radio size={13} className="text-green-600 animate-pulse" />
                      <span className="text-xs font-medium text-green-600 uppercase tracking-wide">Live now</span>
                    </div>
                    <p className="font-medium text-gray-900">{s.title}</p>
                  </div>
                  <Link
                    to="/student/enter-code"
                    className="flex items-center gap-2 bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-700 transition-colors shrink-0"
                  >
                    Enter code
                  </Link>
                </div>
              ))}
            </div>
          )
        )}

        {/* Homework tab */}
        {tab === 'homework' && (
          !assignmentData ? (
            <p className="text-gray-400 text-center py-8">Loading…</p>
          ) : assignments.length === 0 ? (
            <div className="text-center py-16 text-gray-400">
              <p className="text-sm">No assignments yet.</p>
            </div>
          ) : (
            <div className="space-y-6">
              {openAssignments.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-3">Open</p>
                  <div className="space-y-3">
                    {openAssignments.map((a) => <AssignmentLink key={a.id} a={a} />)}
                  </div>
                </div>
              )}
              {pastAssignments.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-3">Past</p>
                  <div className="space-y-3">
                    {pastAssignments.map((a) => <AssignmentLink key={a.id} a={a} />)}
                  </div>
                </div>
              )}
            </div>
          )
        )}

        {/* Textbook tab */}
        {tab === 'textbook' && (
          !cls?.textbookRepo ? (
            <div className="text-center py-16 text-gray-400">
              <BookOpen size={32} className="mx-auto mb-3 text-gray-300" />
              <p className="text-sm">No textbook linked to this class yet.</p>
            </div>
          ) : (
            <div
              className="border border-gray-200 rounded-xl overflow-hidden flex"
              style={{ height: 'calc(100vh - 340px)', minHeight: '480px' }}
            >
              <TextbookPage repo={cls.textbookRepo} path={cls.textbookPath ?? ''} classId={classId} />
            </div>
          )
        )}

        {/* Gradebook tab */}
        {tab === 'gradebook' && (
          !gradesData ? (
            <p className="text-gray-400 text-center py-8">Loading…</p>
          ) : gradesData.sessions.length === 0 ? (
            <div className="text-center py-16 text-gray-400">
              <p className="text-sm">No graded sessions yet.</p>
            </div>
          ) : (() => {
            const liveSessions = gradesData.sessions.filter((s) => s.type === 'IN_CLASS')
            const hwSessions = gradesData.sessions.filter((s) => s.type === 'HOMEWORK')
            const renderGroup = (items: typeof gradesData.sessions) => (
              <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                {items.map((s, i) => (
                  <div
                    key={s.id}
                    className={`flex items-center justify-between px-5 py-3.5 ${
                      i < items.length - 1 ? 'border-b border-gray-100' : ''
                    }`}
                  >
                    <p className="text-sm text-gray-700">{s.title}</p>
                    <p className="text-sm font-medium text-gray-900 shrink-0">{s.earned}/{s.max}</p>
                  </div>
                ))}
              </div>
            )
            return (
              <div className="space-y-5">
                {liveSessions.length > 0 && (
                  <div>
                    <p className="flex items-center gap-1.5 text-xs font-medium text-gray-400 uppercase tracking-wide mb-2">
                      <Radio size={12} /> Live Sessions
                    </p>
                    {renderGroup(liveSessions)}
                  </div>
                )}
                {hwSessions.length > 0 && (
                  <div>
                    <p className="flex items-center gap-1.5 text-xs font-medium text-gray-400 uppercase tracking-wide mb-2">
                      <BookOpen size={12} /> Homework
                    </p>
                    {renderGroup(hwSessions)}
                  </div>
                )}
                {gradesData.sessions.length > 1 && (
                  <div className="flex items-center justify-between px-5 py-3.5 bg-gray-50 border border-gray-200 rounded-xl">
                    <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Total</p>
                    <p className="text-sm font-semibold text-gray-900">{gradesData.totalEarned}/{gradesData.totalMax}</p>
                  </div>
                )}
              </div>
            )
          })()
        )}
      </main>

      <PasswordChangeModal
        endpoint="/student/me/password"
        open={showPwModal}
        onClose={() => setShowPwModal(false)}
      />
    </div>
  )
}
