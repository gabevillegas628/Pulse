import { useState, useCallback, useRef, useEffect, lazy, Suspense } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { api } from '@/api/client'
import ProfessorLayout from '@/components/layout/ProfessorLayout'
import RichTextRenderer from '@/components/RichTextRenderer'
import RichTextEditor from '@/components/RichTextEditor'
import { ChevronLeft, Download, Plus, Sparkles, Check, Trash2, GripVertical, Layers, Pencil, X, UserPlus, ChevronDown, ChevronUp } from 'lucide-react'
import type { SessionDetail, QuestionWithResponses, ResponseWithStudent, QuestionGroup } from 'shared'
import { SessionStatus } from 'shared'

// ─── Types ───────────────────────────────────────────────────────────────────

interface SummaryCategory { label: string; description: string; count: number }

type QWithGroup = QuestionWithResponses & { groupId: string | null }

// Active selection: a group (multi-part) or a standalone question
type ActiveItem =
  | { kind: 'group'; groupId: string }
  | { kind: 'question'; questionId: string }
  | { kind: 'submissions' }

// ─── Helpers ─────────────────────────────────────────────────────────────────

function calcResponseScore(
  q: { type: string; correctAnswer: string | null; tolerance?: number | null },
  r: { responseText: string; aiScore: number | null }
): number | null {
  if (q.type === 'MULTIPLE_CHOICE' || q.type === 'YES_NO') {
    if (!q.correctAnswer) return null
    return r.responseText === q.correctAnswer ? 1.0 : 0.5
  }
  if (q.type === 'FREE_TEXT') return r.aiScore
  if (q.type === 'NUMERIC') {
    if (!q.correctAnswer) return null
    const correct = parseFloat(q.correctAnswer)
    const student = parseFloat(r.responseText)
    if (isNaN(student)) return 0
    const tol = q.tolerance ?? 0
    return Math.abs(student - correct) <= tol ? 1.0 : 0.0
  }
  if (q.type === 'MULTI_SELECT') {
    if (!q.correctAnswer) return null
    try {
      const studentArr: string[] = JSON.parse(r.responseText)
      const correctArr: string[] = JSON.parse(q.correctAnswer)
      const sSet = new Set(studentArr)
      const cSet = new Set(correctArr)
      return sSet.size === cSet.size && [...cSet].every(v => sSet.has(v)) ? 1.0 : 0.5
    } catch { return 0 }
  }
  if (q.type === 'ORDERING') {
    if (!q.correctAnswer) return null
    try {
      const studentArr: string[] = JSON.parse(r.responseText)
      const correctArr: string[] = JSON.parse(q.correctAnswer)
      return correctArr.length === studentArr.length && correctArr.every((v, i) => v === studentArr[i]) ? 1.0 : 0.5
    } catch { return 0 }
  }
  if (q.type === 'STRUCTURE') {
    if (r.aiScore !== null) return r.aiScore
    if (!q.correctAnswer) return 1.0
    if (!r.responseText) return 0
    return r.responseText === q.correctAnswer ? 1.0 : 0.5
  }
  return null
}

function cycleScore(current: number | null): number {
  if (current === null || current === 1.0) return 0
  if (current === 0) return 0.5
  return 1.0
}

function questionPreview(text: string): string {
  try {
    const doc = JSON.parse(text)
    const first = doc?.content?.[0]?.content?.[0]?.text ?? ''
    return first.length > 52 ? first.slice(0, 52) + '…' : first || '(empty)'
  } catch {
    return text.length > 52 ? text.slice(0, 52) + '…' : text || '(empty)'
  }
}

const Jsme = lazy(() => import('@loschmidt/jsme-react').then(m => ({ default: m.Jsme })))

// ─── SMILES renderer (for structure drawing submissions) ─────────────────────

function SmilesRenderer({ smiles, width = 260, height = 160 }: { smiles: string; width?: number; height?: number }) {
  const ref = useRef<SVGSVGElement>(null)
  useEffect(() => {
    if (!ref.current || !smiles) return
    import('smiles-drawer').then((mod) => {
      const SD = mod.default ?? mod
      const drawer = new SD.SmiDrawer({ width, height })
      drawer.draw(smiles, ref.current, 'light', null, null)
    }).catch(() => { /* invalid SMILES — leave blank */ })
  }, [smiles, width, height])
  return <svg ref={ref} width={width} height={height} className="block" />
}

// ─── Sortable sidebar item ────────────────────────────────────────────────────

