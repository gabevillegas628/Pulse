import { useState } from 'react'
import { Link, useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm, useFieldArray } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { api } from '@/api/client'
import ProfessorLayout from '@/components/layout/ProfessorLayout'
import { Plus, Trash2, X, ChevronLeft, ChevronDown, Download, KeyRound, Copy, Users, BookOpen, Settings } from 'lucide-react'
import type { QuestionType, StudentStats, ActivitySession, GradebookSession, GradebookStudentRow } from 'shared'
import TextbookPage from '@/pages/shared/TextbookPage'
import GradebookTable from '@/components/GradebookTable'
import { apiError } from '@/lib/errors'


interface Assignment {
  id: string
  title: string
  status: string
  deadline: string | null
  _count: { questions: number }
}

const questionSchema = z.object({
  text: z.string().min(1, 'Question text required'),
  type: z.enum(['FREE_TEXT', 'MULTIPLE_CHOICE', 'MULTI_SELECT', 'RATING', 'YES_NO', 'NUMERIC', 'ORDERING', 'STRUCTURE']),
  options: z.array(z.string()).optional(),
})

const assignmentSchema = z.object({
  title: z.string().min(1, 'Title required'),
  deadline: z.string().min(1, 'Deadline required'),
})
type AssignmentFormData = z.infer<typeof assignmentSchema>

const sessionSchema = z.object({
  title: z.string().min(1, 'Title required'),
  questions: z.array(questionSchema).min(1, 'Add at least one question'),
})
type SessionFormData = z.infer<typeof sessionSchema>

