import { useState } from 'react'
import { useQueryClient, useMutation } from '@tanstack/react-query'
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { api } from '@/api/client'
import RichTextRenderer from '@/components/RichTextRenderer'
import RichTextEditor from '@/components/RichTextEditor'
import { Plus, Trash2, GripVertical } from 'lucide-react'
import type { QuestionGroup, SessionDetail, SummaryCategory } from 'shared'
import { SessionStatus } from 'shared'
import { apiError } from '@/lib/errors'
import GradingControls from './GradingControls'
import ResponseList from './ResponseList'
import type { QWithGroup } from './types'

// ─── PartCard (only used inside GroupPanel) ───────────────────────────────────

function PartCard({
  q, partIdx, assignmentId, isDraft, isGradable, onDeleted,
  gradeReasons, rubricDraft, setRubricDraft,
  gradeMutation, setCorrectAnswerMutation, overrideScoreMutation,
  summarizeMutation, summary, summaryQuestionId, setSummary, setSummaryQuestionId,
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
      className="bg-surface border border-hairline rounded-[14px] p-5"
    >
      <div className="flex items-start gap-2 mb-3">
        {isDraft && (
          <span
            {...attributes}
            {...listeners}
            className="mt-0.5 text-hairline-strong hover:text-muted cursor-grab active:cursor-grabbing shrink-0"
          >
            <GripVertical size={14} />
          </span>
        )}
        <p className="text-xs font-medium text-muted uppercase tracking-wide">
          Part {partIdx + 1} · {q.type.replace('_', ' ').toLowerCase()}
        </p>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted font-mono">{q.responses.length} resp</span>
          {isDraft && (
            <button
              onClick={async () => {
                if (!confirm('Delete this part? This cannot be undone.')) return
                await api.delete(`/sessions/${assignmentId}/questions/${q.id}`)
                onDeleted()
              }}
              className="text-hairline-strong hover:text-red-500 transition-colors"
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
            <span key={opt} className="text-xs bg-surface-2 px-2.5 py-1 rounded-full text-ink-2">{opt}</span>
          ))}
        </div>
      )}
      {(q.type as string) === 'ORDERING' && Array.isArray(q.options) && (
        <ol className="text-xs text-muted list-decimal list-inside space-y-0.5 mb-3">
          {(q.options as string[]).map((opt, i) => <li key={i}>{opt}</li>)}
        </ol>
      )}

      {isAnswerKeyEditable && (
        <GradingControls
          q={q} rubricDraft={rubricDraft} setRubricDraft={setRubricDraft}
          gradeMutation={gradeMutation} setCorrectAnswerMutation={setCorrectAnswerMutation}
          summarizeMutation={summarizeMutation} summary={summary}
          summaryQuestionId={summaryQuestionId} setSummary={setSummary} setSummaryQuestionId={setSummaryQuestionId}
        />
      )}
      <ResponseList q={q} isGradable={isGradable} gradeReasons={gradeReasons} overrideScoreMutation={overrideScoreMutation} />
    </div>
  )
}

// ─── GroupPanel ───────────────────────────────────────────────────────────────

interface Props {
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
}