function SortableSidebarItem({
  id,
  isDraft,
  isActive,
  onClick,
  children,
}: {
  id: string
  isDraft: boolean
  isActive: boolean
  onClick: () => void
  children: (dragHandleProps: Record<string, unknown>) => React.ReactNode
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

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

// ─── Group edit panel (remounts per group) ────────────────────────────────────

function GroupPanel({
  group,
  questions,
  assignmentId,
  sessionStatus,
  onDeleted,
  gradeReasons,
  rubricDraft,
  setRubricDraft,
  gradeMutation,
  setCorrectAnswerMutation,
  overrideScoreMutation,
  summarizeMutation,
  summary,
  summaryQuestionId,
  setSummary,
  setSummaryQuestionId,
}: {
  group: QuestionGroup
  questions: QWithGroup[]
  assignmentId: string
  sessionStatus: SessionStatus
  onDeleted: () => void
  gradeReasons: Record<string, string>
  rubricDraft: Record<string, string>
  setRubricDraft: React.Dispatch<React.SetStateAction<Record<string, string>>>
  gradeMutation: ReturnType<typeof useMutation<{ id: string; studentId: string; aiScore: number; reason: string }[], unknown, string>>
  setCorrectAnswerMutation: ReturnType<typeof useMutation<unknown, unknown, { questionId: string; correctAnswer: string | null }>>
  overrideScoreMutation: ReturnType<typeof useMutation<unknown, unknown, { questionId: string; responseId: string; aiScore: number }>>
  summarizeMutation: ReturnType<typeof useMutation<SummaryCategory[], unknown, string>>
  summary: SummaryCategory[] | null
  summaryQuestionId: string | null
  setSummary: (s: SummaryCategory[] | null) => void
  setSummaryQuestionId: (id: string | null) => void
}) {
  const qc = useQueryClient()
  const [titleDraft, setTitleDraft] = useState(group.title)
  const [textDraft, setTextDraft] = useState(group.text ?? '')
  const [textDirty, setTextDirty] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showAddPart, setShowAddPart] = useState(false)
  const [partText, setPartText] = useState('')
  const [partType, setPartType] = useState<'FREE_TEXT' | 'MULTIPLE_CHOICE' | 'RATING' | 'YES_NO' | 'NUMERIC' | 'MULTI_SELECT' | 'ORDERING' | 'STRUCTURE'>('FREE_TEXT')
  const [partOptions, setPartOptions] = useState('')
  const [partNumericAnswer, setPartNumericAnswer] = useState('')
  const [partTolerance, setPartTolerance] = useState('')
  const [partUnit, setPartUnit] = useState('')
  const [partError, setPartError] = useState('')

  const isDraft = sessionStatus === SessionStatus.DRAFT
  const isGradable = sessionStatus === SessionStatus.CLOSED || sessionStatus === SessionStatus.ARCHIVED

  const updateMutation = useMutation({
    mutationFn: (body: { title?: string; text?: string | null }) =>
      api.patch(`/sessions/${assignmentId}/groups/${group.id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assignment', assignmentId] }),
  })

  const deleteMutation = useMutation({
    mutationFn: () => api.delete(`/sessions/${assignmentId}/groups/${group.id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['assignment', assignmentId] })
      onDeleted()
    },
  })

  const addPartMutation = useMutation({
    mutationFn: () => api.post(`/sessions/${assignmentId}/questions`, {
      text: partText,
      type: partType,
      options: ['MULTIPLE_CHOICE', 'MULTI_SELECT', 'ORDERING'].includes(partType)
        ? partOptions.split('\n').map(s => s.trim()).filter(Boolean) : undefined,
      groupId: group.id,
      correctAnswer: partType === 'NUMERIC' && partNumericAnswer ? partNumericAnswer : undefined,
      tolerance: partType === 'NUMERIC' && partTolerance ? parseFloat(partTolerance) : undefined,
      unit: partType === 'NUMERIC' && partUnit ? partUnit : undefined,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['assignment', assignmentId] })
      setShowAddPart(false)
      setPartText(''); setPartType('FREE_TEXT'); setPartOptions('')
      setPartNumericAnswer(''); setPartTolerance(''); setPartUnit(''); setPartError('')
    },
    onError: (e: unknown) => {
      setPartError((e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Failed to add part')
    },
  })

  const reorderPartsMutation = useMutation({
    mutationFn: (items: { id: string; order: number }[]) =>
      api.put(`/sessions/${assignmentId}/questions/reorder`, items),
    onError: () => qc.invalidateQueries({ queryKey: ['assignment', assignmentId] }),
  })

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  function handlePartDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIdx = questions.findIndex(q => q.id === active.id)
    const newIdx = questions.findIndex(q => q.id === over.id)
    if (oldIdx === -1 || newIdx === -1) return
    const reordered = arrayMove(questions, oldIdx, newIdx)
    qc.setQueryData<SessionDetail>(['assignment', assignmentId], (prev) => {
      if (!prev) return prev
      const reorderedIds = new Set(reordered.map(q => q.id))
      return {
        ...prev,
        questions: [
          ...prev.questions.filter(q => !reorderedIds.has(q.id)),
          ...reordered,
        ],
      }
    })
    reorderPartsMutation.mutate(reordered.map((q, i) => ({ id: q.id, order: i })))
  }

  return (
    <div className="space-y-5">
      {/* Group header card */}
      <div className="bg-white border border-gray-200 rounded-xl p-5">
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs font-medium text-gray-400 uppercase tracking-wide">Multi-part question</p>
          {isDraft && (
            showDeleteConfirm ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-red-600">Parts become standalone. Continue?</span>
                <button
                  onClick={() => deleteMutation.mutate()}
                  disabled={deleteMutation.isPending}
                  className="text-xs text-red-600 border border-red-200 px-2 py-1 rounded hover:bg-red-50 disabled:opacity-50"
                >
                  {deleteMutation.isPending ? 'Removing…' : 'Yes'}
                </button>
                <button onClick={() => setShowDeleteConfirm(false)} className="text-xs text-gray-500">Cancel</button>
              </div>
            ) : (
              <button onClick={() => setShowDeleteConfirm(true)} className="flex items-center gap-1 text-xs text-red-400 hover:text-red-600">
                <Trash2 size={12} /> Ungroup
              </button>
            )
          )}
        </div>

        <input
          value={titleDraft}
          onChange={(e) => setTitleDraft(e.target.value)}
          onBlur={() => {
            if (titleDraft.trim() && titleDraft !== group.title)
              updateMutation.mutate({ title: titleDraft.trim() })
          }}
          className="w-full text-base font-semibold text-gray-900 border-b border-transparent hover:border-gray-200 focus:border-primary-400 focus:outline-none pb-1 mb-4 bg-transparent"
          placeholder="Question title / shared context"
        />

        {(group.text || isDraft) && (
          <>
            {isDraft ? (
              <>
                <p className="text-xs text-gray-400 mb-1.5">Shared context (optional — shown above all parts)</p>
                <RichTextEditor
                  key={group.id}
                  content={textDraft}
                  onChange={(json) => { setTextDraft(json); setTextDirty(true) }}
                />
                {textDirty && (
                  <button
                    onClick={() => { updateMutation.mutate({ text: textDraft }); setTextDirty(false) }}
                    disabled={updateMutation.isPending}
                    className="mt-2 px-3 py-1.5 bg-primary-600 text-white rounded-lg text-xs font-medium hover:bg-primary-700 disabled:opacity-50"
                  >
                    {updateMutation.isPending ? 'Saving…' : 'Save context'}
                  </button>
                )}
              </>
            ) : (
              group.text && <RichTextRenderer content={group.text} />
            )}
          </>
        )}
      </div>

      {/* Parts */}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handlePartDragEnd}>
        <SortableContext items={questions.map(q => q.id)} strategy={verticalListSortingStrategy}>
          {questions.map((q, partIdx) => (
            <PartCard
              key={q.id}
              q={q}
              partIdx={partIdx}
              assignmentId={assignmentId}
              isDraft={isDraft}
              isGradable={isGradable}
              onDeleted={() => qc.invalidateQueries({ queryKey: ['assignment', assignmentId] })}
              gradeReasons={gradeReasons}
              rubricDraft={rubricDraft}
              setRubricDraft={setRubricDraft}
              gradeMutation={gradeMutation}
              setCorrectAnswerMutation={setCorrectAnswerMutation}
              overrideScoreMutation={overrideScoreMutation}
              summarizeMutation={summarizeMutation}
              summary={summary}
              summaryQuestionId={summaryQuestionId}
              setSummary={setSummary}
              setSummaryQuestionId={setSummaryQuestionId}
            />
          ))}
        </SortableContext>
      </DndContext>

      {/* Add part */}
      {isDraft && !showAddPart && (
        <button
          onClick={() => setShowAddPart(true)}
          className="flex items-center gap-1.5 text-sm text-primary-600 hover:text-primary-800"
        >
          <Plus size={14} /> Add part
        </button>
      )}
      {showAddPart && (
        <div className="border border-gray-200 rounded-xl p-4 bg-gray-50 space-y-3">
          <h4 className="text-sm font-medium text-gray-700">New part</h4>
          <textarea
            value={partText}
            onChange={(e) => setPartText(e.target.value)}
            placeholder="Part question text…"
            rows={2}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none"
          />
          <div className="flex items-center gap-3">
            <select
              value={partType}
              onChange={(e) => setPartType(e.target.value as typeof partType)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none"
            >
              <option value="FREE_TEXT">Free text</option>
              <option value="MULTIPLE_CHOICE">Multiple choice</option>
              <option value="MULTI_SELECT">Multi-select</option>
              <option value="ORDERING">Ordering</option>
              <option value="NUMERIC">Numeric</option>
              <option value="STRUCTURE">Structure drawing</option>
              <option value="RATING">Rating (1–5)</option>
              <option value="YES_NO">Yes / No</option>
            </select>
            <div className="ml-auto flex gap-2">
              <button onClick={() => { setShowAddPart(false); setPartError('') }} className="text-sm text-gray-500 px-3 py-1.5">Cancel</button>
              <button
                onClick={() => { setPartError(''); addPartMutation.mutate() }}
                disabled={!partText.trim() || addPartMutation.isPending}
                className="text-sm bg-primary-600 text-white px-4 py-1.5 rounded-lg hover:bg-primary-700 disabled:opacity-50"
              >
                Add
              </button>
            </div>
          </div>
          {(partType === 'MULTIPLE_CHOICE' || partType === 'MULTI_SELECT') && (
            <textarea
              value={partOptions}
              onChange={(e) => setPartOptions(e.target.value)}
              placeholder={"Option A\nOption B\nOption C"}
              rows={3}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none"
            />
          )}
          {partType === 'ORDERING' && (
            <textarea
              value={partOptions}
              onChange={(e) => setPartOptions(e.target.value)}
              placeholder={"Step 1\nStep 2\nStep 3"}
              rows={3}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none"
            />
          )}
          {partType === 'NUMERIC' && (
            <div className="flex gap-2 flex-wrap">
              <input
                value={partNumericAnswer}
                onChange={(e) => setPartNumericAnswer(e.target.value)}
                placeholder="Correct answer (e.g. 6.02e23)"
                className="flex-1 min-w-0 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
              <input
                value={partTolerance}
                onChange={(e) => setPartTolerance(e.target.value)}
                placeholder="± tolerance"
                className="w-32 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
              <input
                value={partUnit}
                onChange={(e) => setPartUnit(e.target.value)}
                placeholder="Unit (optional)"
                className="w-36 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
          )}
          {partError && <p className="text-red-500 text-xs">{partError}</p>}
        </div>
      )}
    </div>
  )
}

