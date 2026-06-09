import { useState } from 'react'
import { Link, useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { api } from '@/api/client'
import ProfessorLayout from '@/components/layout/ProfessorLayout'
import Button from '@/components/ui/Button'
import Card from '@/components/ui/Card'
import Tabs from '@/components/ui/Tabs'
import Pill from '@/components/ui/Pill'
import CodeChip from '@/components/ui/CodeChip'
import Empty from '@/components/ui/Empty'
import { Plus, Trash2, X, ChevronLeft, ChevronDown, Download, KeyRound, Copy, Users, BookOpen, Settings, RefreshCw } from 'lucide-react'
import type { StudentStats, ActivitySession, GradebookSession, GradebookStudentRow } from 'shared'
import TextbookPage from '@/pages/shared/TextbookPage'
import GradebookTable from '@/components/GradebookTable'
import StudentSessionModal from '@/components/StudentSessionModal'
import StudentReportPanel from '@/components/StudentReportPanel'
import { apiError } from '@/lib/errors'
import { downloadCsv } from '@/lib/downloadCsv'


interface Assignment {
  id: string
  title: string
  status: string
  deadline: string | null
  _count?: { questions: number }
  questionCount?: number
}

const sessionCreateSchema = z.object({
  title: z.string().min(1, 'Title required'),
})
type SessionCreateData = z.infer<typeof sessionCreateSchema>

const assignmentSchema = z.object({
  title: z.string().min(1, 'Title required'),
  deadline: z.string().min(1, 'Deadline required'),
})
type AssignmentFormData = z.infer<typeof assignmentSchema>



interface Student {
  id: string
  netId: string
  name: string
  email: string
}

interface Section {
  id: string
  name: string
  joinCode: string
}

type PillVariant = 'live' | 'good' | 'warn' | 'muted'
function statusPill(status: string) {
  const map: Record<string, PillVariant> = {
    OPEN: 'good', DRAFT: 'warn', CLOSED: 'muted', ARCHIVED: 'muted',
  }
  return map[status] ?? 'muted'
}

const CLASS_TABS = [
  { key: 'sessions',     label: 'Sessions' },
  { key: 'assignments',  label: 'Assignments' },
  { key: 'grades',       label: 'Grades' },
  { key: 'roster',       label: 'Roster' },
  { key: 'textbook',     label: 'Textbook' },
] as const

export default function ClassPage() {
  const { classId } = useParams<{ classId: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [tab, setTab] = useState<'sessions' | 'assignments' | 'roster' | 'textbook' | 'grades'>('sessions')
  const [showTextbookSettings, setShowTextbookSettings] = useState(false)
  const [tbRepo, setTbRepo] = useState('')
  const [tbPath, setTbPath] = useState('')
  const [tbSaving, setTbSaving] = useState(false)
  const [tbError, setTbError] = useState('')
  const [showModal, setShowModal] = useState(false)
  const [createError, setCreateError] = useState('')
  const [showAssignmentModal, setShowAssignmentModal] = useState(false)
  const [assignmentError, setAssignmentError] = useState('')
  const [showDuplicateModal, setShowDuplicateModal] = useState(false)
  const [dupName, setDupName] = useState('')
  const [dupDescription, setDupDescription] = useState('')
  const [dupTransferQr, setDupTransferQr] = useState(true)
  const [dupError, setDupError] = useState('')
  const [dupLoading, setDupLoading] = useState(false)
  const [resetTarget, setResetTarget] = useState<Student | null>(null)
  const [newPassword, setNewPassword] = useState('')
  const [resetError, setResetError] = useState('')
  const [resetSuccess, setResetSuccess] = useState(false)
  const [expandedStudent, setExpandedStudent] = useState<string | null>(null)
  const [activityCache, setActivityCache] = useState<Record<string, ActivitySession[]>>({})
  const [showAddSection, setShowAddSection] = useState(false)
  const [newSectionName, setNewSectionName] = useState('')
  const [sectionLoading, setSectionLoading] = useState(false)
  const [selectedCell, setSelectedCell] = useState<{ studentId: string; sessionId: string } | null>(null)
  const [selectedStudent, setSelectedStudent] = useState<{ studentId: string; netId: string } | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['class', classId],
    queryFn: () => api.get(`/classes/${classId}`).then((r) => r.data.data.class),
  })

  const { data: rosterData } = useQuery({
    queryKey: ['roster', classId],
    queryFn: () => api.get(`/classes/${classId}/enrollments`).then((r) => r.data.data.enrollments),
    enabled: tab === 'roster',
  })

  const { data: sectionsData } = useQuery<Section[]>({
    queryKey: ['sections', classId],
    queryFn: () => api.get(`/classes/${classId}/sections`).then((r) => r.data.data.sections),
  })

  type SessionRun = { id: string; status: string; sectionId: string | null; openedAt: string; closedAt: string | null; section?: { id: string; name: string } | null }
  type SessionRow = { id: string; title: string; status: string; isLive: boolean; runs: SessionRun[]; questions: Array<{ id: string }>; createdAt: string; respondentCount: number }
  const { data: sessionsResult } = useQuery<{ sessions: SessionRow[]; enrolledCount: number }>({
    queryKey: ['sessions', classId],
    queryFn: () => api.get(`/classes/${classId}/sessions`).then((r) => r.data.data),
    enabled: tab === 'sessions',
  })
  const sessionsData = sessionsResult?.sessions
  const enrolledCount = sessionsResult?.enrolledCount ?? 0

  const { data: assignmentsData } = useQuery<Assignment[]>({
    queryKey: ['assignments', classId],
    queryFn: () => api.get(`/classes/${classId}/assignments`).then((r) => r.data.data.assignments),
    enabled: tab === 'assignments',
  })

  const { data: gradebookData } = useQuery<{ sessions: GradebookSession[]; students: GradebookStudentRow[] }>({
    queryKey: ['gradebook', classId],
    queryFn: () => api.get(`/classes/${classId}/grades/json`).then((r) => r.data.data),
    enabled: tab === 'grades',
  })

  const { data: textbookViewsData } = useQuery<{ views: { chapterFilename: string; count: number }[] }>({
    queryKey: ['textbook-views', classId],
    queryFn: () => api.get(`/classes/${classId}/textbook-views`).then((r) => r.data.data),
    enabled: tab === 'textbook',
  })
  const viewCounts: Record<string, number> = Object.fromEntries(
    (textbookViewsData?.views ?? []).map((v) => [v.chapterFilename, v.count])
  )

  const sections = sectionsData ?? []

  async function addSection(e: React.FormEvent) {
    e.preventDefault()
    if (!newSectionName.trim()) return
    setSectionLoading(true)
    try {
      await api.post(`/classes/${classId}/sections`, { name: newSectionName.trim() })
      qc.invalidateQueries({ queryKey: ['sections', classId] })
      setNewSectionName('')
      setShowAddSection(false)
    } finally {
      setSectionLoading(false)
    }
  }

  async function assignSection(studentId: string, sectionId: string | null) {
    await api.patch(`/classes/${classId}/enrollments/${studentId}/section`, { sectionId })
    qc.invalidateQueries({ queryKey: ['roster', classId] })
  }

  const refreshTextbookMutation = useMutation({
    mutationFn: () => api.delete('/textbook/cache'),
    onSuccess: () => qc.removeQueries({ queryKey: ['textbook-chapter'] }),
  })

  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm<SessionCreateData>({
    resolver: zodResolver(sessionCreateSchema),
    defaultValues: { title: '' },
  })

  const createMutation = useMutation({
    mutationFn: (body: SessionCreateData) =>
      api.post(`/classes/${classId}/sessions`, { title: body.title }),
    onSuccess: (res) => {
      // Invalidate so ClassPage and Dashboard both show fresh data on return
      qc.invalidateQueries({ queryKey: ['sessions', classId] })
      qc.invalidateQueries({ queryKey: ['classes'] })
      setShowModal(false)
      reset()
      navigate(`/professor/sessions/${res.data.data.session.id}`)
    },
    onError: (e: unknown) => {
      setCreateError(apiError(e, 'Failed to create session'))
    },
  })

  const {
    register: regHw,
    handleSubmit: handleHwSubmit,
    reset: resetHw,
    formState: { errors: hwErrors, isSubmitting: hwSubmitting },
  } = useForm<AssignmentFormData>({
    resolver: zodResolver(assignmentSchema),
    defaultValues: { title: '', deadline: '' },
  })

  const createAssignmentMutation = useMutation({
    mutationFn: (body: AssignmentFormData) =>
      api.post(`/classes/${classId}/assignments`, {
        title: body.title,
        deadline: new Date(body.deadline).toISOString(),
      }),
    onSuccess: (res) => {
      setShowAssignmentModal(false)
      resetHw()
      qc.invalidateQueries({ queryKey: ['assignments', classId] })
      qc.invalidateQueries({ queryKey: ['class', classId] })
      navigate(`/professor/classes/${classId}/assignments/${res.data.data.assignment.id}`)
    },
    onError: (e: unknown) => {
      setAssignmentError(apiError(e, 'Failed to create assignment'))
    },
  })

  const deleteSessionMutation = useMutation({
    mutationFn: (sessionId: string) => api.delete(`/sessions/${sessionId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sessions', classId] })
      qc.invalidateQueries({ queryKey: ['class', classId] })
    },
  })

  const deleteAssignmentMutation = useMutation({
    mutationFn: (assignmentId: string) => api.delete(`/assignments/${assignmentId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['assignments', classId] })
      qc.invalidateQueries({ queryKey: ['class', classId] })
    },
  })

  const resetMutation = useMutation({
    mutationFn: ({ studentId, newPassword }: { studentId: string; newPassword: string }) =>
      api.post(`/classes/${classId}/students/${studentId}/reset-password`, { newPassword }),
    onSuccess: () => setResetSuccess(true),
    onError: (e: unknown) => {
      setResetError(apiError(e, 'Reset failed — try again'))
    },
  })

  function openReset(student: Student) {
    setResetTarget(student)
    setNewPassword('')
    setResetError('')
    setResetSuccess(false)
  }

  function closeReset() {
    setResetTarget(null)
    setNewPassword('')
    setResetError('')
    setResetSuccess(false)
  }

  function openDuplicate() {
    setDupName(data?.name ?? '')
    setDupDescription(data?.description ?? '')
    setDupTransferQr(true)
    setDupError('')
    setShowDuplicateModal(true)
  }

  async function submitDuplicate(e: React.FormEvent) {
    e.preventDefault()
    setDupError('')
    setDupLoading(true)
    try {
      const r = await api.post(`/classes/${classId}/duplicate`, {
        name: dupName,
        description: dupDescription || undefined,
        transferQrCodes: dupTransferQr,
      })
      const newClassId = r.data.data.class.id
      setShowDuplicateModal(false)
      qc.invalidateQueries({ queryKey: ['classes'] })
      navigate(`/professor/classes/${newClassId}`)
    } catch (err: unknown) {
      setDupError(apiError(err, 'Failed to duplicate class'))
    } finally {
      setDupLoading(false)
    }
  }

  async function saveTextbook(e: React.FormEvent) {
    e.preventDefault()
    setTbError('')
    setTbSaving(true)
    try {
      await api.patch(`/classes/${classId}`, {
        textbookRepo: tbRepo.trim() || null,
        textbookPath: tbPath.trim() || null,
      })
      qc.invalidateQueries({ queryKey: ['class', classId] })
      setShowTextbookSettings(false)
    } catch (err: unknown) {
      setTbError(apiError(err, 'Failed to save'))
    } finally {
      setTbSaving(false)
    }
  }

  if (isLoading) return <ProfessorLayout><Empty icon={BookOpen} message="Loading class…" /></ProfessorLayout>

  return (
    <ProfessorLayout>
      {/* Page header */}
      <div className="mb-6">
        <Link to="/professor" className="flex items-center gap-1 text-sm text-muted hover:text-ink mb-4 transition-colors">
          <ChevronLeft size={16} /> All classes
        </Link>
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold text-ink">{data?.name}</h1>
            {data?.description && <p className="text-muted text-sm mt-0.5">{data.description}</p>}
            <div className="flex items-center gap-2 mt-2">
              <span className="text-xs text-muted">Join code</span>
              <CodeChip>{data?.joinCode}</CodeChip>
            </div>

            {/* Sections */}
            <div className="flex flex-wrap items-center gap-2 mt-2">
              <Users size={13} className="text-muted shrink-0" />
              {sections.length === 0 ? (
                <span className="text-xs text-muted">No sections</span>
              ) : (
                sections.map((s) => (
                  <span key={s.id} className="text-xs bg-surface-2 px-2 py-0.5 rounded-sm font-medium text-ink-2">
                    {s.name} <span className="font-mono text-muted">{s.joinCode}</span>
                  </span>
                ))
              )}
              {showAddSection ? (
                <form onSubmit={addSection} className="flex items-center gap-1">
                  <input
                    value={newSectionName}
                    onChange={(e) => setNewSectionName(e.target.value)}
                    placeholder="e.g. 001"
                    className="border border-hairline rounded px-2 py-0.5 text-xs w-20 focus:outline-none focus:ring-1 focus:ring-signal bg-surface"
                    autoFocus
                  />
                  <button type="submit" disabled={sectionLoading || !newSectionName.trim()} className="text-xs text-signal hover:text-[var(--signal-bright)] disabled:opacity-50">Add</button>
                  <button type="button" onClick={() => { setShowAddSection(false); setNewSectionName('') }} className="text-xs text-muted hover:text-ink">Cancel</button>
                </form>
              ) : (
                <button onClick={() => setShowAddSection(true)} className="text-xs text-signal hover:text-[var(--signal-bright)] flex items-center gap-0.5 transition-colors">
                  <Plus size={12} /> Add section
                </button>
              )}
            </div>
          </div>

          {/* Toolbar */}
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={openDuplicate} title="Duplicate this class for a new semester">
              <Copy size={14} /> Duplicate
            </Button>
            <button
              onClick={() => downloadCsv(`/classes/${classId}/grades`, `grades-${classId}.csv`)}
              className="inline-flex items-center gap-1.5 bg-surface border border-hairline-strong text-ink-2 rounded-sm px-4 py-2 text-sm font-bold hover:bg-surface-2 transition-colors"
              title="Export class-wide grade CSV"
            >
              <Download size={14} /> Export Grades
            </button>
            {tab === 'sessions' && (
              <Button variant="primary" onClick={() => setShowModal(true)}>
                <Plus size={16} /> New session
              </Button>
            )}
            {tab === 'assignments' && (
              <Button variant="primary" onClick={() => { setAssignmentError(''); setShowAssignmentModal(true) }}>
                <Plus size={16} /> New assignment
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <Tabs
        tabs={CLASS_TABS as unknown as { key: string; label: string }[]}
        active={tab}
        onChange={(k) => setTab(k as typeof tab)}
        className="mb-6"
      />

      {/* Sessions tab */}
      {tab === 'sessions' && (
        !sessionsData ? (
          <Empty icon={BookOpen} message="Loading sessions…" />
        ) : sessionsData.length === 0 ? (
          <Empty icon={BookOpen} message="No sessions yet — create one to start collecting responses." />
        ) : (() => {
          const openSessions = sessionsData.filter((s) => s.isLive)
          const otherSessions = [...sessionsData.filter((s) => !s.isLive)].sort((a, b) => {
            const latestRun = (s: SessionRow) => {
              if (s.runs.length === 0) return s.createdAt
              const sorted = [...s.runs].sort((r1, r2) => new Date(r2.openedAt).getTime() - new Date(r1.openedAt).getTime())
              return sorted[0].closedAt ?? sorted[0].openedAt
            }
            return new Date(latestRun(b)).getTime() - new Date(latestRun(a)).getTime()
          })

          const sessionDate = (s: SessionRow) => {
            if (s.runs.length === 0) return { label: 'Created', date: new Date(s.createdAt) }
            const sorted = [...s.runs].sort((r1, r2) => new Date(r2.openedAt).getTime() - new Date(r1.openedAt).getTime())
            const latest = sorted[0]
            if (latest.closedAt) return { label: 'Closed', date: new Date(latest.closedAt) }
            return { label: 'Opened', date: new Date(latest.openedAt) }
          }

          // Derive display status for non-live sessions
          const sessionDisplayStatus = (s: SessionRow): string => {
            if (s.status === 'DRAFT') return 'DRAFT'
            if (s.status === 'ARCHIVED') return 'ARCHIVED'
            if (s.runs.length > 0) return 'CLOSED'
            return 'DRAFT'
          }

          return (
            <div className="space-y-4">
              {/* Live banners */}
              {openSessions.map((s) => (
                <div key={s.id} className="bg-signal-soft border border-signal/20 rounded-[14px] p-5 flex items-center justify-between gap-4">
                  <div>
                    <Pill variant="live" dot>Live</Pill>
                    <p className="font-semibold text-ink mt-1">{s.title}</p>
                    <p className="text-xs text-muted mt-0.5">
                      {s.questions?.length ?? 0} question{(s.questions?.length ?? 0) !== 1 ? 's' : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Link
                      to={`/professor/sessions/${s.id}`}
                      className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-2 bg-surface border border-hairline-strong px-4 py-2 rounded-sm hover:bg-surface-2 transition-colors"
                    >
                      Open monitor
                    </Link>
                    <Link
                      to={`/professor/sessions/${s.id}`}
                      className="inline-flex items-center gap-1.5 text-sm font-bold text-white bg-signal hover:bg-[var(--signal-bright)] px-4 py-2 rounded-sm transition-colors"
                    >
                      Resume ▸
                    </Link>
                  </div>
                </div>
              ))}

              {/* Session grid */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {otherSessions.map((s) => {
                  const { label, date } = sessionDate(s)
                  const qCount = s.questions?.length ?? 0
                  const pct = enrolledCount > 0 ? Math.round((s.respondentCount / enrolledCount) * 100) : null
                  return (
                    <div key={s.id} className="group relative bg-surface border border-hairline rounded-[14px] hover:shadow-card transition-shadow flex flex-col">
                      <Link to={`/professor/sessions/${s.id}`} className="flex-1 p-5 flex flex-col gap-3">
                        {/* Top row: status */}
                        <div className="flex items-center gap-2">
                          {(() => {
                            const displayStatus = sessionDisplayStatus(s)
                            return (
                              <Pill variant={statusPill(displayStatus)}>
                                {displayStatus.charAt(0) + displayStatus.slice(1).toLowerCase()}
                              </Pill>
                            )
                          })()}
                        </div>

                        {/* Title */}
                        <p className="font-semibold text-ink leading-snug">{s.title}</p>

                        {/* Footer stats */}
                        <div className="mt-auto flex items-end justify-between gap-2">
                          <div className="text-xs text-muted space-y-0.5">
                            <p>{qCount} question{qCount !== 1 ? 's' : ''}</p>
                            <p className="font-mono">{label} {date.toLocaleDateString([], { month: 'short', day: 'numeric', year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined })}</p>
                          </div>
                          {pct !== null && sessionDisplayStatus(s) !== 'DRAFT' && (
                            <span className="text-xs font-mono text-muted shrink-0">
                              {s.respondentCount}/{enrolledCount} · {pct}%
                            </span>
                          )}
                        </div>
                      </Link>

                      {/* Delete — hover only */}
                      <button
                        onClick={(e) => {
                          e.preventDefault()
                          if (!confirm(`Delete "${s.title}"? This will remove all responses and cannot be undone.`)) return
                          deleteSessionMutation.mutate(s.id)
                        }}
                        disabled={deleteSessionMutation.isPending}
                        className="opacity-0 group-hover:opacity-100 transition-opacity absolute top-3 right-3 w-7 h-7 flex items-center justify-center text-hairline-strong hover:text-red-500 hover:bg-surface-2 rounded-sm disabled:opacity-30"
                        title="Delete session"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })()
      )}

      {/* Assignments tab */}
      {tab === 'assignments' && (
        !assignmentsData ? (
          <Empty icon={BookOpen} message="Loading assignments…" />
        ) : assignmentsData.length === 0 ? (
          <Empty icon={BookOpen} message="No assignments yet — create one above." />
        ) : (
          <div className="space-y-3">
            {assignmentsData.map((a) => (
              <div key={a.id} className="group relative flex items-center bg-surface border border-hairline rounded-[14px] hover:shadow-card transition-shadow">
                <Link
                  to={`/professor/classes/${classId}/assignments/${a.id}`}
                  className="flex-1 flex items-center justify-between p-5"
                >
                  <div>
                    <p className="font-medium text-ink">{a.title}</p>
                    <p className="text-xs text-muted mt-0.5">
                      {(a._count?.questions ?? a.questionCount ?? 0)} question{(a._count?.questions ?? a.questionCount ?? 0) !== 1 ? 's' : ''}{a.deadline ? ` · Due ${new Date(a.deadline).toLocaleDateString()}` : ''}
                    </p>
                  </div>
                  <Pill variant={statusPill(a.status)}>
                    {a.status.charAt(0) + a.status.slice(1).toLowerCase()}
                  </Pill>
                </Link>
                <button
                  onClick={(e) => {
                    e.preventDefault()
                    if (!confirm(`Delete "${a.title}"? This will remove all student responses and cannot be undone.`)) return
                    deleteAssignmentMutation.mutate(a.id)
                  }}
                  disabled={deleteAssignmentMutation.isPending}
                  className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0 px-4 py-5 text-hairline-strong hover:text-red-500 disabled:opacity-30"
                  title="Delete assignment"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </div>
        )
      )}

      {/* Grades tab */}
      {tab === 'grades' && (
        !gradebookData ? (
          <Empty message="Loading grades…" />
        ) : (
          <>
            <GradebookTable
              sessions={gradebookData.sessions}
              students={gradebookData.students}
              onCellClick={(studentId, sessionId) => setSelectedCell({ studentId, sessionId })}
              onStudentClick={(studentId, netId) => setSelectedStudent({ studentId, netId })}
            />
            {selectedCell && (() => {
              const session = gradebookData.sessions.find((s) => s.id === selectedCell.sessionId)
              const student = gradebookData.students.find((s) => s.studentId === selectedCell.studentId)
              if (!session || !student) return null
              return (
                <StudentSessionModal
                  classId={classId!}
                  studentId={selectedCell.studentId}
                  netId={student.netId}
                  session={session}
                  onClose={() => setSelectedCell(null)}
                />
              )
            })()}
            {selectedStudent && (
              <StudentReportPanel
                classId={classId!}
                studentId={selectedStudent.studentId}
                netId={selectedStudent.netId}
                onClose={() => setSelectedStudent(null)}
              />
            )}
          </>
        )
      )}

      {/* Roster tab */}
      {tab === 'roster' && (
        !rosterData ? (
          <Empty icon={Users} message="Loading roster…" />
        ) : rosterData.length === 0 ? (
          <Empty icon={Users} message="No students enrolled yet." />
        ) : (
          <div className="bg-surface border border-hairline rounded-[14px] overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-hairline text-left">
                  <th className="px-5 py-3 text-xs font-medium text-muted uppercase tracking-wide">NetID</th>
                  <th className="px-5 py-3 text-xs font-medium text-muted uppercase tracking-wide">Email</th>
                  {sections.length > 0 && <th className="px-5 py-3 text-xs font-medium text-muted uppercase tracking-wide">Section</th>}
                  <th className="px-5 py-3 text-xs font-medium text-muted uppercase tracking-wide">Participation</th>
                  <th className="px-5 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {rosterData.map((e: { student: Student; stats: StudentStats; section: { id: string; name: string } | null }) => {
                  const isExpanded = expandedStudent === e.student.id
                  const activity = activityCache[e.student.id]

                  async function toggleExpand() {
                    if (isExpanded) { setExpandedStudent(null); return }
                    setExpandedStudent(e.student.id)
                    if (!activityCache[e.student.id]) {
                      const res = await api.get(`/classes/${classId}/students/${e.student.id}/activity`)
                      setActivityCache((prev) => ({ ...prev, [e.student.id]: res.data.data.sessions }))
                    }
                  }

                  return (
                    <>
                      <tr
                        key={e.student.id}
                        onClick={toggleExpand}
                        className="border-t border-hairline hover:bg-surface-2 cursor-pointer"
                      >
                        <td className="px-5 py-3.5 font-medium text-ink flex items-center gap-1.5">
                          <ChevronDown size={14} className={`text-hairline-strong transition-transform shrink-0 ${isExpanded ? 'rotate-180' : ''}`} />
                          {e.student.netId}
                        </td>
                        <td className="px-5 py-3.5 text-ink-2">{e.student.email}</td>
                        <td className="px-5 py-3.5 text-muted">{e.student.email}</td>
                        {sections.length > 0 && (
                          <td className="px-5 py-3.5" onClick={(ev) => ev.stopPropagation()}>
                            <select
                              value={e.section?.id ?? ''}
                              onChange={(ev) => assignSection(e.student.id, ev.target.value || null)}
                              className="text-xs border border-hairline rounded px-1.5 py-1 bg-surface text-ink-2 focus:outline-none focus:ring-1 focus:ring-signal"
                            >
                              <option value="">— unassigned</option>
                              {sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                            </select>
                          </td>
                        )}
                        <td className="px-5 py-3.5 text-ink-2">
                          {e.stats.totalClosedSessions > 0 ? (
                            <span className={e.stats.sessionsParticipated === 0 ? 'text-muted' : ''}>
                              {e.stats.sessionsParticipated}/{e.stats.totalClosedSessions} sessions
                            </span>
                          ) : (
                            <span className="text-hairline-strong">—</span>
                          )}
                        </td>
                        <td className="px-5 py-3.5 text-right" onClick={(ev) => ev.stopPropagation()}>
                          <button
                            onClick={() => openReset(e.student)}
                            className="flex items-center gap-1.5 text-xs text-muted hover:text-signal ml-auto transition-colors"
                          >
                            <KeyRound size={13} /> Reset password
                          </button>
                        </td>
                      </tr>

                      {isExpanded && (
                        <tr key={`${e.student.id}-detail`} className="border-t border-hairline bg-surface-2">
                          <td colSpan={sections.length > 0 ? 6 : 5} className="px-5 py-4">
                            {!activity ? (
                              <p className="text-xs text-muted">Loading…</p>
                            ) : activity.length === 0 ? (
                              <p className="text-xs text-muted">No sessions yet.</p>
                            ) : (
                              <div className="space-y-3">
                                {activity.map((session) => (
                                  <div key={session.id}>
                                    <div className="flex items-center gap-2 mb-1.5">
                                      <span className="text-xs font-medium text-ink-2">{session.title}</span>
                                      <Pill variant={statusPill(session.status)}>
                                        {session.status.charAt(0) + session.status.slice(1).toLowerCase()}
                                      </Pill>
                                    </div>
                                    <div className="flex flex-wrap gap-2">
                                      {session.questions.map((q) => (
                                        <span
                                          key={q.id}
                                          title={q.text + (q.response ? `\n"${q.response.responseText}"` : '')}
                                          className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border ${
                                            q.response
                                              ? 'border-good/30 bg-good-soft text-good'
                                              : 'border-hairline bg-surface text-muted'
                                          }`}
                                        >
                                          Q{q.number} {q.response ? '✓' : '—'}
                                          {q.response && q.type === 'FREE_TEXT' && (
                                            <span className="text-good">{q.response.wordCount}w</span>
                                          )}
                                        </span>
                                      ))}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </>
                  )
                })}
              </tbody>
            </table>
          </div>
        )
      )}

      {/* Textbook tab */}
      {tab === 'textbook' && (() => {
        const repo = data?.textbookRepo ?? ''
        const path = data?.textbookPath ?? ''

        if (showTextbookSettings || !repo) {
          return (
            <div className="max-w-lg">
              <h2 className="text-base font-semibold text-ink mb-1">
                {repo ? 'Edit textbook' : 'Link a textbook'}
              </h2>
              <p className="text-sm text-muted mb-5">
                Point to a public GitHub repo containing <code className="bg-surface-2 px-1 rounded">.md</code> chapter files.
                The chapter list is read from the GitHub Contents API.
              </p>
              <form onSubmit={saveTextbook} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-ink-2 mb-1">
                    GitHub repo <span className="text-muted font-normal">(owner/repo)</span>
                  </label>
                  <input
                    value={tbRepo}
                    onChange={(e) => setTbRepo(e.target.value)}
                    placeholder="gabevillegas628/BiochemistryLifeSci"
                    className="w-full border border-hairline rounded-sm px-3 py-2.5 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-signal"
                    autoFocus
                    onFocus={() => { if (!tbRepo && repo) setTbRepo(repo) }}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-ink-2 mb-1">
                    Sub-folder <span className="text-muted font-normal">(leave blank if .md files are at the root)</span>
                  </label>
                  <input
                    value={tbPath}
                    onChange={(e) => setTbPath(e.target.value)}
                    placeholder="chapters"
                    className="w-full border border-hairline rounded-sm px-3 py-2.5 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-signal"
                    onFocus={() => { if (!tbPath && path) setTbPath(path) }}
                  />
                </div>
                {tbError && <p className="text-red-500 text-sm">{tbError}</p>}
                <div className="flex items-center gap-3 pt-1">
                  {repo && (
                    <button type="button" onClick={() => setShowTextbookSettings(false)} className="text-sm text-muted hover:text-ink transition-colors">
                      Cancel
                    </button>
                  )}
                  <Button type="submit" variant="primary" disabled={tbSaving || !tbRepo.trim()}>
                    {tbSaving ? 'Saving…' : repo ? 'Save changes' : 'Link textbook'}
                  </Button>
                  {repo && (
                    <button
                      type="button"
                      disabled={tbSaving}
                      onClick={async () => {
                        setTbSaving(true)
                        try {
                          await api.patch(`/classes/${classId}`, { textbookRepo: null, textbookPath: null })
                          qc.invalidateQueries({ queryKey: ['class', classId] })
                          setShowTextbookSettings(false)
                        } finally { setTbSaving(false) }
                      }}
                      className="ml-auto text-sm text-red-400 hover:text-red-600 disabled:opacity-50 transition-colors"
                    >
                      Remove textbook
                    </button>
                  )}
                </div>
              </form>
            </div>
          )
        }

        return (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm text-muted">
                <BookOpen size={14} />
                <span className="font-mono text-ink-2">{repo}</span>
                {path && <span className="text-muted">/{path}</span>}
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => refreshTextbookMutation.mutate()}
                  disabled={refreshTextbookMutation.isPending}
                  className="flex items-center gap-1.5 text-sm text-muted hover:text-ink disabled:opacity-50 transition-colors"
                  title="Clears the server cache so students see the latest version from GitHub"
                >
                  <RefreshCw size={13} className={refreshTextbookMutation.isPending ? 'animate-spin' : ''} />
                  {refreshTextbookMutation.isPending ? 'Refreshing…' : refreshTextbookMutation.isSuccess ? 'Refreshed!' : 'Reload from GitHub'}
                </button>
                <button
                  onClick={() => { setTbRepo(repo); setTbPath(path); setShowTextbookSettings(true) }}
                  className="flex items-center gap-1.5 text-sm text-muted hover:text-ink transition-colors"
                >
                  <Settings size={13} /> Edit
                </button>
              </div>
            </div>
            <div
              className="border border-hairline rounded-[14px] overflow-hidden flex"
              style={{ height: 'calc(100vh - 400px)', minHeight: '480px' }}
            >
              <TextbookPage repo={repo} path={path} classId={classId} viewCounts={viewCounts} />
            </div>
          </div>
        )
      })()}

      {/* Create session modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
          <Card flat className="w-full max-w-sm p-6 shadow-pop">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-base font-semibold text-ink">New session</h2>
              <button onClick={() => { setShowModal(false); reset() }} className="text-muted hover:text-ink-2 transition-colors">
                <X size={18} />
              </button>
            </div>
            <form onSubmit={handleSubmit((d) => { setCreateError(''); createMutation.mutate(d) })} className="space-y-4">
              <input
                {...register('title')}
                placeholder="Week 3 Opener"
                className="w-full border border-hairline rounded-sm px-3 py-2.5 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-signal"
                autoFocus
              />
              {errors.title && <p className="text-red-500 text-xs">{errors.title.message}</p>}
              {createError && <p className="text-red-500 text-sm">{createError}</p>}
              <div className="flex justify-end gap-3">
                <button type="button" onClick={() => { setShowModal(false); reset() }} className="px-4 py-2 text-sm text-muted hover:text-ink transition-colors">
                  Cancel
                </button>
                <Button type="submit" variant="primary" disabled={isSubmitting}>
                  {isSubmitting ? 'Creating…' : 'Create & open'}
                </Button>
              </div>
            </form>
          </Card>
        </div>
      )}

      {/* Reset password modal */}
      {resetTarget && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
          <Card flat className="w-full max-w-sm p-6 shadow-pop">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold text-ink">Reset password</h2>
              <button onClick={closeReset} className="text-muted hover:text-ink-2 transition-colors"><X size={18} /></button>
            </div>

            {resetSuccess ? (
              <div className="text-center py-4">
                <p className="text-good font-medium mb-1">Password updated</p>
                <p className="text-sm text-muted mb-5">{resetTarget.netId}'s password has been reset.</p>
                <button onClick={closeReset} className="text-sm text-signal hover:underline">Close</button>
              </div>
            ) : (
              <>
                <p className="text-sm text-muted mb-4">
                  Setting a new password for <span className="font-medium text-ink">{resetTarget.netId}</span>
                </p>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="New password (min 8 chars)"
                  className="w-full border border-hairline rounded-sm px-3 py-2.5 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-signal mb-3"
                  autoFocus
                />
                {resetError && <p className="text-red-500 text-xs mb-3">{resetError}</p>}
                <div className="flex justify-end gap-3">
                  <button onClick={closeReset} className="px-4 py-2 text-sm text-muted hover:text-ink transition-colors">Cancel</button>
                  <Button
                    variant="primary"
                    onClick={() => resetMutation.mutate({ studentId: resetTarget.id, newPassword })}
                    disabled={newPassword.length < 8 || resetMutation.isPending}
                  >
                    {resetMutation.isPending ? 'Saving…' : 'Save'}
                  </Button>
                </div>
              </>
            )}
          </Card>
        </div>
      )}

      {/* Create assignment modal */}
      {showAssignmentModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
          <Card flat className="w-full max-w-md p-6 shadow-pop">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-lg font-semibold text-ink">New assignment</h2>
              <button onClick={() => { setShowAssignmentModal(false); resetHw() }} className="text-muted hover:text-ink-2 transition-colors">
                <X size={20} />
              </button>
            </div>

            <form
              onSubmit={handleHwSubmit((d) => {
                setAssignmentError('')
                createAssignmentMutation.mutate(d)
              })}
              className="space-y-4"
            >
              <div>
                <label className="block text-sm font-medium text-ink-2 mb-1">Title</label>
                <input
                  {...regHw('title')}
                  placeholder="Homework 1"
                  className="w-full border border-hairline rounded-sm px-3 py-2.5 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-signal"
                  autoFocus
                />
                {hwErrors.title && <p className="text-red-500 text-xs mt-1">{hwErrors.title.message}</p>}
              </div>
              <div>
                <label className="block text-sm font-medium text-ink-2 mb-1">Deadline</label>
                <input
                  {...regHw('deadline')}
                  type="datetime-local"
                  className="w-full border border-hairline rounded-sm px-3 py-2.5 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-signal"
                />
                {hwErrors.deadline && <p className="text-red-500 text-xs mt-1">{hwErrors.deadline.message}</p>}
              </div>
              <p className="text-xs text-muted">Questions are added in the assignment editor after creation.</p>

              {assignmentError && <p className="text-red-500 text-sm">{assignmentError}</p>}

              <div className="flex justify-end gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => { setShowAssignmentModal(false); resetHw() }}
                  className="px-4 py-2 text-sm text-muted hover:text-ink transition-colors"
                >
                  Cancel
                </button>
                <Button type="submit" variant="primary" disabled={hwSubmitting}>
                  {hwSubmitting ? 'Creating…' : 'Create & edit'}
                </Button>
              </div>
            </form>
          </Card>
        </div>
      )}

      {/* Duplicate class modal */}
      {showDuplicateModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
          <Card flat className="w-full max-w-md p-6 shadow-pop">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-lg font-semibold text-ink">Duplicate class</h2>
              <button onClick={() => setShowDuplicateModal(false)} className="text-muted hover:text-ink-2 transition-colors">
                <X size={20} />
              </button>
            </div>

            <form onSubmit={submitDuplicate} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-ink-2 mb-1">Class name</label>
                <input
                  value={dupName}
                  onChange={(e) => setDupName(e.target.value)}
                  placeholder="Biochemistry 395"
                  className="w-full border border-hairline rounded-sm px-3 py-2.5 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-signal"
                  autoFocus
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-ink-2 mb-1">Description (optional)</label>
                <input
                  value={dupDescription}
                  onChange={(e) => setDupDescription(e.target.value)}
                  placeholder="Spring 2027"
                  className="w-full border border-hairline rounded-sm px-3 py-2.5 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-signal"
                />
              </div>

              <label className="flex items-start gap-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={dupTransferQr}
                  onChange={(e) => setDupTransferQr(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-hairline text-signal focus:ring-signal"
                />
                <span>
                  <span className="block text-sm font-medium text-ink-2">Transfer QR codes</span>
                  <span className="block text-xs text-muted mt-0.5">
                    QR codes in your slides will point to the new class's sessions. The old class keeps its history but gets new codes.
                  </span>
                </span>
              </label>

              {dupError && <p className="text-red-500 text-sm">{dupError}</p>}

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowDuplicateModal(false)}
                  className="px-4 py-2 text-sm text-muted hover:text-ink transition-colors"
                >
                  Cancel
                </button>
                <Button type="submit" variant="primary" disabled={dupLoading || !dupName.trim()}>
                  {dupLoading ? 'Duplicating…' : 'Duplicate'}
                </Button>
              </div>
            </form>
          </Card>
        </div>
      )}
    </ProfessorLayout>
  )
}
