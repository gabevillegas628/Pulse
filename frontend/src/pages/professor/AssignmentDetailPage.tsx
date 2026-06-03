import { useState, useCallback } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext, verticalListSortingStrategy, useSortable, arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { api } from '@/api/client'
import ProfessorLayout from '@/components/layout/ProfessorLayout'
import RichTextRenderer from '@/components/RichTextRenderer'
import { ChevronLeft, Download, Plus, GripVertical, Layers, Pencil, X, UserPlus, ChevronDown, ChevronUp } from 'lucide-react'
import type { SessionDetail, QuestionGroup, SummaryCategory } from 'shared'
import { SessionStatus } from 'shared'
import { apiError } from '@/lib/errors'
import GroupPanel from '@/components/assignment/GroupPanel'
import QuestionPanel from '@/components/assignment/QuestionPanel'
import { questionPreview } from '@/components/assignment/helpers'
import type { QWithGroup } from '@/components/assignment/types'

// Active selection: a group (multi-part), a standalone question, or submission list
type ActiveItem =
  | { kind: 'group'; groupId: string }
  | { kind: 'question'; questionId: string }
  | { kind: 'submissions' }

// ─── Sortable sidebar item ────────────────────────────────────────────────────

function SortableSidebarItem({
  id, isDraft, isActive, onClick, children,
}: {
  id: string
  isDraft: boolean
  isActive: boolean
  onClick: () => void
  children: (dragHandleProps: Record<string, unknown>) => React.ReactNode
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }

  return (
    <div ref={setNodeRef} style={style}>
      <button
        onClick={onClick}
        className={`group w-full text-left px-3 py-3 border-b border-gray-100 last:border-b-0 flex items-start gap-2 transition-colors ${
          isActive ? 'bg-primary-50' : 'hover:bg-gray-50'
        }`}
      >
        {isDraft && (
          <span
            {...attributes}
            {...listeners}
            className="mt-0.5 shrink-0 text-gray-300 group-hover:text-gray-400 cursor-grab active:cursor-grabbing"
            onClick={(e) => e.stopPropagation()}
          >
            <GripVertical size={14} />
          </span>
        )}
        <span className="flex-1 min-w-0">
          {children({})}
        </span>
      </button>
    </div>
  )
}

// ─── Student-preview input mock ───────────────────────────────────────────────