// ─── Part card (question within a group) ─────────────────────────────────────

function PartCard({
  q,
  partIdx,
  assignmentId,
  isDraft,
  isGradable,
  onDeleted,
  gradeReasons,
  rubricDraft,
  setRubricDraft,
  gradeMutation,
  setCorrectAnswerMutation,
  overrideScoreMutation,
  summarizeMutation,
  summary,
  summaryQuestionId,
  setSummary,
  setSummaryQuestionId,
}: {
  q: QWithGroup
  partIdx: number
  assignmentId: string
  isDraft: boolean
  isGradable: boolean
  onDeleted: () => void
  gradeReasons: Record<string, string>
  rubricDraft: Record<string, string>
  setRubricDraft: React.Dispatch<React.SetStateAction<Record<string, string>>>
  gradeMutation: ReturnType<typeof useMutation<{ id: string; studentId: string; aiScore: number; reason: string }[], unknown, string>>
  setCorrectAnswerMutation: ReturnType<typeof useMutation<unknown, unknown, { questionId: string; correctAnswer: string | null }>>
  overrideScoreMutation: ReturnType<typeof useMutation<unknown, unknown, { questionId: string; responseId: string; aiScore: number }>>
  summarizeMutation: ReturnType<typeof useMutation<SummaryCategory[], unknown, string>>
  summary: SummaryCategory[] | null
  summaryQuestionId: string | null
  setSummary: (s: SummaryCategory[] | null) => void
  setSummaryQuestionId: (id: string | null) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: q.id })
  const isAnswerKeyEditable = isDraft || isGradable

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      className="bg-white border border-gray-200 rounded-xl p-5"
    >
      <div className="flex items-start gap-2 mb-3">
        {isDraft && (
          <span
            {...attributes}
            {...listeners}
            className="mt-0.5 text-gray-300 hover:text-gray-400 cursor-grab active:cursor-grabbing shrink-0"
          >
            <GripVertical size={14} />
          </span>
        )}
        <p className="text-xs font-medium text-gray-400 uppercase tracking-wide">
          Part {partIdx + 1} · {q.type.replace('_', ' ').toLowerCase()}
        </p>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-gray-400">{q.responses.length} resp</span>
          {isDraft && (
            <button
              onClick={async () => {
                if (!confirm('Delete this part? This cannot be undone.')) return
                await api.delete(`/sessions/${assignmentId}/questions/${q.id}`)
                onDeleted()
              }}
              className="text-gray-300 hover:text-red-500 transition-colors"
            >
              <Trash2 size={13} />
            </button>
          )}
        </div>
      </div>

      <div className="mb-4">
        <RichTextRenderer content={q.text} />
      </div>
      {(q.type === 'MULTIPLE_CHOICE' || (q.type as string) === 'MULTI_SELECT') && Array.isArray(q.options) && (
        <div className="flex flex-wrap gap-2 mb-3">
          {(q.options as string[]).map((opt) => (
            <span key={opt} className="text-xs bg-gray-100 px-2.5 py-1 rounded-full text-gray-600">{opt}</span>
          ))}
        </div>
      )}
      {(q.type as string) === 'ORDERING' && Array.isArray(q.options) && (
        <ol className="text-xs text-gray-500 list-decimal list-inside space-y-0.5 mb-3">
          {(q.options as string[]).map((opt, i) => <li key={i}>{opt}</li>)}
        </ol>
      )}

      {isAnswerKeyEditable && <GradingControls q={q} rubricDraft={rubricDraft} setRubricDraft={setRubricDraft} gradeMutation={gradeMutation} setCorrectAnswerMutation={setCorrectAnswerMutation} summarizeMutation={summarizeMutation} summary={summary} summaryQuestionId={summaryQuestionId} setSummary={setSummary} setSummaryQuestionId={setSummaryQuestionId} />}

      <ResponseList q={q} isGradable={isGradable} gradeReasons={gradeReasons} overrideScoreMutation={overrideScoreMutation} />
    </div>
  )
}

