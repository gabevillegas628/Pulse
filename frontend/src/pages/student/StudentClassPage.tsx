import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/api/client'
import { useStudentAuth } from '@/context/StudentAuthContext'
import TextbookPage from '@/pages/shared/TextbookPage'
import PulseMark from '@/components/ui/PulseMark'
import Pill from '@/components/ui/Pill'
import Tabs from '@/components/ui/Tabs'
import LiveDot from '@/components/ui/LiveDot'
import Empty from '@/components/ui/Empty'
import { BookOpen, ChevronLeft, Clock, KeyRound, LogOut } from 'lucide-react'
import type { AssignmentRow, GradeSession } from 'shared'
import PasswordChangeModal from '@/components/PasswordChangeModal'
import SessionGradeSheet from '@/components/SessionGradeSheet'

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

const CLASS_TABS = [
  { key: 'sessions',  label: 'Live Sessions' },
  { key: 'homework',  label: 'Homework' },
  { key: 'textbook',  label: 'Textbook' },
  { key: 'gradebook', label: 'Gradebook' },
] as const

// ─── Assignment link ───────────────────────────────────────────────────────────

function AssignmentLink({ a }: { a: AssignmentRow }) {
  const isPastDue = a.deadline && new Date(a.deadline) < new Date()
  const isComplete = a.submittedCount >= a.questionCount
  const isClosed = a.status === 'CLOSED' || a.status === 'ARCHIVED'
  return (
    <Link
      to={`/student/assignments/${a.id}`}
      className="flex items-center justify-between bg-surface border border-hairline rounded-[14px] p-5 hover:shadow-card transition-shadow"
    >
      <div>
        <p className="font-medium text-ink">{a.title}</p>
        {a.deadline && !isClosed && (
          <p className={`text-xs mt-0.5 flex items-center gap-1 ${isPastDue ? 'text-red-500' : 'text-muted'}`}>
            <Clock size={11} />
            {isPastDue ? 'Past due' : `Due ${new Date(a.deadline).toLocaleDateString()}`}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {isClosed && a.earnedScore !== null && a.maxScore !== null && (
          <span className="text-xs font-mono font-medium text-ink-2">{a.earnedScore.toFixed(1)}/{a.maxScore}</span>
        )}
        {isClosed && (a.earnedScore === null || a.maxScore === null) && (
          <Pill variant="muted">Closed</Pill>
        )}
        <Pill variant={isComplete ? 'good' : 'warn'}>
          {isComplete ? 'Done' : `${a.submittedCount}/${a.questionCount}`}
        </Pill>
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
  const [selectedSession, setSelectedSession] = useState<GradeSession | null>(null)

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

  const { data: enrollments } = useQuery<Enrollment[]>({
    queryKey: ['student-classes'],
    queryFn: () => api.get('/student/classes').then((r) => r.data.data.enrollments),
  })
  const enrollment = enrollments?.find((e) => e.class.id === classId)
  const cls = enrollment?.class

  const { data: assignmentData } = useQuery<{ assignments: AssignmentRow[] }>({
    queryKey: ['student-assignments', classId],
    queryFn: () => api.get(`/student/classes/${classId}/assignments`).then((r) => r.data.data),
    enabled: !!classId,
  })

  const { data: gradesData } = useQuery<{ sessions: GradeSession[]; totalEarned: number; totalMax: number }>({
    queryKey: ['student-grades', classId],
    queryFn: () => api.get(`/student/classes/${classId}/grades`).then((r) => r.data.data),
    enabled: !!classId,
  })

  const liveSessions = cls?.sessions ?? []
  const assignments = assignmentData?.assignments ?? []
  const openAssignments = assignments.filter((a) => a.status === 'OPEN')
  const pastAssignments = assignments.filter((a) => a.status === 'CLOSED' || a.status === 'ARCHIVED')

  // "Up next" = open assignment with the soonest deadline (or first without one)
  const upNext = openAssignments
    .filter((a) => a.deadline)
    .sort((a, b) => new Date(a.deadline!).getTime() - new Date(b.deadline!).getTime())[0]
    ?? openAssignments[0]

  // Standing breakdown by type
  const inClassSessions = gradesData?.sessions.filter((s) => s.type === 'IN_CLASS') ?? []
  const hwSessions = gradesData?.sessions.filter((s) => s.type === 'HOMEWORK') ?? []
  const inClassEarned = inClassSessions.reduce((sum, s) => sum + s.earned, 0)
  const inClassMax = inClassSessions.reduce((sum, s) => sum + s.max, 0)
  const hwEarned = hwSessions.reduce((sum, s) => sum + s.earned, 0)
  const hwMax = hwSessions.reduce((sum, s) => sum + s.max, 0)

  if (enrollments && !enrollment) {
    return (
      <div className="min-h-screen bg-canvas flex items-center justify-center text-muted">
        Class not found.
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-canvas">
      {/* Header */}
      <header className="bg-surface border-b border-hairline">
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between">
          <Link to="/student/classes" className="inline-flex items-center gap-2">
            <PulseMark size={20} />
            <span className="font-extrabold text-ink text-lg tracking-tight" style={{ letterSpacing: '-0.02em' }}>Pulse</span>
          </Link>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted font-mono">{student?.netId}</span>
            <button onClick={() => setShowPwModal(true)} className="text-muted hover:text-ink-2 transition-colors" title="Change password">
              <KeyRound size={15} />
            </button>
            <button
              onClick={() => { logout(); navigate('/login') }}
              className="flex items-center gap-1 text-sm text-muted hover:text-ink transition-colors"
            >
              <LogOut size={15} /> Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-8">
        {/* Back link */}
        <Link to="/student/classes" className="flex items-center gap-1 text-sm text-muted hover:text-ink mb-4 transition-colors">
          <ChevronLeft size={16} /> My Classes
        </Link>

        {/* Class header */}
        <div className="flex items-start justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-ink">{cls?.name ?? '…'}</h1>
            <p className="text-sm text-muted mt-0.5">
              {cls?.professor.name}
              {enrollment?.section && <span> · Section {enrollment.section.name}</span>}
            </p>
          </div>
          {liveSessions.length > 0 && (
            <Link
              to="/student/enter-code"
              className="inline-flex items-center gap-2 bg-signal text-white px-4 py-2 rounded-sm text-sm font-bold hover:bg-[var(--signal-bright)] transition-colors"
            >
              <LiveDot className="bg-white" /> Enter code
            </Link>
          )}
        </div>

        {/* Tabs */}
        <Tabs
          tabs={CLASS_TABS as unknown as { key: string; label: string }[]}
          active={tab}
          onChange={(k) => setTab(k as Tab)}
          className="mb-6"
        />

        {/* Live Sessions tab */}
        {tab === 'sessions' && (
          <div className="space-y-4">
            {/* Live now */}
            {liveSessions.length > 0 ? (
              liveSessions.map((s) => (
                <div key={s.id} className="flex items-center justify-between bg-signal-soft border border-signal/20 rounded-[14px] p-5">
                  <div>
                    <div className="flex items-center gap-2 mb-0.5">
                      <LiveDot />
                      <span className="text-xs font-bold text-signal uppercase tracking-wide">Live now</span>
                    </div>
                    <p className="font-medium text-ink">{s.title}</p>
                  </div>
                  <Link
                    to="/student/enter-code"
                    className="inline-flex items-center gap-2 bg-signal text-white px-4 py-2 rounded-sm text-sm font-bold hover:bg-[var(--signal-bright)] transition-colors shrink-0"
                  >
                    Answer ▸
                  </Link>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted">No live session right now — your professor will start one in class.</p>
            )}

            {/* Up next */}
            {upNext && (() => {
              const isPastDue = upNext.deadline && new Date(upNext.deadline) < new Date()
              const pct = upNext.questionCount > 0
                ? Math.round((upNext.submittedCount / upNext.questionCount) * 100)
                : 0
              return (
                <Link to={`/student/assignments/${upNext.id}`} className="block bg-surface border border-hairline rounded-[14px] p-5 hover:shadow-card transition-shadow">
                  <div className="flex items-center justify-between gap-3 mb-3">
                    <p className="text-sm font-semibold text-ink">Up next · {upNext.title}</p>
                    {upNext.deadline && (
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${
                        isPastDue
                          ? 'bg-red-50 text-red-600 border-red-200'
                          : 'bg-warn-soft text-warn border-warn/20'
                      }`}>
                        {isPastDue ? 'Past due' : `Due ${new Date(upNext.deadline).toLocaleDateString()}`}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center justify-between text-xs text-muted mb-1.5">
                    <span>{upNext.submittedCount} of {upNext.questionCount} answered</span>
                    <span className="font-mono font-medium text-ink">{pct}%</span>
                  </div>
                  <div className="h-1.5 bg-surface-2 rounded-full overflow-hidden">
                    <div className="h-full bg-signal rounded-full transition-all" style={{ width: `${pct}%` }} />
                  </div>
                </Link>
              )
            })()}

            {/* Your standing */}
            {gradesData && gradesData.totalMax > 0 && (() => {
              const pct = Math.round((gradesData.totalEarned / gradesData.totalMax) * 100)
              const barColor = pct >= 70 ? 'bg-good' : pct >= 50 ? 'bg-warn' : 'bg-red-500'
              return (
                <div className="bg-surface border border-hairline rounded-[14px] p-5">
                  <div className="flex items-center justify-between gap-3 mb-3">
                    <p className="text-sm font-semibold text-ink">Your standing</p>
                    <span className={`text-lg font-bold font-mono ${pct >= 70 ? 'text-good' : pct >= 50 ? 'text-warn' : 'text-red-500'}`}>
                      {gradesData.totalEarned}<span className="text-muted font-normal text-sm"> / {gradesData.totalMax}</span>
                    </span>
                  </div>
                  <div className="h-1.5 bg-surface-2 rounded-full overflow-hidden mb-3">
                    <div className={`h-full ${barColor} rounded-full transition-all`} style={{ width: `${pct}%` }} />
                  </div>
                  <p className="text-xs text-muted">
                    {inClassMax > 0 && `Openers ${inClassEarned}/${inClassMax}`}
                    {inClassMax > 0 && hwMax > 0 && ' · '}
                    {hwMax > 0 && `Homework ${hwEarned}/${hwMax}`}
                  </p>
                </div>
              )
            })()}

            {/* Pure empty state — nothing live, no open HW, no grades yet */}
            {liveSessions.length === 0 && !upNext && (!gradesData || gradesData.totalMax === 0) && (
              <Empty icon={BookOpen} message="No live session right now — your professor will start one in class." />
            )}
          </div>
        )}

        {/* Homework tab */}
        {tab === 'homework' && (
          !assignmentData ? (
            <Empty icon={BookOpen} message="Loading assignments…" />
          ) : assignments.length === 0 ? (
            <Empty icon={BookOpen} message="No assignments yet." />
          ) : (
            <div className="space-y-6">
              {openAssignments.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-muted uppercase tracking-wide mb-3">Open</p>
                  <div className="space-y-3">
                    {openAssignments.map((a) => <AssignmentLink key={a.id} a={a} />)}
                  </div>
                </div>
              )}
              {pastAssignments.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-muted uppercase tracking-wide mb-3">Past</p>
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
            <Empty icon={BookOpen} message="No textbook linked to this class yet." />
          ) : (
            <div
              className="border border-hairline rounded-[14px] overflow-hidden flex"
              style={{ height: 'calc(100vh - 340px)', minHeight: '480px' }}
            >
              <TextbookPage repo={cls.textbookRepo} path={cls.textbookPath ?? ''} classId={classId} />
            </div>
          )
        )}

        {/* Gradebook tab */}
        {tab === 'gradebook' && (
          !gradesData ? (
            <Empty message="Loading grades…" />
          ) : gradesData.sessions.length === 0 ? (
            <Empty message="No graded sessions yet." />
          ) : (() => {
            const pct = gradesData.totalMax > 0
              ? Math.round((gradesData.totalEarned / gradesData.totalMax) * 100)
              : null

            const renderGroup = (items: typeof gradesData.sessions) => (
              <div className="bg-surface border border-hairline rounded-[14px] overflow-hidden">
                {items.map((s, i) => (
                  <button
                    key={s.id}
                    onClick={() => setSelectedSession(s)}
                    className={`w-full flex items-center justify-between px-5 py-3.5 text-left hover:bg-surface-2 transition-colors ${
                      i < items.length - 1 ? 'border-b border-hairline' : ''
                    }`}
                  >
                    <p className="text-sm text-ink-2">{s.title}</p>
                    <p className="text-sm font-mono font-medium text-ink shrink-0">{s.earned}/{s.max}</p>
                  </button>
                ))}
              </div>
            )

            return (
              <div className="space-y-5">
                {/* Standing headline */}
                <div className="bg-surface border border-hairline rounded-[14px] px-5 py-4 flex items-center justify-between">
                  <div>
                    <p className="text-xs font-medium text-muted uppercase tracking-wide mb-1">Current standing</p>
                    <p className="text-2xl font-bold font-mono text-ink">
                      {gradesData.totalEarned}<span className="text-muted font-normal">/{gradesData.totalMax}</span>
                    </p>
                  </div>
                  {pct !== null && (
                    <div className="text-right">
                      <p className={`text-3xl font-bold font-mono ${pct >= 70 ? 'text-good' : pct >= 50 ? 'text-warn' : 'text-red-500'}`}>
                        {pct}%
                      </p>
                    </div>
                  )}
                </div>

                {inClassSessions.length > 0 && (
                  <div>
                    <p className="flex items-center gap-1.5 text-xs font-medium text-muted uppercase tracking-wide mb-2">
                      <LiveDot className="w-[5px] h-[5px]" /> Live Sessions
                    </p>
                    {renderGroup(inClassSessions)}
                  </div>
                )}
                {hwSessions.length > 0 && (
                  <div>
                    <p className="flex items-center gap-1.5 text-xs font-medium text-muted uppercase tracking-wide mb-2">
                      <BookOpen size={12} /> Homework
                    </p>
                    {renderGroup(hwSessions)}
                  </div>
                )}
              </div>
            )
          })()
        )}
      </main>

      {selectedSession && (
        <SessionGradeSheet session={selectedSession} onClose={() => setSelectedSession(null)} />
      )}

      <PasswordChangeModal
        endpoint="/student/me/password"
        open={showPwModal}
        onClose={() => setShowPwModal(false)}
      />
    </div>
  )
}
