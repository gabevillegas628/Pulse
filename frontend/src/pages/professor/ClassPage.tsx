import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm, useFieldArray } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { api } from '@/api/client'
import ProfessorLayout from '@/components/layout/ProfessorLayout'
import { Plus, Trash2, X, ChevronLeft, ChevronDown, Download, KeyRound } from 'lucide-react'
import type { QuestionType } from 'shared'

interface StudentStats {
  totalResponses: number
  sessionsParticipated: number
  totalClosedSessions: number
  averageWordCount: number
}

interface ActivityQuestion {
  id: string
  text: string
  type: string
  number: number
  response: { responseText: string; wordCount: number; isFlagged: boolean; submittedAt: string } | null
}

interface ActivitySession {
  id: string
  title: string
  status: string
  createdAt: string
  questions: ActivityQuestion[]
}

const questionSchema = z.object({
  text: z.string().min(1, 'Question text required'),
  type: z.enum(['FREE_TEXT', 'MULTIPLE_CHOICE', 'RATING', 'YES_NO']),
  options: z.array(z.string()).optional(),
})

const sessionSchema = z.object({
  title: z.string().min(1, 'Title required'),
  questions: z.array(questionSchema).min(1, 'Add at least one question'),
})
type SessionFormData = z.infer<typeof sessionSchema>

const TYPE_LABELS: Record<QuestionType, string> = {
  FREE_TEXT: 'Free text',
  MULTIPLE_CHOICE: 'Multiple choice',
  RATING: 'Rating (1–5)',
  YES_NO: 'Yes / No',
}

interface Student {
  id: string
  netId: string
  name: string
  email: string
}

export default function ClassPage() {
  const { classId } = useParams<{ classId: string }>()
  const qc = useQueryClient()
  const [tab, setTab] = useState<'sessions' | 'roster'>('sessions')
  const [showModal, setShowModal] = useState(false)
  const [createError, setCreateError] = useState('')
  const [resetTarget, setResetTarget] = useState<Student | null>(null)
  const [newPassword, setNewPassword] = useState('')
  const [resetError, setResetError] = useState('')
  const [resetSuccess, setResetSuccess] = useState(false)
  const [expandedStudent, setExpandedStudent] = useState<string | null>(null)
  const [activityCache, setActivityCache] = useState<Record<string, ActivitySession[]>>({})

  const { data, isLoading } = useQuery({
    queryKey: ['class', classId],
    queryFn: () => api.get(`/classes/${classId}`).then((r) => r.data.data.class),
  })

  const { data: rosterData } = useQuery({
    queryKey: ['roster', classId],
    queryFn: () => api.get(`/classes/${classId}/enrollments`).then((r) => r.data.data.enrollments),
    enabled: tab === 'roster',
  })

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
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error
      setCreateError(msg ?? 'Failed to create session')
    },
  })

  const resetMutation = useMutation({
    mutationFn: ({ studentId, newPassword }: { studentId: string; newPassword: string }) =>
      api.post(`/classes/${classId}/students/${studentId}/reset-password`, { newPassword }),
    onSuccess: () => setResetSuccess(true),
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error
      setResetError(msg ?? 'Reset failed — try again')
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

  const watchedQuestions = watch('questions')

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
          </div>
          <div className="flex items-center gap-2">
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
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-gray-200">
        {(['sessions', 'roster'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors capitalize ${
              tab === t
                ? 'border-primary-600 text-primary-700'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Sessions tab */}
      {tab === 'sessions' && (
        data?.sessions?.length === 0 ? (
          <div className="text-center py-16 text-gray-400">
            <p className="text-sm">No sessions yet — create one to start collecting responses</p>
          </div>
        ) : (
          <div className="space-y-3">
            {data?.sessions?.map((s: { id: string; title: string; status: string; questions: Array<{ id: string }>; createdAt: string }) => (
              <Link
                key={s.id}
                to={`/professor/sessions/${s.id}`}
                className="flex items-center justify-between bg-white border border-gray-200 rounded-xl p-5 hover:shadow-sm transition-shadow"
              >
                <div>
                  <p className="font-medium text-gray-900">{s.title}</p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {s.questions?.length ?? 0} question{(s.questions?.length ?? 0) !== 1 ? 's' : ''} ·{' '}
                    {new Date(s.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${
                  s.status === 'DRAFT' ? 'bg-yellow-50 text-yellow-600' :
                  s.status === 'OPEN' ? 'bg-green-100 text-green-700' :
                  s.status === 'CLOSED' ? 'bg-gray-100 text-gray-500' :
                  'bg-gray-50 text-gray-400'
                }`}>
                  {s.status.charAt(0) + s.status.slice(1).toLowerCase()}
                </span>
              </Link>
            ))}
          </div>
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
                  <th className="px-5 py-3 text-xs font-medium text-gray-400 uppercase tracking-wide">Name</th>
                  <th className="px-5 py-3 text-xs font-medium text-gray-400 uppercase tracking-wide">NetID</th>
                  <th className="px-5 py-3 text-xs font-medium text-gray-400 uppercase tracking-wide">Email</th>
                  <th className="px-5 py-3 text-xs font-medium text-gray-400 uppercase tracking-wide">Participation</th>
                  <th className="px-5 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {rosterData.map((e: { student: Student; stats: StudentStats }) => {
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
                          {e.student.name}
                        </td>
                        <td className="px-5 py-3.5 font-mono text-gray-600">{e.student.netId}</td>
                        <td className="px-5 py-3.5 text-gray-500">{e.student.email}</td>
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
                          <td colSpan={5} className="px-5 py-4">
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
                <p className="text-sm text-gray-500 mb-5">{resetTarget.name}'s password has been reset.</p>
                <button onClick={closeReset} className="text-sm text-primary-600 hover:underline">Close</button>
              </div>
            ) : (
              <>
                <p className="text-sm text-gray-500 mb-4">
                  Setting a new password for <span className="font-medium text-gray-800">{resetTarget.name}</span> ({resetTarget.netId})
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
    </ProfessorLayout>
  )
}