// ─── Standalone question panel ────────────────────────────────────────────────

function QuestionPanel({
  q,
  globalIdx,
  assignmentId,
  sessionStatus,
  onConverted,
  onDeleted,
  gradeReasons,
  rubricDraft,
  setRubricDraft,
  gradeMutation,
  setCorrectAnswerMutation,
  overrideScoreMutation,
  summarizeMutation,
  summary,
  summaryQuestionId,
  setSummary,
  setSummaryQuestionId,
}: {
  q: QWithGroup
  globalIdx: number
  assignmentId: string
  sessionStatus: SessionStatus
  onConverted: (newGroupId: string) => void
  onDeleted: () => void
  gradeReasons: Record<string, string>
  rubricDraft: Record<string, string>
  setRubricDraft: React.Dispatch<React.SetStateAction<Record<string, string>>>
  gradeMutation: ReturnType<typeof useMutation<{ id: string; studentId: string; aiScore: number; reason: string }[], unknown, string>>
  setCorrectAnswerMutation: ReturnType<typeof useMutation<unknown, unknown, { questionId: string; correctAnswer: string | null }>>
  overrideScoreMutation: ReturnType<typeof useMutation<unknown, unknown, { questionId: string; responseId: string; aiScore: number }>>
  summarizeMutation: ReturnType<typeof useMutation<SummaryCategory[], unknown, string>>
  summary: SummaryCategory[] | null
  summaryQuestionId: string | null
  setSummary: (s: SummaryCategory[] | null) => void
  setSummaryQuestionId: (id: string | null) => void
}) {
  const qc = useQueryClient()
  const isDraft = sessionStatus === SessionStatus.DRAFT
  const isGradable = sessionStatus === SessionStatus.CLOSED || sessionStatus === SessionStatus.ARCHIVED
  const isAnswerKeyEditable = sessionStatus === SessionStatus.DRAFT || isGradable
  const [converting, setConverting] = useState(false)

  async function handleMakeMultiPart() {
    setConverting(true)
    try {
      // 1. Create a group (title from first line of question text)
      const groupRes = await api.post(`/sessions/${assignmentId}/groups`, {
        title: questionPreview(q.text),
      })
      const newGroupId: string = groupRes.data.data.group.id

      // 2. Assign this question to the new group
      await api.patch(`/sessions/${assignmentId}/questions/${q.id}`, { groupId: newGroupId })

      // 3. Create a blank Part 2 in the group
      await api.post(`/sessions/${assignmentId}/questions`, {
        text: '',
        type: 'FREE_TEXT',
        groupId: newGroupId,
      })

      await qc.invalidateQueries({ queryKey: ['assignment', assignmentId] })
      onConverted(newGroupId)
    } catch {
      // silent — user can retry
    } finally {
      setConverting(false)
    }
  }

  return (
    <div className="space-y-5">
      <div className="bg-white border border-gray-200 rounded-xl p-5">
        <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-2">
          Question {globalIdx + 1} · {q.type.replace('_', ' ').toLowerCase()}
        </p>
        <RichTextRenderer content={q.text} />
        {(q.type === 'MULTIPLE_CHOICE' || (q.type as string) === 'MULTI_SELECT') && Array.isArray(q.options) && (
          <div className="flex flex-wrap gap-2 mt-3">
            {(q.options as string[]).map((opt) => (
              <span key={opt} className="text-xs bg-gray-100 px-2.5 py-1 rounded-full text-gray-600">{opt}</span>
            ))}
          </div>
        )}
        {(q.type as string) === 'ORDERING' && Array.isArray(q.options) && (
          <ol className="text-xs text-gray-500 list-decimal list-inside space-y-0.5 mt-3">
            {(q.options as string[]).map((opt, i) => <li key={i}>{opt}</li>)}
          </ol>
        )}
      </div>

      {isAnswerKeyEditable && <GradingControls q={q} rubricDraft={rubricDraft} setRubricDraft={setRubricDraft} gradeMutation={gradeMutation} setCorrectAnswerMutation={setCorrectAnswerMutation} summarizeMutation={summarizeMutation} summary={summary} summaryQuestionId={summaryQuestionId} setSummary={setSummary} setSummaryQuestionId={setSummaryQuestionId} />}

      {summary && summaryQuestionId === q.id && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {summary.map((cat) => (
            <div key={cat.label} className="bg-blue-50 border border-blue-100 rounded-xl p-4">
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-semibold text-blue-900">{cat.label}</span>
                <span className="text-xs text-blue-500">{cat.count} student{cat.count !== 1 ? 's' : ''}</span>
              </div>
              <p className="text-xs text-blue-700">{cat.description}</p>
            </div>
          ))}
        </div>
      )}

      <ResponseList q={q} isGradable={isGradable} gradeReasons={gradeReasons} overrideScoreMutation={overrideScoreMutation} />

      {isDraft && (
        <div className="flex gap-2">
          <button
            onClick={handleMakeMultiPart}
            disabled={converting}
            className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 border border-gray-200 px-3 py-2 rounded-lg hover:bg-gray-50 disabled:opacity-50"
          >
            <Layers size={14} /> {converting ? 'Converting…' : 'Make multi-part'}
          </button>
          <button
            onClick={async () => {
              if (!confirm('Delete this question? This cannot be undone.')) return
              await api.delete(`/sessions/${assignmentId}/questions/${q.id}`)
              await qc.invalidateQueries({ queryKey: ['assignment', assignmentId] })
              onDeleted()
            }}
            className="flex items-center gap-1.5 text-sm text-red-500 hover:text-red-700 border border-red-200 px-3 py-2 rounded-lg hover:bg-red-50"
          >
            <Trash2 size={14} /> Delete
          </button>
        </div>
      )}
    </div>
  )
}