export default function GroupPanel({
  group, questions, assignmentId, sessionStatus, onDeleted,
  gradeReasons, rubricDraft, setRubricDraft,
  gradeMutation, setCorrectAnswerMutation, overrideScoreMutation,
  summarizeMutation, summary, summaryQuestionId, setSummary, setSummaryQuestionId,
}: Props) {
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
    onError: (e: unknown) => setPartError(apiError(e, 'Failed to add part')),
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

  const sharedGradingProps = {
    gradeReasons, rubricDraft, setRubricDraft,
    gradeMutation, setCorrectAnswerMutation, overrideScoreMutation,
    summarizeMutation, summary, summaryQuestionId, setSummary, setSummaryQuestionId,
  }

  return (
    <div className="space-y-5">
      {/* Group header card */}
      <div className="bg-surface border border-hairline rounded-[14px] p-5">
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs font-medium text-muted uppercase tracking-wide">Multi-part question</p>
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
                <button onClick={() => setShowDeleteConfirm(false)} className="text-xs text-muted">Cancel</button>
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
          className="w-full text-base font-semibold text-ink border-b border-transparent hover:border-hairline focus:border-signal focus:outline-none pb-1 mb-4 bg-transparent"
          placeholder="Question title / shared context"
        />

        {(group.text || isDraft) && (
          <>
            {isDraft ? (
              <>
                <p className="text-xs text-muted mb-1.5">Shared context (optional — shown above all parts)</p>
                <RichTextEditor
                  key={group.id}
                  content={textDraft}
                  onChange={(json) => { setTextDraft(json); setTextDirty(true) }}
                />
                {textDirty && (
                  <button
                    onClick={() => { updateMutation.mutate({ text: textDraft }); setTextDirty(false) }}
                    disabled={updateMutation.isPending}
                    className="mt-2 px-3 py-1.5 bg-signal text-white rounded-sm text-xs font-medium hover:bg-[var(--signal-bright)] disabled:opacity-50"
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
              {...sharedGradingProps}
            />
          ))}
        </SortableContext>
      </DndContext>

      {/* Add part */}
      {isDraft && !showAddPart && (
        <button onClick={() => setShowAddPart(true)} className="flex items-center gap-1.5 text-sm text-signal hover:text-signal">
          <Plus size={14} /> Add part
        </button>
      )}
      {showAddPart && (
        <div className="border border-hairline rounded-[14px] p-4 bg-surface-2 space-y-3">
          <h4 className="text-sm font-medium text-ink-2">New part</h4>
          <textarea
            value={partText}
            onChange={(e) => setPartText(e.target.value)}
            placeholder="Part question text…"
            rows={2}
            className="w-full border border-hairline rounded-[14px] px-3 py-2 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-signal resize-none"
          />
          <div className="flex items-center gap-3">
            <select
              value={partType}
              onChange={(e) => setPartType(e.target.value as typeof partType)}
              className="border border-hairline rounded-sm px-3 py-2 text-sm bg-surface focus:outline-none"
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
              <button onClick={() => { setShowAddPart(false); setPartError('') }} className="text-sm text-muted px-3 py-1.5">Cancel</button>
              <button
                onClick={() => { setPartError(''); addPartMutation.mutate() }}
                disabled={!partText.trim() || addPartMutation.isPending}
                className="text-sm bg-signal text-white px-4 py-1.5 rounded-sm hover:bg-[var(--signal-bright)] disabled:opacity-50"
              >Add</button>
            </div>
          </div>
          {(partType === 'MULTIPLE_CHOICE' || partType === 'MULTI_SELECT') && (
            <textarea value={partOptions} onChange={(e) => setPartOptions(e.target.value)}
              placeholder={"Option A\nOption B\nOption C"} rows={3}
              className="w-full border border-hairline rounded-[14px] px-3 py-2 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-signal resize-none" />
          )}
          {partType === 'ORDERING' && (
            <textarea value={partOptions} onChange={(e) => setPartOptions(e.target.value)}
              placeholder={"Step 1\nStep 2\nStep 3"} rows={3}
              className="w-full border border-hairline rounded-[14px] px-3 py-2 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-signal resize-none" />
          )}
          {partType === 'NUMERIC' && (
            <div className="flex gap-2 flex-wrap">
              <input value={partNumericAnswer} onChange={(e) => setPartNumericAnswer(e.target.value)}
                placeholder="Correct answer (e.g. 6.02e23)"
                className="flex-1 min-w-0 border border-hairline rounded-sm px-3 py-2 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-signal" />
              <input value={partTolerance} onChange={(e) => setPartTolerance(e.target.value)}
                placeholder="± tolerance"
                className="w-32 border border-hairline rounded-sm px-3 py-2 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-signal" />
              <input value={partUnit} onChange={(e) => setPartUnit(e.target.value)}
                placeholder="Unit (optional)"
                className="w-36 border border-hairline rounded-sm px-3 py-2 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-signal" />
            </div>
          )}
          {partError && <p className="text-red-500 text-xs">{partError}</p>}
        </div>
      )}
    </div>
  )
}