function PreviewInput({ q }: { q: QWithGroup }) {
  const opts = q.options as string[] | null
  if (q.type === 'FREE_TEXT') return (
    <textarea disabled rows={3} placeholder="Student answer…" className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm text-gray-400 bg-gray-50 resize-none" />
  )
  if (q.type === 'MULTIPLE_CHOICE' && opts) return (
    <div className="space-y-2">
      {opts.map((o) => (
        <div key={o} className="flex items-center gap-3 p-3 border border-gray-200 rounded-xl opacity-60">
          <div className="w-4 h-4 rounded-full border-2 border-gray-300 shrink-0" />
          <span className="text-sm text-gray-700">{o}</span>
        </div>
      ))}
    </div>
  )
  if (q.type === 'MULTI_SELECT' && opts) return (
    <div className="space-y-2">
      {opts.map((o) => (
        <div key={o} className="flex items-center gap-3 p-3 border border-gray-200 rounded-xl opacity-60">
          <div className="w-4 h-4 rounded border-2 border-gray-300 shrink-0" />
          <span className="text-sm text-gray-700">{o}</span>
        </div>
      ))}
    </div>
  )
  if (q.type === 'YES_NO') return (
    <div className="flex gap-3">
      {['Yes', 'No'].map((o) => (
        <div key={o} className="flex-1 py-2.5 border-2 border-gray-200 rounded-xl text-center text-sm text-gray-400 opacity-60">{o}</div>
      ))}
    </div>
  )
  if (q.type === 'RATING') return (
    <div className="flex gap-2">
      {[1,2,3,4,5].map((n) => (
        <div key={n} className="w-10 h-10 border-2 border-gray-200 rounded-xl flex items-center justify-center text-sm text-gray-400 opacity-60">{n}</div>
      ))}
    </div>
  )
  if (q.type === 'NUMERIC') return (
    <div className="flex items-center gap-2">
      <div className="w-36 h-9 border border-gray-200 rounded-lg bg-gray-50 opacity-60" />
      {(q as { unit?: string | null }).unit && <span className="text-sm text-gray-400">{(q as { unit?: string | null }).unit}</span>}
    </div>
  )
  if (q.type === 'ORDERING' && opts) return (
    <div className="space-y-2">
      {opts.map((o, i) => (
        <div key={o} className="flex items-center gap-2 px-3 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-500 opacity-60">
          <span className="text-gray-300">{i + 1}.</span> {o}
        </div>
      ))}
    </div>
  )
  if (q.type === 'STRUCTURE') return (
    <div className="h-20 border border-gray-200 rounded-xl bg-gray-50 flex items-center justify-center text-xs text-gray-400 opacity-60">Structure drawing (JSME editor)</div>
  )
  return null
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function AssignmentDetailPage() {
  const { assignmentId } = useParams<{ assignmentId: string }>()
  const qc = useQueryClient()

  const [activeItem, setActiveItem] = useState<ActiveItem | null>(null)
  const [summary, setSummary] = useState<SummaryCategory[] | null>(null)
  const [summaryQuestionId, setSummaryQuestionId] = useState<string | null>(null)
  const [gradeReasons, setGradeReasons] = useState<Record<string, string>>({})
  const [rubricDraft, setRubricDraft] = useState<Record<string, string>>({})

  const [editingDeadline, setEditingDeadline] = useState(false)
  const [deadlineDraft, setDeadlineDraft] = useState('')
  const [showExtensions, setShowExtensions] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const [extStudentId, setExtStudentId] = useState('')
  const [extDeadline, setExtDeadline] = useState('')

  const [showAddQuestion, setShowAddQuestion] = useState(false)
  const [aqGroupId, setAqGroupId] = useState('')
  const [aqText, setAqText] = useState('')
  const [aqType, setAqType] = useState<'FREE_TEXT' | 'MULTIPLE_CHOICE' | 'RATING' | 'YES_NO' | 'NUMERIC' | 'MULTI_SELECT' | 'ORDERING' | 'STRUCTURE'>('FREE_TEXT')
  const [aqOptions, setAqOptions] = useState('')
  const [aqNumericAnswer, setAqNumericAnswer] = useState('')
  const [aqTolerance, setAqTolerance] = useState('')
  const [aqUnit, setAqUnit] = useState('')
  const [aqError, setAqError] = useState('')

  const { data, isLoading } = useQuery<SessionDetail>({
    queryKey: ['assignment', assignmentId],
    queryFn: () => api.get(`/sessions/${assignmentId}`).then((r) => r.data.data.session),
  })

  // ── Mutations ──────────────────────────────────────────────────────────────

  const statusMutation = useMutation({
    mutationFn: (status: SessionStatus) => api.patch(`/sessions/${assignmentId}`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assignment', assignmentId] }),
  })

  const gradeMutation = useMutation({
    mutationFn: (questionId: string) =>
      api.post(`/sessions/${assignmentId}/questions/${questionId}/grade`)
        .then((r) => r.data.data.grades as { id: string; studentId: string; aiScore: number; reason: string }[]),
    onSuccess: (grades, questionId) => {
      const reasons: Record<string, string> = {}
      grades.forEach((g) => { reasons[g.id] = g.reason })
      setGradeReasons((prev) => ({ ...prev, ...reasons }))
      qc.setQueryData<SessionDetail>(['assignment', assignmentId], (prev) => {
        if (!prev) return prev
        return {
          ...prev,
          questions: prev.questions.map((q) =>
            q.id !== questionId ? q : {
              ...q,
              responses: q.responses.map((r) => {
                const g = grades.find((g) => g.id === r.id)
                return g ? { ...r, aiScore: g.aiScore } : r
              }),
            }
          ),
        }
      })
    },
  })

  const setCorrectAnswerMutation = useMutation({
    mutationFn: ({ questionId, correctAnswer }: { questionId: string; correctAnswer: string | null }) =>
      api.patch(`/sessions/${assignmentId}/questions/${questionId}`, { correctAnswer }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assignment', assignmentId] }),
  })

  const overrideScoreMutation = useMutation({
    mutationFn: ({ questionId, responseId, aiScore }: { questionId: string; responseId: string; aiScore: number }) =>
      api.patch(`/sessions/${assignmentId}/questions/${questionId}/responses/${responseId}`, { aiScore }),
    onSuccess: (_data, { questionId, responseId, aiScore }) => {
      qc.setQueryData<SessionDetail>(['assignment', assignmentId], (prev) => {
        if (!prev) return prev
        return {
          ...prev,
          questions: prev.questions.map((q) =>
            q.id !== questionId ? q : { ...q, responses: q.responses.map((r) => r.id === responseId ? { ...r, aiScore } : r) }
          ),
        }
      })
    },
  })

  const summarizeMutation = useMutation({
    mutationFn: (questionId: string) =>
      api.post(`/sessions/${assignmentId}/questions/${questionId}/summarize`).then((r) => r.data.data.categories),
    onSuccess: (categories: SummaryCategory[], questionId: string) => {
      setSummary(categories)
      setSummaryQuestionId(questionId)
    },
  })

  const addQuestionMutation = useMutation({
    mutationFn: () => api.post(`/sessions/${assignmentId}/questions`, {
      text: aqText, type: aqType,
      options: ['MULTIPLE_CHOICE', 'MULTI_SELECT', 'ORDERING'].includes(aqType)
        ? aqOptions.split('\n').map(s => s.trim()).filter(Boolean) : undefined,
      groupId: aqGroupId || undefined,
      correctAnswer: aqType === 'NUMERIC' && aqNumericAnswer ? aqNumericAnswer : undefined,
      tolerance: aqType === 'NUMERIC' && aqTolerance ? parseFloat(aqTolerance) : undefined,
      unit: aqType === 'NUMERIC' && aqUnit ? aqUnit : undefined,
    }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['assignment', assignmentId] })
      setShowAddQuestion(false)
      setAqText(''); setAqType('FREE_TEXT'); setAqOptions('')
      setAqNumericAnswer(''); setAqTolerance(''); setAqUnit(''); setAqError('')
      const q = res.data.data.question
      if (q.groupId) setActiveItem({ kind: 'group', groupId: q.groupId })
      else setActiveItem({ kind: 'question', questionId: q.id })
    },
    onError: (e: unknown) => setAqError(apiError(e, 'Failed to add question')),
  })

  const updateDeadlineMutation = useMutation({
    mutationFn: (deadline: string | null) => api.patch(`/sessions/${assignmentId}`, { deadline }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['assignment', assignmentId] }); setEditingDeadline(false) },
  })

  const extensionsQuery = useQuery<{ id: string; studentId: string; deadline: string; student: { id: string; netId: string } }[]>({
    queryKey: ['extensions', assignmentId],
    queryFn: () => api.get(`/sessions/${assignmentId}/extensions`).then((r) => r.data.data.extensions),
    enabled: showExtensions,
  })

  const rosterQuery = useQuery<{ student: { id: string; netId: string } }[]>({
    queryKey: ['roster', data?.class?.id],
    queryFn: () => api.get(`/classes/${data!.class.id}/enrollments`).then((r) => r.data.data.enrollments),
    enabled: showExtensions && !!data?.class?.id,
  })

  const addExtensionMutation = useMutation({
    mutationFn: ({ studentId, deadline }: { studentId: string; deadline: string }) =>
      api.post(`/sessions/${assignmentId}/extensions`, { studentId, deadline }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['extensions', assignmentId] }); setExtStudentId(''); setExtDeadline('') },
  })

  const removeExtensionMutation = useMutation({
    mutationFn: (studentId: string) => api.delete(`/sessions/${assignmentId}/extensions/${studentId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['extensions', assignmentId] }),
  })

  const submissionStatusQuery = useQuery<{
    students: { student: { id: string; netId: string }; section: { name: string } | null; submittedCount: number; totalQuestions: number; isComplete: boolean }[]
    totalQuestions: number
  }>({
    queryKey: ['submission-status', assignmentId],
    queryFn: () => api.get(`/sessions/${assignmentId}/submission-status`).then((r) => r.data.data),
    enabled: activeItem?.kind === 'submissions',
  })

  const reorderGroupsMutation = useMutation({
    mutationFn: (items: { id: string; order: number }[]) =>
      api.put(`/sessions/${assignmentId}/groups/reorder`, items),
    onError: () => qc.invalidateQueries({ queryKey: ['assignment', assignmentId] }),
  })

  const reorderUngroupedMutation = useMutation({
    mutationFn: (items: { id: string; order: number }[]) =>
      api.put(`/sessions/${assignmentId}/questions/reorder`, items),
    onError: () => qc.invalidateQueries({ queryKey: ['assignment', assignmentId] }),
  })

  // ── DnD sensors ────────────────────────────────────────────────────────────

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const handleGroupDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id || !data) return
    const groups = data.groups
    const oldIdx = groups.findIndex(g => g.id === active.id)
    const newIdx = groups.findIndex(g => g.id === over.id)
    if (oldIdx === -1 || newIdx === -1) return
    const reordered = arrayMove(groups, oldIdx, newIdx)
    qc.setQueryData<SessionDetail>(['assignment', assignmentId], (prev) =>
      prev ? { ...prev, groups: reordered } : prev
    )
    reorderGroupsMutation.mutate(reordered.map((g, i) => ({ id: g.id, order: i })))
  }, [data, assignmentId, qc, reorderGroupsMutation])

  const handleUngroupedDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id || !data) return
    const ungrouped = (data.questions as QWithGroup[]).filter(q => !q.groupId)
    const oldIdx = ungrouped.findIndex(q => q.id === active.id)
    const newIdx = ungrouped.findIndex(q => q.id === over.id)
    if (oldIdx === -1 || newIdx === -1) return
    const reordered = arrayMove(ungrouped, oldIdx, newIdx)
    qc.setQueryData<SessionDetail>(['assignment', assignmentId], (prev) => {
      if (!prev) return prev
      const grouped = (prev.questions as QWithGroup[]).filter(q => q.groupId)
      return { ...prev, questions: [...grouped, ...reordered] }
    })
    reorderUngroupedMutation.mutate(reordered.map((q, i) => ({ id: q.id, order: i })))
  }, [data, assignmentId, qc, reorderUngroupedMutation])

  // ── Derived data ───────────────────────────────────────────────────────────

  if (isLoading || !data) return <ProfessorLayout><p className="text-gray-400">Loading…</p></ProfessorLayout>

  const deadline = (data as unknown as { deadline: string | null }).deadline
  const isDraft = data.status === SessionStatus.DRAFT
  const allQuestions = data.questions as QWithGroup[]
  const ungroupedQuestions = allQuestions.filter(q => !q.groupId)
  const totalResponses = allQuestions.reduce((sum, q) => sum + q.responses.length, 0)

  const topLevelItems = [
    ...data.groups.map(g => ({ kind: 'group' as const, id: g.id })),
    ...ungroupedQuestions.map(q => ({ kind: 'question' as const, id: q.id })),
  ]

  const resolvedActive: ActiveItem | null =
    activeItem ??
    (data.groups.length > 0 ? { kind: 'group', groupId: data.groups[0].id } :
      ungroupedQuestions.length > 0 ? { kind: 'question', questionId: ungroupedQuestions[0].id } : null)

  const activeGroup = resolvedActive?.kind === 'group'
    ? data.groups.find(g => g.id === resolvedActive.groupId) : undefined

  const activeQuestion = resolvedActive?.kind === 'question'
    ? allQuestions.find(q => q.id === resolvedActive.questionId) : undefined
  const activeQuestionGlobalIdx = activeQuestion
    ? topLevelItems.findIndex(i => i.kind === 'question' && i.id === activeQuestion.id) : -1

  function openAddQuestion() {
    const defaultGroup = resolvedActive?.kind === 'group' ? resolvedActive.groupId : ''
    setAqGroupId(defaultGroup)
    setAqText(''); setAqType('FREE_TEXT'); setAqOptions(''); setAqError('')
    setShowAddQuestion(true)
  }

  const extensions = extensionsQuery.data ?? []
  const roster = rosterQuery.data ?? []
  const extendedIds = new Set(extensions.map((e) => e.studentId))
  const availableForExtension = roster.filter((e) => !extendedIds.has(e.student.id))

  function toDatetimeLocal(iso: string) {
    const d = new Date(iso)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  const sharedGradingProps = {
    gradeReasons, rubricDraft, setRubricDraft,
    gradeMutation, setCorrectAnswerMutation, overrideScoreMutation,
    summarizeMutation, summary, summaryQuestionId, setSummary, setSummaryQuestionId,
  }

  return (
    <ProfessorLayout>
      {/* Header */}
      <div className="mb-6">
        <Link to={`/professor/classes/${data.class.id}`} className="flex items-center gap-1 text-sm text-gray-400 hover:text-gray-600 mb-3">
          <ChevronLeft size={16} /> {data.class.name}
        </Link>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{data.title}</h1>
            <div className="flex items-center gap-3 mt-1 flex-wrap">
              <span className="text-sm text-gray-500">{totalResponses} submission{totalResponses !== 1 ? 's' : ''}</span>

              {/* Inline deadline edit */}
              {editingDeadline ? (
                <div className="flex items-center gap-1.5">
                  <input type="datetime-local" value={deadlineDraft} onChange={(e) => setDeadlineDraft(e.target.value)}
                    className="text-xs border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-primary-500" />
                  <button onClick={() => updateDeadlineMutation.mutate(deadlineDraft ? new Date(deadlineDraft).toISOString() : null)} disabled={updateDeadlineMutation.isPending}
                    className="text-xs text-white bg-primary-600 hover:bg-primary-700 px-2.5 py-1 rounded disabled:opacity-50">Save</button>
                  <button onClick={() => setEditingDeadline(false)} className="text-xs text-gray-400 hover:text-gray-600 px-1.5 py-1">Cancel</button>
                </div>
              ) : (
                <button onClick={() => { setDeadlineDraft(deadline ? toDatetimeLocal(deadline) : ''); setEditingDeadline(true) }}
                  className="flex items-center gap-1 text-sm group">
                  <span className={deadline && new Date(deadline) < new Date() ? 'text-red-500' : 'text-gray-400'}>
                    {deadline ? `Due ${new Date(deadline).toLocaleString()}` : 'No deadline'}
                  </span>
                  <Pencil size={11} className="text-gray-300 group-hover:text-gray-500 transition-colors" />
                </button>
              )}
            </div>

            {/* Extensions toggle */}
            <button onClick={() => setShowExtensions((v) => !v)}
              className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 mt-1.5">
              {showExtensions ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              Extensions{extensions.length > 0 ? ` (${extensions.length})` : ''}
            </button>

            {showExtensions && (
              <div className="mt-2 bg-gray-50 border border-gray-200 rounded-xl p-4 w-full max-w-lg">
                {extensions.length > 0 && (
                  <div className="space-y-2 mb-3">
                    {extensions.map((ext) => (
                      <div key={ext.studentId} className="flex items-center justify-between gap-3 text-sm">
                        <span className="text-gray-700 font-medium font-mono">{ext.student.netId}</span>
                        <span className="text-gray-500 text-xs shrink-0">{new Date(ext.deadline).toLocaleString()}</span>
                        <button onClick={() => removeExtensionMutation.mutate(ext.studentId)}
                          disabled={removeExtensionMutation.isPending}
                          className="text-gray-300 hover:text-red-500 transition-colors shrink-0">
                          <X size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {extensions.length === 0 && !rosterQuery.isLoading && (
                  <p className="text-xs text-gray-400 mb-3">No extensions granted yet.</p>
                )}
                <div className="flex items-center gap-2 flex-wrap">
                  <select value={extStudentId} onChange={(e) => setExtStudentId(e.target.value)}
                    className="text-xs border border-gray-200 rounded px-2 py-1.5 bg-white text-gray-700 focus:outline-none focus:ring-1 focus:ring-primary-500">
                    <option value="">Select student…</option>
                    {availableForExtension.map((e) => (
                      <option key={e.student.id} value={e.student.id}>{e.student.netId}</option>
                    ))}
                  </select>
                  <input type="datetime-local" value={extDeadline} onChange={(e) => setExtDeadline(e.target.value)}
                    className="text-xs border border-gray-200 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary-500" />
                  <button
                    onClick={() => { if (extStudentId && extDeadline) addExtensionMutation.mutate({ studentId: extStudentId, deadline: new Date(extDeadline).toISOString() }) }}
                    disabled={!extStudentId || !extDeadline || addExtensionMutation.isPending}
                    className="flex items-center gap-1 text-xs text-white bg-primary-600 hover:bg-primary-700 px-2.5 py-1.5 rounded disabled:opacity-50">
                    <UserPlus size={12} /> Grant
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <a href={`/api/sessions/${assignmentId}/export`} className="flex items-center gap-1.5 border border-gray-200 text-gray-600 px-3 py-2 rounded-lg text-sm hover:bg-gray-50">
              <Download size={14} /> Export CSV
            </a>
            <button onClick={() => setShowPreview(true)}
              className="flex items-center gap-1.5 text-sm text-gray-500 border border-gray-200 px-3 py-2 rounded-lg hover:bg-gray-50">
              Preview
            </button>
            {data.status === SessionStatus.DRAFT ? (
              <button onClick={() => statusMutation.mutate(SessionStatus.OPEN)} disabled={statusMutation.isPending}
                className="bg-primary-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50">Publish</button>
            ) : data.status === SessionStatus.OPEN ? (
              <div className="flex gap-2">
                <button onClick={() => statusMutation.mutate(SessionStatus.DRAFT)} disabled={statusMutation.isPending}
                  className="text-gray-500 border border-gray-200 px-4 py-2 rounded-lg text-sm hover:bg-gray-50 disabled:opacity-50">Back to Draft</button>
                <button onClick={() => statusMutation.mutate(SessionStatus.CLOSED)} disabled={statusMutation.isPending}
                  className="bg-red-50 text-red-600 border border-red-200 px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-100 disabled:opacity-50">Close</button>
              </div>
            ) : data.status === SessionStatus.CLOSED ? (
              <div className="flex gap-2">
                <button onClick={() => statusMutation.mutate(SessionStatus.OPEN)} disabled={statusMutation.isPending}
                  className="bg-green-50 text-green-700 border border-green-200 px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-100 disabled:opacity-50">Reopen</button>
                <button onClick={() => statusMutation.mutate(SessionStatus.ARCHIVED)} disabled={statusMutation.isPending}
                  className="text-gray-400 border border-gray-200 px-4 py-2 rounded-lg text-sm hover:bg-gray-50 disabled:opacity-50">Archive</button>
              </div>
            ) : (
              <span className="text-xs text-gray-400 border border-gray-200 px-3 py-2 rounded-lg">Archived</span>
            )}
          </div>
        </div>
      </div>

      {/* Two-panel layout */}
      <div className="flex gap-5 items-start">

        {/* Sidebar */}
        <div className="w-56 shrink-0 sticky top-6">
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">

            {/* Groups (sorted, draggable) */}
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleGroupDragEnd}>
              <SortableContext items={data.groups.map(g => g.id)} strategy={verticalListSortingStrategy}>
                {data.groups.map((group, topIdx) => {
                  const groupQuestions = allQuestions.filter(q => q.groupId === group.id)
                  const isActive = resolvedActive?.kind === 'group' && resolvedActive.groupId === group.id
                  return (
                    <SortableSidebarItem key={group.id} id={group.id} isDraft={isDraft} isActive={isActive}
                      onClick={() => setActiveItem({ kind: 'group', groupId: group.id })}>
                      {() => (
                        <>
                          <div className="flex items-center gap-1.5 mb-0.5">
                            <span className={`text-xs font-semibold ${isActive ? 'text-primary-700' : 'text-gray-700'}`}>{topIdx + 1}</span>
                            <span className="flex items-center gap-0.5 text-xs text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded-full font-medium">
                              <Layers size={10} /> {groupQuestions.length} parts
                            </span>
                          </div>
                          <p className="text-xs text-gray-500 leading-snug line-clamp-2">
                            {group.title || questionPreview(groupQuestions[0]?.text ?? '')}
                          </p>
                        </>
                      )}
                    </SortableSidebarItem>
                  )
                })}
              </SortableContext>
            </DndContext>

            {/* Ungrouped questions (sorted, draggable) */}
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleUngroupedDragEnd}>
              <SortableContext items={ungroupedQuestions.map(q => q.id)} strategy={verticalListSortingStrategy}>
                {ungroupedQuestions.map((q, localIdx) => {
                  const topIdx = data.groups.length + localIdx
                  const isActive = resolvedActive?.kind === 'question' && resolvedActive.questionId === q.id
                  return (
                    <SortableSidebarItem key={q.id} id={q.id} isDraft={isDraft} isActive={isActive}
                      onClick={() => setActiveItem({ kind: 'question', questionId: q.id })}>
                      {() => (
                        <>
                          <div className="flex items-center justify-between mb-0.5">
                            <span className={`text-xs font-semibold ${isActive ? 'text-primary-700' : 'text-gray-700'}`}>{topIdx + 1}</span>
                            <span className="text-xs text-gray-400">{q.responses.length} resp</span>
                          </div>
                          <p className="text-xs text-gray-500 leading-snug line-clamp-2">{questionPreview(q.text)}</p>
                        </>
                      )}
                    </SortableSidebarItem>
                  )
                })}
              </SortableContext>
            </DndContext>

            {/* Sidebar footer */}
            {isDraft && (
              <button onClick={openAddQuestion}
                className="w-full flex items-center justify-center gap-1.5 text-xs text-primary-600 hover:text-primary-800 hover:bg-primary-50 py-2.5 border-t border-gray-100 transition-colors">
                <Plus size={13} /> Add question
              </button>
            )}
            <button onClick={() => setActiveItem({ kind: 'submissions' })}
              className={`w-full flex items-center justify-center gap-1.5 text-xs py-2.5 border-t border-gray-100 transition-colors ${
                resolvedActive?.kind === 'submissions'
                  ? 'text-primary-700 bg-primary-50'
                  : 'text-gray-400 hover:text-gray-600 hover:bg-gray-50'
              }`}>
              Submissions
            </button>
          </div>
        </div>

        {/* Main content */}
        <div className="flex-1 min-w-0 space-y-5">

          {/* Add question panel */}
          {showAddQuestion && (
            <div className="border border-gray-200 rounded-xl p-5 bg-gray-50 space-y-3">
              <h3 className="text-sm font-medium text-gray-700">New question</h3>
              <textarea value={aqText} onChange={(e) => setAqText(e.target.value)} placeholder="Question text…" rows={2}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none" />
              <div className="flex items-center gap-3 flex-wrap">
                <label className="flex items-center gap-1.5 text-sm text-gray-600">
                  Type:
                  <select value={aqType} onChange={(e) => setAqType(e.target.value as typeof aqType)}
                    className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none">
                    <option value="FREE_TEXT">Free text</option>
                    <option value="MULTIPLE_CHOICE">Multiple choice</option>
                    <option value="MULTI_SELECT">Multi-select</option>
                    <option value="ORDERING">Ordering</option>
                    <option value="NUMERIC">Numeric</option>
                    <option value="STRUCTURE">Structure drawing</option>
                    <option value="RATING">Rating (1–5)</option>
                    <option value="YES_NO">Yes / No</option>
                  </select>
                </label>
                <label className="flex items-center gap-1.5 text-sm text-gray-600">
                  Add to group:
                  <select value={aqGroupId} onChange={(e) => setAqGroupId(e.target.value)}
                    className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none">
                    <option value="">None (standalone)</option>
                    {data.groups.map(g => <option key={g.id} value={g.id}>{g.title || 'Untitled group'}</option>)}
                  </select>
                </label>
                <div className="ml-auto flex gap-2">
                  <button onClick={() => { setShowAddQuestion(false); setAqError('') }} className="text-sm text-gray-500 px-3 py-2">Cancel</button>
                  <button onClick={() => { setAqError(''); addQuestionMutation.mutate() }}
                    disabled={!aqText.trim() || addQuestionMutation.isPending}
                    className="text-sm bg-primary-600 text-white px-4 py-2 rounded-lg hover:bg-primary-700 disabled:opacity-50">Add</button>
                </div>
              </div>
              {(aqType === 'MULTIPLE_CHOICE' || aqType === 'MULTI_SELECT') && (
                <textarea value={aqOptions} onChange={(e) => setAqOptions(e.target.value)}
                  placeholder={"Option A\nOption B\nOption C"} rows={3}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none" />
              )}
              {aqType === 'ORDERING' && (
                <textarea value={aqOptions} onChange={(e) => setAqOptions(e.target.value)}
                  placeholder={"Step 1\nStep 2\nStep 3"} rows={3}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none" />
              )}
              {aqType === 'NUMERIC' && (
                <div className="flex gap-2 flex-wrap">
                  <input value={aqNumericAnswer} onChange={(e) => setAqNumericAnswer(e.target.value)}
                    placeholder="Correct answer (e.g. 6.02e23)"
                    className="flex-1 min-w-0 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
                  <input value={aqTolerance} onChange={(e) => setAqTolerance(e.target.value)} placeholder="± tolerance"
                    className="w-32 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
                  <input value={aqUnit} onChange={(e) => setAqUnit(e.target.value)} placeholder="Unit (optional)"
                    className="w-36 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
                </div>
              )}
              {aqError && <p className="text-red-500 text-xs">{aqError}</p>}
            </div>
          )}

          {/* Group panel */}
          {resolvedActive?.kind === 'group' && activeGroup && (
            <GroupPanel
              key={activeGroup.id}
              group={activeGroup}
              questions={allQuestions.filter(q => q.groupId === activeGroup.id)}
              assignmentId={assignmentId!}
              sessionStatus={data.status as SessionStatus}
              onDeleted={() => setActiveItem(null)}
              {...sharedGradingProps}
            />
          )}

          {/* Standalone question panel */}
          {resolvedActive?.kind === 'question' && activeQuestion && (
            <QuestionPanel
              q={activeQuestion as QWithGroup}
              globalIdx={activeQuestionGlobalIdx}
              assignmentId={assignmentId!}
              sessionStatus={data.status as SessionStatus}
              onConverted={(newGroupId) => setActiveItem({ kind: 'group', groupId: newGroupId })}
              onDeleted={() => setActiveItem(null)}
              {...sharedGradingProps}
            />
          )}

          {/* Submission status panel */}
          {resolvedActive?.kind === 'submissions' && (
            <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-gray-800">Submission Status</h2>
                {submissionStatusQuery.data && (
                  <span className="text-xs text-gray-400">
                    {submissionStatusQuery.data.students.filter(s => s.isComplete).length} / {submissionStatusQuery.data.students.length} complete
                  </span>
                )}
              </div>
              {submissionStatusQuery.isLoading ? (
                <p className="text-gray-400 text-sm text-center py-8">Loading…</p>
              ) : submissionStatusQuery.data?.students.length === 0 ? (
                <p className="text-gray-400 text-sm text-center py-8">No enrolled students.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 text-xs text-gray-400 uppercase tracking-wide">
                      <th className="text-left px-5 py-2.5 font-medium">Student</th>
                      <th className="text-left px-3 py-2.5 font-medium">Section</th>
                      <th className="text-right px-5 py-2.5 font-medium">Submitted</th>
                    </tr>
                  </thead>
                  <tbody>
                    {submissionStatusQuery.data?.students.map((s) => (
                      <tr key={s.student.id} className="border-b border-gray-50 last:border-0">
                        <td className="px-5 py-2.5"><p className="font-medium text-gray-800 font-mono">{s.student.netId}</p></td>
                        <td className="px-3 py-2.5 text-xs text-gray-400">{s.section?.name ?? '—'}</td>
                        <td className="px-5 py-2.5 text-right">
                          <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                            s.isComplete ? 'bg-green-100 text-green-700' : s.submittedCount > 0 ? 'bg-yellow-50 text-yellow-700' : 'bg-red-50 text-red-600'
                          }`}>{s.submittedCount}/{s.totalQuestions}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {/* Empty state */}
          {!showAddQuestion && !resolvedActive && (
            <p className="text-sm text-gray-400 text-center py-12">
              {isDraft ? 'Click "+ Add question" to get started.' : 'No questions.'}
            </p>
          )}
        </div>
      </div>

      {/* Student preview modal */}
      {showPreview && (
        <div className="fixed inset-0 bg-black/50 flex items-start justify-center z-50 px-4 py-8 overflow-y-auto">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl my-auto overflow-hidden">
            <div className="bg-primary-600 px-6 py-4 flex items-start justify-between gap-4">
              <div>
                <p className="text-primary-100 text-xs font-medium uppercase tracking-wide">{data.class.name}</p>
                <h2 className="text-white text-lg font-semibold mt-0.5">{data.title}</h2>
              </div>
              <button onClick={() => setShowPreview(false)} className="text-primary-200 hover:text-white mt-0.5 shrink-0">
                <X size={20} />
              </button>
            </div>
            <div className="p-6 space-y-6">
              {(() => {
                const groups = data.groups as QuestionGroup[]
                const questions = data.questions as QWithGroup[]
                const usedIds = new Set<string>()
                const items: React.ReactNode[] = []
                groups.forEach((group) => {
                  const parts = questions.filter((q) => q.groupId === group.id)
                  if (parts.length === 0) return
                  parts.forEach((q) => usedIds.add(q.id))
                  items.push(
                    <div key={group.id} className="border border-amber-200 bg-amber-50 rounded-2xl p-5 space-y-4">
                      <div>
                        <p className="text-xs font-semibold text-amber-700 uppercase tracking-wide mb-1">{group.title}</p>
                        {group.text && <RichTextRenderer content={group.text} />}
                      </div>
                      {parts.map((q, pi) => (
                        <div key={q.id} className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
                          <p className="text-xs font-medium text-gray-400">Part {String.fromCharCode(65 + pi)}</p>
                          <RichTextRenderer content={q.text} />
                          <PreviewInput q={q} />
                        </div>
                      ))}
                    </div>
                  )
                })
                questions.filter((q) => !usedIds.has(q.id)).forEach((q, qi) => {
                  items.push(
                    <div key={q.id} className="border border-gray-200 rounded-2xl p-5 space-y-3">
                      <p className="text-xs font-medium text-gray-400">Question {qi + 1}</p>
                      <RichTextRenderer content={q.text} />
                      <PreviewInput q={q} />
                    </div>
                  )
                })
                return items
              })()}
              <p className="text-center text-xs text-gray-400 pt-2">— Preview only — students submit individually —</p>
            </div>
          </div>
        </div>
      )}
    </ProfessorLayout>
  )
}