// ─── Shared grading controls ──────────────────────────────────────────────────

function GradingControls({
  q,
  rubricDraft,
  setRubricDraft,
  gradeMutation,
  setCorrectAnswerMutation,
  summarizeMutation,
  summary,
  summaryQuestionId,
  setSummary,
  setSummaryQuestionId,
}: {
  q: QWithGroup
  rubricDraft: Record<string, string>
  setRubricDraft: React.Dispatch<React.SetStateAction<Record<string, string>>>
  gradeMutation: ReturnType<typeof useMutation<{ id: string; studentId: string; aiScore: number; reason: string }[], unknown, string>>
  setCorrectAnswerMutation: ReturnType<typeof useMutation<unknown, unknown, { questionId: string; correctAnswer: string | null }>>
  summarizeMutation: ReturnType<typeof useMutation<SummaryCategory[], unknown, string>>
  summary: SummaryCategory[] | null
  summaryQuestionId: string | null
  setSummary: (s: SummaryCategory[] | null) => void
  setSummaryQuestionId: (id: string | null) => void
}) {
  const [editingStructure, setEditingStructure] = useState(false)
  const [structureDraft, setStructureDraft] = useState('')
  const jsmeInitialSmiles = useRef('')

  return (
    <div className="flex items-center gap-3 flex-wrap py-2 border-t border-gray-100">
      {(q.type === 'MULTIPLE_CHOICE' || q.type === 'YES_NO') && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">Correct answer:</span>
          <select
            value={q.correctAnswer ?? ''}
            onChange={(e) => setCorrectAnswerMutation.mutate({ questionId: q.id, correctAnswer: e.target.value || null })}
            className="text-xs border border-gray-200 rounded px-2 py-1 bg-white text-gray-700 focus:outline-none focus:ring-1 focus:ring-primary-500"
          >
            <option value="">— none set</option>
            {q.type === 'YES_NO' ? (
              <><option value="Yes">Yes</option><option value="No">No</option></>
            ) : (
              (q.options as string[] ?? []).map((opt) => <option key={opt} value={opt}>{opt}</option>)
            )}
          </select>
        </div>
      )}
      {(q.type as string) === 'NUMERIC' && (
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <span>Answer:</span>
          <span className="font-mono text-gray-800">{q.correctAnswer ?? '—'}</span>
          {q.tolerance != null && <span>± {q.tolerance}</span>}
          {q.unit && <span className="text-gray-400">{q.unit}</span>}
        </div>
      )}
      {(q.type as string) === 'MULTI_SELECT' && Array.isArray(q.options) && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-gray-500">Correct answers (check all that apply):</span>
          <div className="flex flex-wrap gap-3">
            {(q.options as string[]).map((opt) => {
              let current: string[] = []
              try { current = q.correctAnswer ? JSON.parse(q.correctAnswer) : [] } catch { /* ignore */ }
              const isChecked = current.includes(opt)
              return (
                <label key={opt} className="flex items-center gap-1.5 text-xs cursor-pointer">
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => {
                      const next = isChecked ? current.filter(v => v !== opt) : [...current, opt]
                      setCorrectAnswerMutation.mutate({ questionId: q.id, correctAnswer: next.length ? JSON.stringify(next) : null })
                    }}
                    className="text-primary-600"
                  />
                  {opt}
                </label>
              )
            })}
          </div>
        </div>
      )}
      {(q.type as string) === 'STRUCTURE' && (
        <div className="w-full pt-1">
          {editingStructure ? (
            <div className="space-y-2">
              <Suspense fallback={<p className="text-xs text-gray-400">Loading editor…</p>}>
                <Jsme
                  height="420px"
                  width="600px"
                  smiles={jsmeInitialSmiles.current}
                  onChange={(smiles: string) => setStructureDraft(smiles)}
                />
              </Suspense>
              <div className="flex gap-2">
                <button
                  onClick={() => { setCorrectAnswerMutation.mutate({ questionId: q.id, correctAnswer: structureDraft || null }); setEditingStructure(false) }}
                  disabled={setCorrectAnswerMutation.isPending}
                  className="text-xs text-white bg-primary-600 hover:bg-primary-700 px-3 py-1.5 rounded-lg disabled:opacity-50"
                >Save</button>
                <button onClick={() => setEditingStructure(false)} className="text-xs text-gray-500 px-2 py-1.5">Cancel</button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              {q.correctAnswer ? (
                <>
                  <SmilesRenderer smiles={q.correctAnswer} width={180} height={120} />
                  <div className="flex flex-col gap-1.5">
                    <button
                      onClick={() => { jsmeInitialSmiles.current = q.correctAnswer ?? ''; setStructureDraft(q.correctAnswer ?? ''); setEditingStructure(true) }}
                      className="text-xs text-primary-600 hover:text-primary-800 border border-primary-200 px-2.5 py-1 rounded"
                    >Change</button>
                    <button
                      onClick={() => setCorrectAnswerMutation.mutate({ questionId: q.id, correctAnswer: null })}
                      disabled={setCorrectAnswerMutation.isPending}
                      className="text-xs text-gray-500 hover:text-red-600 border border-gray-200 px-2.5 py-1 rounded disabled:opacity-50"
                    >Clear</button>
                  </div>
                </>
              ) : (
                <button
                  onClick={() => { jsmeInitialSmiles.current = ''; setStructureDraft(''); setEditingStructure(true) }}
                  className="text-xs text-primary-600 hover:text-primary-800 border border-primary-200 px-2.5 py-1.5 rounded"
                >Set correct structure…</button>
              )}
            </div>
          )}
        </div>
      )}
      {(q.type as string) === 'ORDERING' && q.correctAnswer && (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-gray-500">Correct order:</span>
          <ol className="text-xs text-gray-700 list-decimal list-inside space-y-0.5">
            {(() => { try { return (JSON.parse(q.correctAnswer) as string[]).map((item, i) => <li key={i}>{item}</li>) } catch { return null } })()}
          </ol>
        </div>
      )}
      {q.type === 'FREE_TEXT' && (
        <>
          <input
            value={rubricDraft[q.id] ?? q.correctAnswer ?? ''}
            onChange={(e) => setRubricDraft((prev) => ({ ...prev, [q.id]: e.target.value }))}
            onBlur={() => {
              const val = rubricDraft[q.id]
              if (val !== undefined)
                setCorrectAnswerMutation.mutate({ questionId: q.id, correctAnswer: val || null })
            }}
            placeholder="Reference answer (optional, used by AI grader)"
            className="text-xs border border-gray-200 rounded px-2.5 py-1.5 text-gray-700 focus:outline-none focus:ring-1 focus:ring-primary-500 w-56"
          />
          <button
            onClick={() => gradeMutation.mutate(q.id)}
            disabled={gradeMutation.isPending || q.responses.length === 0}
            className="flex items-center gap-1.5 text-xs text-white bg-primary-600 hover:bg-primary-700 px-3 py-1.5 rounded-lg disabled:opacity-50"
          >
            <Sparkles size={12} />
            {gradeMutation.isPending ? 'Grading…' : 'AI grade all'}
          </button>
        </>
      )}
      {q.type === 'FREE_TEXT' && q.responses.length > 0 && (
        summarizeMutation.isPending && summaryQuestionId === q.id ? (
          <span className="text-xs text-gray-400">Summarizing…</span>
        ) : (
          <button
            onClick={() => {
              if (summaryQuestionId === q.id) { setSummary(null); setSummaryQuestionId(null) }
              else summarizeMutation.mutate(q.id)
            }}
            className="text-xs text-gray-500 hover:text-gray-700 underline underline-offset-2"
          >
            {summaryQuestionId === q.id ? 'Hide summary' : 'Summarize responses'}
          </button>
        )
      )}
      {summary && summaryQuestionId === q.id && (
        <div className="w-full grid grid-cols-1 sm:grid-cols-2 gap-3 mt-1">
          {summary.map((cat) => (
            <div key={cat.label} className="bg-blue-50 border border-blue-100 rounded-xl p-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-blue-900">{cat.label}</span>
                <span className="text-xs text-blue-500">{cat.count} student{cat.count !== 1 ? 's' : ''}</span>
              </div>
              <p className="text-xs text-blue-700">{cat.description}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Response list ────────────────────────────────────────────────────────────

function ResponseList({
  q,
  isGradable,
  gradeReasons,
  overrideScoreMutation,
}: {
  q: QWithGroup
  isGradable: boolean
  gradeReasons: Record<string, string>
  overrideScoreMutation: ReturnType<typeof useMutation<unknown, unknown, { questionId: string; responseId: string; aiScore: number }>>
}) {
  if (q.responses.length === 0) {
    return <p className="text-sm text-gray-400 text-center py-6">No submissions yet</p>
  }
  return (
    <div className="space-y-2 mt-2">
      {q.responses.map((resp) => {
        const score = calcResponseScore(q, resp as ResponseWithStudent)
        return (
          <div key={resp.id} className="bg-gray-50 border border-gray-100 rounded-xl p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-xs text-gray-400 mb-1">
                  {(resp as ResponseWithStudent).student?.name} ·{' '}
                  <span className="font-mono">{(resp as ResponseWithStudent).student?.netId}</span>
                </p>
                {(q.type as string) === 'STRUCTURE'
                  ? <SmilesRenderer smiles={resp.responseText} />
                  : <p className="text-sm text-gray-800 break-words">
                      {q.type === 'FREE_TEXT' ? resp.responseText : <span className="font-medium">{resp.responseText}</span>}
                    </p>
                }
                {gradeReasons[resp.id] && <p className="text-xs text-gray-400 mt-1 italic">{gradeReasons[resp.id]}</p>}
              </div>
              {score !== null && isGradable && (
                <button
                  onClick={() => overrideScoreMutation.mutate({ questionId: q.id, responseId: resp.id, aiScore: cycleScore(resp.aiScore) })}
                  title="Click to cycle score"
                  className={`shrink-0 flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-full border transition-colors ${
                    score === 1.0 ? 'bg-green-50 text-green-700 border-green-200 hover:bg-green-100'
                    : score === 0.5 ? 'bg-yellow-50 text-yellow-700 border-yellow-200 hover:bg-yellow-100'
                    : 'bg-red-50 text-red-600 border-red-200 hover:bg-red-100'
                  }`}
                >
                  {score === 1.0 && <Check size={11} />}
                  {score === 1.0 ? 'Full' : score === 0.5 ? 'Partial' : 'None'}
                </button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
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

  // Deadline editing
  const [editingDeadline, setEditingDeadline] = useState(false)
  const [deadlineDraft, setDeadlineDraft] = useState('')

  // Extensions panel
  const [showExtensions, setShowExtensions] = useState(false)
  const [extStudentId, setExtStudentId] = useState('')
  const [extDeadline, setExtDeadline] = useState('')

  // Add question form
  const [showAddQuestion, setShowAddQuestion] = useState(false)
  const [aqGroupId, setAqGroupId] = useState<string>('')  // '' = ungrouped
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
      text: aqText,
      type: aqType,
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
      // Navigate to the group if grouped, else to the question
      if (q.groupId) setActiveItem({ kind: 'group', groupId: q.groupId })
      else setActiveItem({ kind: 'question', questionId: q.id })
    },
    onError: (e: unknown) => {
      setAqError((e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Failed to add question')
    },
  })

  const updateDeadlineMutation = useMutation({
    mutationFn: (deadline: string | null) => api.patch(`/sessions/${assignmentId}`, { deadline }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['assignment', assignmentId] })
      setEditingDeadline(false)
    },
  })

  const extensionsQuery = useQuery<{ id: string; studentId: string; deadline: string; student: { id: string; name: string; netId: string } }[]>({
    queryKey: ['extensions', assignmentId],
    queryFn: () => api.get(`/sessions/${assignmentId}/extensions`).then((r) => r.data.data.extensions),
    enabled: showExtensions,
  })

  const rosterQuery = useQuery<{ student: { id: string; name: string; netId: string } }[]>({
    queryKey: ['roster', data?.class?.id],
    queryFn: () => api.get(`/classes/${data!.class.id}/enrollments`).then((r) => r.data.data.enrollments),
    enabled: showExtensions && !!data?.class?.id,
  })

  const addExtensionMutation = useMutation({
    mutationFn: ({ studentId, deadline }: { studentId: string; deadline: string }) =>
      api.post(`/sessions/${assignmentId}/extensions`, { studentId, deadline }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['extensions', assignmentId] })
      setExtStudentId('')
      setExtDeadline('')
    },
  })

  const removeExtensionMutation = useMutation({
    mutationFn: (studentId: string) => api.delete(`/sessions/${assignmentId}/extensions/${studentId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['extensions', assignmentId] }),
  })

  const submissionStatusQuery = useQuery<{
    students: { student: { id: string; name: string; netId: string }; section: { name: string } | null; submittedCount: number; totalQuestions: number; isComplete: boolean }[]
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

  // Top-level item numbering: groups first, then ungrouped
  const topLevelItems = [
    ...data.groups.map(g => ({ kind: 'group' as const, id: g.id })),
    ...ungroupedQuestions.map(q => ({ kind: 'question' as const, id: q.id })),
  ]

  // Resolve default active item
  const resolvedActive: ActiveItem | null =
    activeItem ??
    (data.groups.length > 0 ? { kind: 'group', groupId: data.groups[0].id } :
      ungroupedQuestions.length > 0 ? { kind: 'question', questionId: ungroupedQuestions[0].id } : null)

  const activeGroup = resolvedActive?.kind === 'group'
    ? data.groups.find(g => g.id === resolvedActive.groupId)
    : undefined

  const activeQuestion = resolvedActive?.kind === 'question'
    ? allQuestions.find(q => q.id === resolvedActive.questionId)
    : undefined
  const activeQuestionGlobalIdx = activeQuestion ? topLevelItems.findIndex(i => i.kind === 'question' && i.id === activeQuestion.id) : -1

  function openAddQuestion() {
    // Default group: the currently active one (if any)
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
                  <input
                    type="datetime-local"
                    value={deadlineDraft}
                    onChange={(e) => setDeadlineDraft(e.target.value)}
                    className="text-xs border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-primary-500"
                  />
                  <button
                    onClick={() => updateDeadlineMutation.mutate(deadlineDraft || null)}
                    disabled={updateDeadlineMutation.isPending}
                    className="text-xs text-white bg-primary-600 hover:bg-primary-700 px-2.5 py-1 rounded disabled:opacity-50"
                  >Save</button>
                  <button onClick={() => setEditingDeadline(false)} className="text-xs text-gray-400 hover:text-gray-600 px-1.5 py-1">Cancel</button>
                </div>
              ) : (
                <button
                  onClick={() => { setDeadlineDraft(deadline ? toDatetimeLocal(deadline) : ''); setEditingDeadline(true) }}
                  className="flex items-center gap-1 text-sm group"
                >
                  <span className={deadline && new Date(deadline) < new Date() ? 'text-red-500' : 'text-gray-400'}>
                    {deadline ? `Due ${new Date(deadline).toLocaleString()}` : 'No deadline'}
                  </span>
                  <Pencil size={11} className="text-gray-300 group-hover:text-gray-500 transition-colors" />
                </button>
              )}
            </div>

            {/* Extensions toggle */}
            <button
              onClick={() => setShowExtensions((v) => !v)}
              className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 mt-1.5"
            >
              {showExtensions ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              Extensions{extensions.length > 0 ? ` (${extensions.length})` : ''}
            </button>

            {showExtensions && (
              <div className="mt-2 bg-gray-50 border border-gray-200 rounded-xl p-4 w-full max-w-lg">
                {extensions.length > 0 && (
                  <div className="space-y-2 mb-3">
                    {extensions.map((ext) => (
                      <div key={ext.studentId} className="flex items-center justify-between gap-3 text-sm">
                        <span className="text-gray-700 font-medium">{ext.student.name} <span className="text-gray-400 font-normal">({ext.student.netId})</span></span>
                        <span className="text-gray-500 text-xs shrink-0">{new Date(ext.deadline).toLocaleString()}</span>
                        <button
                          onClick={() => removeExtensionMutation.mutate(ext.studentId)}
                          disabled={removeExtensionMutation.isPending}
                          className="text-gray-300 hover:text-red-500 transition-colors shrink-0"
                        ><X size={14} /></button>
                      </div>
                    ))}
                  </div>
                )}
                {extensions.length === 0 && !rosterQuery.isLoading && (
                  <p className="text-xs text-gray-400 mb-3">No extensions granted yet.</p>
                )}
                <div className="flex items-center gap-2 flex-wrap">
                  <select
                    value={extStudentId}
                    onChange={(e) => setExtStudentId(e.target.value)}
                    className="text-xs border border-gray-200 rounded px-2 py-1.5 bg-white text-gray-700 focus:outline-none focus:ring-1 focus:ring-primary-500"
                  >
                    <option value="">Select student…</option>
                    {availableForExtension.map((e) => (
                      <option key={e.student.id} value={e.student.id}>{e.student.name} ({e.student.netId})</option>
                    ))}
                  </select>
                  <input
                    type="datetime-local"
                    value={extDeadline}
                    onChange={(e) => setExtDeadline(e.target.value)}
                    className="text-xs border border-gray-200 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary-500"
                  />
                  <button
                    onClick={() => { if (extStudentId && extDeadline) addExtensionMutation.mutate({ studentId: extStudentId, deadline: new Date(extDeadline).toISOString() }) }}
                    disabled={!extStudentId || !extDeadline || addExtensionMutation.isPending}
                    className="flex items-center gap-1 text-xs text-white bg-primary-600 hover:bg-primary-700 px-2.5 py-1.5 rounded disabled:opacity-50"
                  ><UserPlus size={12} /> Grant</button>
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <a href={`/api/sessions/${assignmentId}/export`} className="flex items-center gap-1.5 border border-gray-200 text-gray-600 px-3 py-2 rounded-lg text-sm hover:bg-gray-50">
              <Download size={14} /> Export CSV
            </a>
            {data.status === SessionStatus.DRAFT ? (
              <button onClick={() => statusMutation.mutate(SessionStatus.OPEN)} disabled={statusMutation.isPending} className="bg-primary-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50">Publish</button>
            ) : data.status === SessionStatus.OPEN ? (
              <div className="flex gap-2">
                <button onClick={() => statusMutation.mutate(SessionStatus.DRAFT)} disabled={statusMutation.isPending} className="text-gray-500 border border-gray-200 px-4 py-2 rounded-lg text-sm hover:bg-gray-50 disabled:opacity-50">Back to Draft</button>
                <button onClick={() => statusMutation.mutate(SessionStatus.CLOSED)} disabled={statusMutation.isPending} className="bg-red-50 text-red-600 border border-red-200 px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-100 disabled:opacity-50">Close</button>
              </div>
            ) : data.status === SessionStatus.CLOSED ? (
              <div className="flex gap-2">
                <button onClick={() => statusMutation.mutate(SessionStatus.OPEN)} disabled={statusMutation.isPending} className="bg-green-50 text-green-700 border border-green-200 px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-100 disabled:opacity-50">Reopen</button>
                <button onClick={() => statusMutation.mutate(SessionStatus.ARCHIVED)} disabled={statusMutation.isPending} className="text-gray-400 border border-gray-200 px-4 py-2 rounded-lg text-sm hover:bg-gray-50 disabled:opacity-50">Archive</button>
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
                    <SortableSidebarItem
                      key={group.id}
                      id={group.id}
                      isDraft={isDraft}
                      isActive={isActive}
                      onClick={() => setActiveItem({ kind: 'group', groupId: group.id })}
                    >
                      {() => (
                        <>
                          <div className="flex items-center gap-1.5 mb-0.5">
                            <span className={`text-xs font-semibold ${isActive ? 'text-primary-700' : 'text-gray-700'}`}>
                              {topIdx + 1}
                            </span>
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
                    <SortableSidebarItem
                      key={q.id}
                      id={q.id}
                      isDraft={isDraft}
                      isActive={isActive}
                      onClick={() => setActiveItem({ kind: 'question', questionId: q.id })}
                    >
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

            {/* Footer */}
            {isDraft && (
              <button
                onClick={openAddQuestion}
                className="w-full flex items-center justify-center gap-1.5 text-xs text-primary-600 hover:text-primary-800 hover:bg-primary-50 py-2.5 border-t border-gray-100 transition-colors"
              >
                <Plus size={13} /> Add question
              </button>
            )}
            <button
              onClick={() => setActiveItem({ kind: 'submissions' })}
              className={`w-full flex items-center justify-center gap-1.5 text-xs py-2.5 border-t border-gray-100 transition-colors ${
                resolvedActive?.kind === 'submissions'
                  ? 'text-primary-700 bg-primary-50'
                  : 'text-gray-400 hover:text-gray-600 hover:bg-gray-50'
              }`}
            >
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
              <textarea
                value={aqText}
                onChange={(e) => setAqText(e.target.value)}
                placeholder="Question text…"
                rows={2}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none"
              />
              <div className="flex items-center gap-3 flex-wrap">
                <label className="flex items-center gap-1.5 text-sm text-gray-600">
                  Type:
                  <select
                    value={aqType}
                    onChange={(e) => setAqType(e.target.value as typeof aqType)}
                    className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none"
                  >
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
                  <select
                    value={aqGroupId}
                    onChange={(e) => setAqGroupId(e.target.value)}
                    className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none"
                  >
                    <option value="">None (standalone)</option>
                    {data.groups.map(g => <option key={g.id} value={g.id}>{g.title || 'Untitled group'}</option>)}
                  </select>
                </label>
                <div className="ml-auto flex gap-2">
                  <button onClick={() => { setShowAddQuestion(false); setAqError('') }} className="text-sm text-gray-500 px-3 py-2">Cancel</button>
                  <button
                    onClick={() => { setAqError(''); addQuestionMutation.mutate() }}
                    disabled={!aqText.trim() || addQuestionMutation.isPending}
                    className="text-sm bg-primary-600 text-white px-4 py-2 rounded-lg hover:bg-primary-700 disabled:opacity-50"
                  >
                    Add
                  </button>
                </div>
              </div>
              {(aqType === 'MULTIPLE_CHOICE' || aqType === 'MULTI_SELECT') && (
                <textarea
                  value={aqOptions}
                  onChange={(e) => setAqOptions(e.target.value)}
                  placeholder={"Option A\nOption B\nOption C"}
                  rows={3}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none"
                />
              )}
              {aqType === 'ORDERING' && (
                <textarea
                  value={aqOptions}
                  onChange={(e) => setAqOptions(e.target.value)}
                  placeholder={"Step 1\nStep 2\nStep 3"}
                  rows={3}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none"
                />
              )}
              {aqType === 'NUMERIC' && (
                <div className="flex gap-2 flex-wrap">
                  <input
                    value={aqNumericAnswer}
                    onChange={(e) => setAqNumericAnswer(e.target.value)}
                    placeholder="Correct answer (e.g. 6.02e23)"
                    className="flex-1 min-w-0 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                  />
                  <input
                    value={aqTolerance}
                    onChange={(e) => setAqTolerance(e.target.value)}
                    placeholder="± tolerance"
                    className="w-32 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                  />
                  <input
                    value={aqUnit}
                    onChange={(e) => setAqUnit(e.target.value)}
                    placeholder="Unit (optional)"
                    className="w-36 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                  />
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
              gradeReasons={gradeReasons}
              rubricDraft={rubricDraft}
              setRubricDraft={setRubricDraft}
              gradeMutation={gradeMutation}
              setCorrectAnswerMutation={setCorrectAnswerMutation}
              overrideScoreMutation={overrideScoreMutation}
              summarizeMutation={summarizeMutation}
              summary={summary}
              summaryQuestionId={summaryQuestionId}
              setSummary={setSummary}
              setSummaryQuestionId={setSummaryQuestionId}
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
              gradeReasons={gradeReasons}
              rubricDraft={rubricDraft}
              setRubricDraft={setRubricDraft}
              gradeMutation={gradeMutation}
              setCorrectAnswerMutation={setCorrectAnswerMutation}
              overrideScoreMutation={overrideScoreMutation}
              summarizeMutation={summarizeMutation}
              summary={summary}
              summaryQuestionId={summaryQuestionId}
              setSummary={setSummary}
              setSummaryQuestionId={setSummaryQuestionId}
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
                        <td className="px-5 py-2.5">
                          <p className="font-medium text-gray-800">{s.student.name}</p>
                          <p className="text-xs text-gray-400">{s.student.netId}</p>
                        </td>
                        <td className="px-3 py-2.5 text-xs text-gray-400">{s.section?.name ?? '—'}</td>
                        <td className="px-5 py-2.5 text-right">
                          <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                            s.isComplete ? 'bg-green-100 text-green-700' : s.submittedCount > 0 ? 'bg-yellow-50 text-yellow-700' : 'bg-red-50 text-red-600'
                          }`}>
                            {s.submittedCount}/{s.totalQuestions}
                          </span>
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
    </ProfessorLayout>
  )
}
