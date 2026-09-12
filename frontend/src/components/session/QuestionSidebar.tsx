import { useCallback } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext, verticalListSortingStrategy, useSortable, arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, Plus, Trash2 } from 'lucide-react'
import { api } from '@/api/client'
import { calcResponseScore } from '@/lib/scoring'
import type { QuestionWithResponses, SessionDetail } from 'shared'

/** Sidebar label: the professor-set title, else a trimmed snippet of the question text. */
export function questionLabel(q: { title?: string | null; text: string }): string {
  const title = q.title?.trim()
  if (title) return title
  return q.text.length > 60 ? q.text.slice(0, 60).trimEnd() + '…' : q.text
}

/** Types whose responses carry a score worth counting. */
const SCORABLE = ['FREE_TEXT', 'MULTIPLE_CHOICE', 'YES_NO', 'NUMERIC']

/**
 * How far along grading is, in the fewest characters that still say it.
 *
 * The old sidebar built a sentence of this and then put it in a `title`, rendering only
 * the response count in a colour you had to decode. The colour stays as the glance; this
 * is what it meant.
 */
function gradingSummary(q: QuestionWithResponses): { label: string; tone: string } | null {
  const n = q.responses.length
  if (n === 0) return null
  if (!SCORABLE.includes(q.type)) {
    return { label: `${n} response${n !== 1 ? 's' : ''}`, tone: 'text-ink-2/40' }
  }
  const scored = q.responses.filter((r) => calcResponseScore(q, r) !== null).length
  if (scored === 0) return { label: `${n} ungraded`, tone: 'text-warn' }
  if (scored < n) return { label: `${scored}/${n} graded`, tone: 'text-yellow-500' }
  return { label: `${n} graded`, tone: 'text-good' }
}

interface RowProps {
  question: QuestionWithResponses
  index: number
  isActive: boolean
  canReorder: boolean
  canDelete: boolean
  isDeleting: boolean
  onSelect: () => void
  onDelete: () => void
}