const TYPE_LABELS: Record<QuestionType, string> = {
  FREE_TEXT: 'Free text',
  MULTIPLE_CHOICE: 'Multiple choice',
  MULTI_SELECT: 'Multi-select',
  ORDERING: 'Ordering',
  STRUCTURE: 'Structure drawing',
  RATING: 'Rating (1–5)',
  YES_NO: 'Yes / No',
  NUMERIC: 'Numeric',
}

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

  const { data: sessionsData } = useQuery<{ id: string; title: string; status: string; questions: Array<{ id: string }>; createdAt: string; targetSection?: { id: string; name: string } | null }[]>({
    queryKey: ['sessions', classId],
    queryFn: () => api.get(`/classes/${classId}/sessions?type=IN_CLASS`).then((r) => r.data.data.sessions),
    enabled: tab === 'sessions',
  })

  const { data: assignmentsData } = useQuery<Assignment[]>({
    queryKey: ['assignments', classId],
    queryFn: () => api.get(`/classes/${classId}/sessions?type=HOMEWORK`).then((r) => r.data.data.sessions),
    enabled: tab === 'assignments',
  })

  const { data: gradebookData } = useQuery<{ sessions: GradebookSession[]; students: GradebookStudentRow[] }>({
    queryKey: ['gradebook', classId],
    queryFn: () => api.get(`/classes/${classId}/grades/json`).then((r) => r.data.data),
    enabled: tab === 'grades',
  })

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

  const { register, control, handleSubmit, reset, watch, setValue, formState: { errors, isSubmitting } } = useForm<SessionFormData>({
    resolver: zodResolver(sessionSchema),
    defaultValues: { title: '', questions: [{ text: '', type: 'FREE_TEXT', options: [] }] },
  })

  const { fields, append, remove } = useFieldArray({ control, name: 'questions' })

  const createMutation = useMutation({
    mutationFn: (body: SessionFormData) =>
      api.post(`/classes/${classId}/sessions`, {
        title: body.title,
        questions: body.questions.map((q, i) => ({ ...q, order: i })),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['class', classId] })
      setShowModal(false)
      reset()
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
      api.post(`/classes/${classId}/sessions`, {
        type: 'HOMEWORK',
        title: body.title,
        deadline: new Date(body.deadline).toISOString(),
        questions: [],
      }),
    onSuccess: (res) => {
      setShowAssignmentModal(false)
      resetHw()
      navigate(`/professor/classes/${classId}/assignments/${res.data.data.session.id}`)
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
    mutationFn: (assignmentId: string) => api.delete(`/sessions/${assignmentId}`),
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

  const watchedQuestions = watch('questions')

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

  if (isLoading) return <ProfessorLayout><p className="text-gray-400">Loading…</p></ProfessorLayout>

  return (
    <ProfessorLayout>
      <div className="mb-6">
        <Link to="/professor" className="flex items-center gap-1 text-sm text-gray-400 hover:text-gray-600 mb-4">
          <ChevronLeft size={16} /> All classes
        </Link>
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{data?.name}</h1>
            {data?.description && <p className="text-gray-500 text-sm">{data.description}</p>}
            <div className="flex items-center gap-3 mt-2">
              <span className="text-xs text-gray-400">Join code:</span>
              <span className="font-mono text-sm bg-gray-100 px-2 py-0.5 rounded font-medium tracking-wider">{data?.joinCode}</span>
            </div>

            {/* Sections */}
            <div className="flex flex-wrap items-center gap-2 mt-2">
              <Users size={13} className="text-gray-400 shrink-0" />
              {sections.length === 0 ? (
                <span className="text-xs text-gray-400">No sections</span>
              ) : (
                sections.map((s) => (
                  <span key={s.id} className="text-xs bg-gray-100 px-2 py-0.5 rounded font-medium text-gray-700">
                    {s.name} <span className="font-mono text-gray-400">{s.joinCode}</span>
                  </span>
                ))
              )}
              {showAddSection ? (
                <form onSubmit={addSection} className="flex items-center gap-1">
                  <input
                    value={newSectionName}
                    onChange={(e) => setNewSectionName(e.target.value)}
                    placeholder="e.g. 001"
                    className="border border-gray-300 rounded px-2 py-0.5 text-xs w-20 focus:outline-none focus:ring-1 focus:ring-primary-500"
                    autoFocus
                  />
                  <button type="submit" disabled={sectionLoading || !newSectionName.trim()} className="text-xs text-primary-600 hover:text-primary-800 disabled:opacity-50">Add</button>
                  <button type="button" onClick={() => { setShowAddSection(false); setNewSectionName('') }} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
                </form>
              ) : (
                <button onClick={() => setShowAddSection(true)} className="text-xs text-primary-600 hover:text-primary-800 flex items-center gap-0.5">
                  <Plus size={12} /> Add section
                </button>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={openDuplicate}
              className="flex items-center gap-1.5 border border-gray-200 text-gray-600 px-3 py-2 rounded-lg text-sm hover:bg-gray-50"
              title="Duplicate this class for a new semester"
            >
              <Copy size={14} /> Duplicate
            </button>
            <a
              href={`/api/classes/${classId}/grades`}
              className="flex items-center gap-1.5 border border-gray-200 text-gray-600 px-3 py-2 rounded-lg text-sm hover:bg-gray-50"
              title="Export class-wide grade CSV"
            >
              <Download size={14} /> Export Grades
            </a>
            {tab === 'sessions' && (
              <button
                onClick={() => setShowModal(true)}
                className="flex items-center gap-2 bg-primary-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary-700 transition-colors"
              >
                <Plus size={16} /> New session
              </button>
            )}
            {tab === 'assignments' && (
              <button
                onClick={() => { setAssignmentError(''); setShowAssignmentModal(true) }}
                className="flex items-center gap-2 bg-primary-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary-700 transition-colors"
              >
                <Plus size={16} /> New assignment
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-gray-200">
        {([
          { key: 'sessions', label: 'Sessions' },
          { key: 'assignments', label: 'Assignments' },
          { key: 'grades', label: 'Grades' },
          { key: 'roster', label: 'Roster' },
          { key: 'textbook', label: 'Textbook' },
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

      {/* Sessions tab */}
      {tab === 'sessions' && (
        !sessionsData ? (
          <p className="text-gray-400 text-center py-8">Loading…</p>
        ) : sessionsData.length === 0 ? (
          <div className="text-center py-16 text-gray-400">
            <p className="text-sm">No sessions yet — create one to start collecting responses</p>
          </div>
        ) : (
          <div className="space-y-3">
            {sessionsData.map((s) => (
              <div key={s.id} className="group relative flex items-center bg-white border border-gray-200 rounded-xl hover:shadow-sm transition-shadow">
                <Link
                  to={`/professor/sessions/${s.id}`}
                  className="flex-1 flex items-center justify-between p-5"
                >
                  <div>
                    <p className="font-medium text-gray-900">{s.title}</p>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {s.questions?.length ?? 0} question{(s.questions?.length ?? 0) !== 1 ? 's' : ''} ·{' '}
                      {new Date(s.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {s.targetSection && (
                      <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-blue-50 text-blue-600">
                        §{s.targetSection.name}
                      </span>
                    )}
                    <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${
                      s.status === 'DRAFT' ? 'bg-yellow-50 text-yellow-600' :
                      s.status === 'OPEN' ? 'bg-green-100 text-green-700' :
                      s.status === 'CLOSED' ? 'bg-gray-100 text-gray-500' :
                      'bg-gray-50 text-gray-400'
                    }`}>
                      {s.status.charAt(0) + s.status.slice(1).toLowerCase()}
                    </span>
                  </div>
                </Link>
                <button
                  onClick={(e) => {
                    e.preventDefault()
                    if (!confirm(`Delete "${s.title}"? This will remove all responses and cannot be undone.`)) return
                    deleteSessionMutation.mutate(s.id)
                  }}
                  disabled={deleteSessionMutation.isPending}
                  className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0 px-4 py-5 text-gray-300 hover:text-red-500 disabled:opacity-30"
                  title="Delete session"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </div>
        )
      )}

      {/* Assignments tab */}
      {tab === 'assignments' && (
        !assignmentsData ? (
          <p className="text-gray-400 text-center py-8">Loading…</p>
        ) : assignmentsData.length === 0 ? (
          <div className="text-center py-16 text-gray-400">
            <BookOpen size={32} className="mx-auto mb-3 opacity-30" />
            <p className="text-sm">No assignments yet — create one above</p>
          </div>
        ) : (
          <div className="space-y-3">
            {assignmentsData.map((a) => (
              <div key={a.id} className="group relative flex items-center bg-white border border-gray-200 rounded-xl hover:shadow-sm transition-shadow">
                <Link
                  to={`/professor/classes/${classId}/assignments/${a.id}`}
                  className="flex-1 flex items-center justify-between p-5"
                >
                  <div>
                    <p className="font-medium text-gray-900">{a.title}</p>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {a._count.questions} question{a._count.questions !== 1 ? 's' : ''}{a.deadline ? ` · Due ${new Date(a.deadline).toLocaleDateString()}` : ''}
                    </p>
                  </div>
                  <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${
                    a.status === 'DRAFT' ? 'bg-yellow-50 text-yellow-600' :
                    a.status === 'OPEN' ? 'bg-green-100 text-green-700' :
                    a.status === 'CLOSED' ? 'bg-gray-100 text-gray-500' :
                    'bg-gray-50 text-gray-400'
                  }`}>
                    {a.status.charAt(0) + a.status.slice(1).toLowerCase()}
                  </span>
                </Link>
                <button
                  onClick={(e) => {
                    e.preventDefault()
                    if (!confirm(`Delete "${a.title}"? This will remove all student responses and cannot be undone.`)) return
                    deleteAssignmentMutation.mutate(a.id)
                  }}
                  disabled={deleteAssignmentMutation.isPending}
                  className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0 px-4 py-5 text-gray-300 hover:text-red-500 disabled:opacity-30"
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
          <p className="text-gray-400 text-center py-8">Loading…</p>
        ) : (
          <GradebookTable sessions={gradebookData.sessions} students={gradebookData.students} />
        )
      )}

      {/* Roster tab */}
      {tab === 'roster' && (
        !rosterData ? (
          <p className="text-gray-400 text-center py-8">Loading…</p>
        ) : rosterData.length === 0 ? (
          <div className="text-center py-16 text-gray-400">
            <p className="text-sm">No students enrolled yet</p>
          </div>
        ) : (
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-left">
                  <th className="px-5 py-3 text-xs font-medium text-gray-400 uppercase tracking-wide">NetID</th>
                  <th className="px-5 py-3 text-xs font-medium text-gray-400 uppercase tracking-wide">Email</th>
                  {sections.length > 0 && <th className="px-5 py-3 text-xs font-medium text-gray-400 uppercase tracking-wide">Section</th>}
                  <th className="px-5 py-3 text-xs font-medium text-gray-400 uppercase tracking-wide">Participation</th>
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
                        className="border-t border-gray-50 hover:bg-gray-50 cursor-pointer"
                      >
                        <td className="px-5 py-3.5 font-medium text-gray-900 flex items-center gap-1.5">
                          <ChevronDown size={14} className={`text-gray-300 transition-transform shrink-0 ${isExpanded ? 'rotate-180' : ''}`} />
                          {e.student.netId}
                        </td>
                        <td className="px-5 py-3.5 text-gray-600">{e.student.email}</td>
                        <td className="px-5 py-3.5 text-gray-500">{e.student.email}</td>
                        {sections.length > 0 && (
                          <td className="px-5 py-3.5" onClick={(ev) => ev.stopPropagation()}>
                            <select
                              value={e.section?.id ?? ''}
                              onChange={(ev) => assignSection(e.student.id, ev.target.value || null)}
                              className="text-xs border border-gray-200 rounded px-1.5 py-1 bg-white text-gray-700 focus:outline-none focus:ring-1 focus:ring-primary-500"
                            >
                              <option value="">— unassigned</option>
                              {sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                            </select>
                          </td>
                        )}
                        <td className="px-5 py-3.5 text-gray-600">
                          {e.stats.totalClosedSessions > 0 ? (
                            <span className={e.stats.sessionsParticipated === 0 ? 'text-gray-400' : ''}>
                              {e.stats.sessionsParticipated}/{e.stats.totalClosedSessions} sessions
                            </span>
                          ) : (
                            <span className="text-gray-300">—</span>
                          )}
                        </td>
                        <td className="px-5 py-3.5 text-right" onClick={(ev) => ev.stopPropagation()}>
                          <button
                            onClick={() => openReset(e.student)}
                            className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-primary-600 ml-auto"
                          >
                            <KeyRound size={13} /> Reset password
                          </button>
                        </td>
                      </tr>

                      {isExpanded && (
                        <tr key={`${e.student.id}-detail`} className="border-t border-gray-50 bg-gray-50">
                          <td colSpan={sections.length > 0 ? 6 : 5} className="px-5 py-4">
                            {!activity ? (
                              <p className="text-xs text-gray-400">Loading…</p>
                            ) : activity.length === 0 ? (
                              <p className="text-xs text-gray-400">No sessions yet.</p>
                            ) : (
                              <div className="space-y-3">
                                {activity.map((session) => (
                                  <div key={session.id}>
                                    <div className="flex items-center gap-2 mb-1.5">
                                      <span className="text-xs font-medium text-gray-700">{session.title}</span>
                                      <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${
                                        session.status === 'OPEN' ? 'bg-green-100 text-green-700' :
                                        session.status === 'CLOSED' ? 'bg-gray-100 text-gray-500' :
                                        'bg-gray-50 text-gray-400'
                                      }`}>
                                        {session.status.charAt(0) + session.status.slice(1).toLowerCase()}
                                      </span>
                                    </div>
                                    <div className="flex flex-wrap gap-2">
                                      {session.questions.map((q) => (
                                        <span
                                          key={q.id}
                                          title={q.text + (q.response ? `\n"${q.response.responseText}"` : '')}
                                          className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border ${
                                            q.response
                                              ? 'border-primary-200 bg-primary-50 text-primary-700'
                                              : 'border-gray-200 bg-white text-gray-400'
                                          }`}
                                        >
                                          Q{q.number} {q.response ? '✓' : '—'}
                                          {q.response && q.type === 'FREE_TEXT' && (
                                            <span className="text-primary-400">{q.response.wordCount}w</span>
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
              <h2 className="text-base font-semibold text-gray-800 mb-1">
                {repo ? 'Edit textbook' : 'Link a textbook'}
              </h2>
              <p className="text-sm text-gray-500 mb-5">
                Point to a public GitHub repo containing <code className="bg-gray-100 px-1 rounded">.md</code> chapter files.
                The chapter list is read from the GitHub Contents API.
              </p>
              <form onSubmit={saveTextbook} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    GitHub repo <span className="text-gray-400 font-normal">(owner/repo)</span>
                  </label>
                  <input
                    value={tbRepo}
                    onChange={(e) => setTbRepo(e.target.value)}
                    placeholder="gabevillegas628/BiochemistryLifeSci"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                    autoFocus
                    onFocus={() => { if (!tbRepo && repo) setTbRepo(repo) }}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Sub-folder <span className="text-gray-400 font-normal">(leave blank if .md files are at the root)</span>
                  </label>
                  <input
                    value={tbPath}
                    onChange={(e) => setTbPath(e.target.value)}
                    placeholder="chapters"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                    onFocus={() => { if (!tbPath && path) setTbPath(path) }}
                  />
                </div>
                {tbError && <p className="text-red-500 text-sm">{tbError}</p>}
                <div className="flex items-center gap-3 pt-1">
                  {repo && (
                    <button type="button" onClick={() => setShowTextbookSettings(false)} className="text-sm text-gray-500 hover:text-gray-700">
                      Cancel
                    </button>
                  )}
                  <button
                    type="submit"
                    disabled={tbSaving || !tbRepo.trim()}
                    className="px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50"
                  >
                    {tbSaving ? 'Saving…' : repo ? 'Save changes' : 'Link textbook'}
                  </button>
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
                      className="ml-auto text-sm text-red-400 hover:text-red-600 disabled:opacity-50"
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
              <div className="flex items-center gap-2 text-sm text-gray-500">
                <BookOpen size={14} />
                <span className="font-mono text-gray-700">{repo}</span>
                {path && <span className="text-gray-400">/{path}</span>}
              </div>
              <button
                onClick={() => { setTbRepo(repo); setTbPath(path); setShowTextbookSettings(true) }}
                className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-700"
              >
                <Settings size={13} /> Edit
              </button>
            </div>
            <div
              className="border border-gray-200 rounded-xl overflow-hidden flex"
              style={{ height: 'calc(100vh - 400px)', minHeight: '480px' }}
            >
              <TextbookPage repo={repo} path={path} />
            </div>
          </div>
        )
      })()}

      {/* Create session modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-start justify-center z-50 px-4 py-8 overflow-y-auto">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6 my-auto">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-lg font-semibold">New session</h2>
              <button onClick={() => { setShowModal(false); reset() }}><X size={20} className="text-gray-400" /></button>
            </div>

            <form onSubmit={handleSubmit((d) => { setCreateError(''); createMutation.mutate(d) })} className="space-y-5">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Session title</label>
                <input
                  {...register('title')}
                  placeholder="Week 3 Opener"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                  autoFocus
                />
                {errors.title && <p className="text-red-500 text-xs mt-1">{errors.title.message}</p>}
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm font-medium text-gray-700">Questions</label>
                  <button
                    type="button"
                    onClick={() => append({ text: '', type: 'FREE_TEXT', options: [] })}
                    className="text-xs text-primary-600 hover:text-primary-800 flex items-center gap-1"
                  >
                    <Plus size={13} /> Add question
                  </button>
                </div>

                <div className="space-y-4">
                  {fields.map((field, idx) => (
                    <div key={field.id} className="border border-gray-200 rounded-xl p-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-gray-400">Question {idx + 1}</span>
                        {fields.length > 1 && (
                          <button type="button" onClick={() => remove(idx)} className="text-gray-300 hover:text-red-400">
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>

                      <input
                        {...register(`questions.${idx}.text`)}
                        placeholder="Enter question text…"
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                      />
                      {errors.questions?.[idx]?.text && (
                        <p className="text-red-500 text-xs">{errors.questions[idx]?.text?.message}</p>
                      )}

                      <select
                        {...register(`questions.${idx}.type`)}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white"
                      >
                        {Object.entries(TYPE_LABELS).map(([val, label]) => (
                          <option key={val} value={val}>{label}</option>
                        ))}
                      </select>

                      {watchedQuestions[idx]?.type === 'MULTIPLE_CHOICE' && (
                        <div className="space-y-2">
                          <p className="text-xs text-gray-500">Options (one per line)</p>
                          <textarea
                            rows={3}
                            placeholder={"Option A\nOption B\nOption C"}
                            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none"
                            onChange={(e) => {
                              const opts = e.target.value.split('\n').map((s) => s.trim()).filter(Boolean)
                              setValue(`questions.${idx}.options`, opts)
                            }}
                          />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {createError && <p className="text-red-500 text-sm">{createError}</p>}

              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => { setShowModal(false); reset() }} className="px-4 py-2 text-sm text-gray-600">
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-5 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50"
                >
                  {isSubmitting ? 'Creating…' : 'Create session'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Reset password modal */}
      {resetTarget && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold">Reset password</h2>
              <button onClick={closeReset}><X size={18} className="text-gray-400" /></button>
            </div>

            {resetSuccess ? (
              <div className="text-center py-4">
                <p className="text-green-600 font-medium mb-1">Password updated</p>
                <p className="text-sm text-gray-500 mb-5">{resetTarget.netId}'s password has been reset.</p>
                <button onClick={closeReset} className="text-sm text-primary-600 hover:underline">Close</button>
              </div>
            ) : (
              <>
                <p className="text-sm text-gray-500 mb-4">
                  Setting a new password for <span className="font-medium text-gray-800">{resetTarget.netId}</span>
                </p>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="New password (min 8 chars)"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 mb-3"
                  autoFocus
                />
                {resetError && <p className="text-red-500 text-xs mb-3">{resetError}</p>}
                <div className="flex justify-end gap-3">
                  <button onClick={closeReset} className="px-4 py-2 text-sm text-gray-600">Cancel</button>
                  <button
                    onClick={() => resetMutation.mutate({ studentId: resetTarget.id, newPassword })}
                    disabled={newPassword.length < 8 || resetMutation.isPending}
                    className="px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50"
                  >
                    {resetMutation.isPending ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {/* Create assignment modal */}
      {showAssignmentModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-lg font-semibold">New assignment</h2>
              <button onClick={() => { setShowAssignmentModal(false); resetHw() }}>
                <X size={20} className="text-gray-400" />
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
                <label className="block text-sm font-medium text-gray-700 mb-1">Title</label>
                <input
                  {...regHw('title')}
                  placeholder="Homework 1"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                  autoFocus
                />
                {hwErrors.title && <p className="text-red-500 text-xs mt-1">{hwErrors.title.message}</p>}
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Deadline</label>
                <input
                  {...regHw('deadline')}
                  type="datetime-local"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
                {hwErrors.deadline && <p className="text-red-500 text-xs mt-1">{hwErrors.deadline.message}</p>}
              </div>
              <p className="text-xs text-gray-400">Questions are added in the assignment editor after creation.</p>

              {assignmentError && <p className="text-red-500 text-sm">{assignmentError}</p>}

              <div className="flex justify-end gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => { setShowAssignmentModal(false); resetHw() }}
                  className="px-4 py-2 text-sm text-gray-600"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={hwSubmitting}
                  className="px-5 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50"
                >
                  {hwSubmitting ? 'Creating…' : 'Create & edit'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Duplicate class modal */}
      {showDuplicateModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-lg font-semibold text-gray-900">Duplicate class</h2>
              <button onClick={() => setShowDuplicateModal(false)} className="text-gray-400 hover:text-gray-600">
                <X size={20} />
              </button>
            </div>

            <form onSubmit={submitDuplicate} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Class name</label>
                <input
                  value={dupName}
                  onChange={(e) => setDupName(e.target.value)}
                  placeholder="Biochemistry 395"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                  autoFocus
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description (optional)</label>
                <input
                  value={dupDescription}
                  onChange={(e) => setDupDescription(e.target.value)}
                  placeholder="Spring 2027"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>

              <label className="flex items-start gap-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={dupTransferQr}
                  onChange={(e) => setDupTransferQr(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                />
                <span>
                  <span className="block text-sm font-medium text-gray-700">Transfer QR codes</span>
                  <span className="block text-xs text-gray-400 mt-0.5">
                    QR codes in your slides will point to the new class's sessions. The old class keeps its history but gets new codes.
                  </span>
                </span>
              </label>

              {dupError && <p className="text-red-500 text-sm">{dupError}</p>}

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowDuplicateModal(false)}
                  className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={dupLoading || !dupName.trim()}
                  className="px-5 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50"
                >
                  {dupLoading ? 'Duplicating…' : 'Duplicate'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </ProfessorLayout>
  )
}