function Row({
  question, index, isActive, canReorder, canDelete, isDeleting, onSelect, onDelete,
}: RowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: question.id, disabled: !canReorder })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }
  const summary = gradingSummary(question)

  return (
    <li ref={setNodeRef} style={style} className="group relative">
      <button
        onClick={onSelect}
        className={`w-full text-left pl-2 pr-8 py-2 border-l-2 transition-colors flex items-start gap-1.5 ${
          isActive ? 'border-signal bg-signal-soft' : 'border-transparent hover:bg-surface-2'
        }`}
      >
        {canReorder && (
          <span
            {...attributes}
            {...listeners}
            aria-label={`Reorder question ${index + 1}`}
            onClick={(e) => e.stopPropagation()}
            className="mt-0.5 shrink-0 text-hairline-strong group-hover:text-muted cursor-grab active:cursor-grabbing"
          >
            <GripVertical size={13} />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className={`text-xs font-mono shrink-0 ${isActive ? 'text-signal font-bold' : 'text-hairline-strong'}`}>
              Q{index + 1}
            </span>
            <span className={`text-sm leading-snug line-clamp-2 ${isActive ? 'text-ink font-medium' : 'text-ink-2'}`}>
              {questionLabel(question)}
            </span>
          </span>
          {summary && (
            <span className={`block text-[10px] font-mono mt-0.5 ml-[1.9rem] ${summary.tone}`}>
              {summary.label}
            </span>
          )}
        </span>
      </button>

      {canDelete && (
        <button
          onClick={onDelete}
          disabled={isDeleting}
          className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity absolute top-2 right-2 w-5 h-5 flex items-center justify-center text-hairline-strong hover:text-red-500 rounded-sm disabled:opacity-30"
          title="Delete question"
        >
          <Trash2 size={12} />
        </button>
      )}
    </li>
  )
}

interface Props {
  sessionId: string
  questions: QuestionWithResponses[]
  activeIndex: number
  onSelect: (index: number) => void
  /** A run is open. Structural edits wait for it to close. */
  isLive: boolean
  isArchived: boolean
  isDeleting: boolean
  onAdd: () => void
  onDelete: (question: QuestionWithResponses, index: number) => void
}

/**
 * The question list: what each question is, how far its grading got, and the order they
 * are asked in.
 *
 * Dragging uses the same dnd-kit setup as the assignment page, against the reorder route
 * that already existed — `PUT /sessions/:id/questions/reorder`. Reordering is closed off
 * while a run is open, for the same reason adding and deleting are: the numbering is what
 * a professor says out loud, and renumbering mid-lecture makes a liar of them.
 */
export default function QuestionSidebar({
  sessionId, questions, activeIndex, onSelect, isLive, isArchived, isDeleting, onAdd, onDelete,
}: Props) {
  const qc = useQueryClient()
  const canEditStructure = !isLive && !isArchived

  const reorder = useMutation({
    mutationFn: (items: { id: string; order: number }[]) =>
      api.put(`/sessions/${sessionId}/questions/reorder`, items),
    // Deliberately no invalidate on success: the cache was already moved to the new order
    // below, and refetching here would make the list jump if the write is slow.
    onError: () => qc.invalidateQueries({ queryKey: ['session', sessionId] }),
  })

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const onDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const from = questions.findIndex((q) => q.id === active.id)
    const to = questions.findIndex((q) => q.id === over.id)
    if (from === -1 || to === -1) return

    // Which question is open, by identity — the active index is about to mean something
    // different, and the professor should not find themselves looking at another question
    // because they moved this one.
    const openId = questions[activeIndex]?.id
    const reordered = arrayMove(questions, from, to)

    qc.setQueryData<SessionDetail>(['session', sessionId], (prev) =>
      prev ? { ...prev, questions: reordered } : prev)

    const nextActive = reordered.findIndex((q) => q.id === openId)
    if (nextActive !== -1 && nextActive !== activeIndex) onSelect(nextActive)

    reorder.mutate(reordered.map((q, i) => ({ id: q.id, order: i })))
  }, [questions, activeIndex, onSelect, qc, sessionId, reorder])

  return (
    <aside className="w-64 shrink-0 sticky top-6">
      <div className="bg-surface border border-hairline rounded-[14px] overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2.5 border-b border-hairline">
          <p className="text-xs font-medium text-muted uppercase tracking-wide">Questions</p>
          <span className="text-xs text-hairline-strong font-mono">{questions.length}</span>
        </div>

        {questions.length === 0 ? (
          <p className="px-3 py-4 text-xs text-muted">No questions yet.</p>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={questions.map((q) => q.id)} strategy={verticalListSortingStrategy}>
              <ul className="py-1">
                {questions.map((q, i) => (
                  <Row
                    key={q.id}
                    question={q}
                    index={i}
                    isActive={activeIndex === i}
                    canReorder={canEditStructure && questions.length > 1}
                    canDelete={canEditStructure}
                    isDeleting={isDeleting}
                    onSelect={() => onSelect(i)}
                    onDelete={() => onDelete(q, i)}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        )}

        <div className="border-t border-hairline p-2">
          <button
            onClick={onAdd}
            disabled={isLive}
            title={isLive ? 'Close the session to add questions' : 'Add a new question'}
            className="w-full flex items-center justify-center gap-1.5 text-xs font-medium text-signal hover:bg-signal-soft disabled:text-muted disabled:hover:bg-transparent disabled:cursor-not-allowed px-2 py-2 rounded-sm transition-colors"
          >
            <Plus size={13} /> Add New Question
          </button>
        </div>

        {reorder.isError && (
          <p className="px-3 pb-2 text-[11px] text-red-500">Could not save the new order.</p>
        )}
      </div>
    </aside>
  )
}
