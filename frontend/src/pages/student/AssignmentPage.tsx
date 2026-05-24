import { useState, useEffect, useRef, lazy, Suspense } from 'react'
import { useParams, Link } from 'react-router-dom'
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
import StudentLayout from '@/components/layout/StudentLayout'
import RichTextRenderer from '@/components/RichTextRenderer'
import { ChevronLeft, Clock, Check, GripVertical } from 'lucide-react'
import { apiError } from '@/lib/errors'

const Jsme = lazy(() => import('@loschmidt/jsme-react').then(m => ({ default: m.Jsme })))

interface AssignmentGroup {
  id: string
  title: string
  text: string | null
  order: number
}

interface AssignmentQuestion {
  id: string
  text: string
  type: string
  options: string[] | null
  order: number
  groupId: string | null
  unit: string | null
  existingResponse: { id: string; responseText: string; submittedAt: string } | null
}

interface AssignmentData {
  id: string
  title: string
  status: string
  deadline: string | null
  isPastDue: boolean
  class: { id: string; name: string }
  groups: AssignmentGroup[]
  questions: AssignmentQuestion[]
}

interface GradeQuestion {
  id: string
  response: { responseText: string; aiScore: number | null; submittedAt: string } | null
  score: number
}

interface GradesData {
  questions: GradeQuestion[]
  earned: number
  max: number
}

function SortableOrderItem({ id, label, disabled }: { id: string; label: string; disabled: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-2 px-3 py-2.5 border rounded-xl text-sm text-gray-800 bg-white ${
        disabled ? 'border-gray-200 opacity-60' : 'border-gray-300 cursor-grab active:cursor-grabbing'
      }`}
    >
      {!disabled && (
        <span {...attributes} {...listeners} className="text-gray-300 hover:text-gray-500">
          <GripVertical size={14} />
        </span>
      )}
      {label}
    </div>
  )
}

function ScoreBadge({ score, aiScore, type }: { score: number; aiScore: number | null; type: string }) {
  if (type === 'FREE_TEXT' && aiScore === null) {
    return <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">Pending</span>
  }
  if (score >= 1.0) return <span className="text-xs text-green-700 bg-green-100 px-2 py-0.5 rounded-full">Full credit</span>
  if (score >= 0.5) return <span className="text-xs text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">Partial credit</span>
  return <span className="text-xs text-red-700 bg-red-100 px-2 py-0.5 rounded-full">No credit</span>
}

export default function AssignmentPage() {
  const { assignmentId } = useParams<{ assignmentId: string }>()
  const qc = useQueryClient()
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const jsmeInitialSmiles = useRef<Record<string, string>>({})
  const [submitted, setSubmitted] = useState<Record<string, boolean>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const { data, isLoading } = useQuery<AssignmentData>({
    queryKey: ['student-assignment', assignmentId],
    queryFn: () => api.get(`/student/assignments/${assignmentId}`).then((r) => r.data.data.assignment),
  })

  const isClosed = data?.status === 'CLOSED' || data?.status === 'ARCHIVED'

  const { data: gradesData } = useQuery<GradesData>({
    queryKey: ['student-assignment-grades', assignmentId],
    queryFn: () => api.get(`/student/assignments/${assignmentId}/grades`).then((r) => r.data.data.assignment),
    enabled: isClosed,
  })

  const gradeMap = new Map<string, GradeQuestion>(gradesData?.questions.map((q) => [q.id, q]) ?? [])

  useEffect(() => {
    if (!data) return
    const pre: Record<string, string> = {}
    const done: Record<string, boolean> = {}
    data.questions.forEach((q) => {
      if (q.existingResponse) {
        pre[q.id] = q.existingResponse.responseText
        done[q.id] = true
      } else if (q.type === 'ORDERING' && q.options) {
        // Shuffle once; spread-order means prev wins on re-renders
        pre[q.id] = JSON.stringify([...q.options].sort(() => Math.random() - 0.5))
      }
    })
    setAnswers((prev) => ({ ...pre, ...prev }))
    setSubmitted((prev) => ({ ...done, ...prev }))
  }, [data])

  const submitMutation = useMutation({
    mutationFn: ({ questionId, responseText }: { questionId: string; responseText: string }) =>
      api.post('/responses', { questionId, responseText }),
    onSuccess: (_data, { questionId }) => {
      setSubmitted((prev) => ({ ...prev, [questionId]: true }))
      setErrors((prev) => ({ ...prev, [questionId]: '' }))
      qc.invalidateQueries({ queryKey: ['student-assignment', assignmentId] })
      qc.invalidateQueries({ queryKey: ['student-assignments'] })
    },
    onError: (err: unknown, { questionId }) => {
      setErrors((prev) => ({ ...prev, [questionId]: apiError(err, 'Submission failed — try again') }))
    },
  })

  function handleSubmitQuestion(q: AssignmentQuestion) {
    if (q.type === 'MULTI_SELECT') {
      let selected: string[] = []
      try { selected = JSON.parse(answers[q.id] ?? '[]') } catch { /* ignore */ }
      if (!selected.length) {
        setErrors((prev) => ({ ...prev, [q.id]: 'Please select at least one option' }))
        return
      }
      submitMutation.mutate({ questionId: q.id, responseText: answers[q.id] ?? '[]' })
      return
    }
    if (q.type === 'ORDERING') {
      const order = answers[q.id]
      if (!order) {
        setErrors((prev) => ({ ...prev, [q.id]: 'Please arrange the items' }))
        return
      }
      submitMutation.mutate({ questionId: q.id, responseText: order })
      return
    }
    const text = (answers[q.id] ?? '').trim()
    if (!text) {
      setErrors((prev) => ({ ...prev, [q.id]: 'Please enter an answer' }))
      return
    }
    submitMutation.mutate({ questionId: q.id, responseText: text })
  }

  if (isLoading || !data) {
    return <StudentLayout><p className="text-gray-400 text-center py-12">Loading…</p></StudentLayout>
  }

  const allDone = data.questions.every((q) => submitted[q.id] || !!q.existingResponse)

  // Build display list: groups (with their questions) then ungrouped questions
  type DisplayItem =
    | { kind: 'group'; group: AssignmentGroup }
    | { kind: 'question'; question: AssignmentQuestion; globalIdx: number }

  const displayList: DisplayItem[] = []
  const usedQuestionIds = new Set<string>()
  const globalOrder = data.questions

  data.groups.forEach((group) => {
    const groupQuestions = data.questions.filter((q) => q.groupId === group.id)
    if (groupQuestions.length === 0) return
    displayList.push({ kind: 'group', group })
    groupQuestions.forEach((q) => {
      displayList.push({ kind: 'question', question: q, globalIdx: globalOrder.findIndex((gq) => gq.id === q.id) })
      usedQuestionIds.add(q.id)
    })
  })

  data.questions.forEach((q) => {
    if (!usedQuestionIds.has(q.id)) {
      displayList.push({ kind: 'question', question: q, globalIdx: globalOrder.findIndex((gq) => gq.id === q.id) })
    }
  })

  function renderQuestionCard(q: AssignmentQuestion, globalIdx: number) {
    const isDone = submitted[q.id] || !!q.existingResponse
    const isDisabled = isDone || data!.isPastDue || isClosed || submitMutation.isPending
    const grade = gradeMap.get(q.id)

    return (
      <div key={q.id} className={`bg-white border rounded-2xl p-5 ${isDone ? 'border-green-200' : 'border-gray-200'}`}>
        <div className="flex items-start justify-between gap-3 mb-3">
          <p className="text-xs font-medium text-gray-400 uppercase tracking-wide">Question {globalIdx + 1}</p>
          <div className="flex items-center gap-2 shrink-0">
            {grade && (
              <ScoreBadge score={grade.score} aiScore={grade.response?.aiScore ?? null} type={q.type} />
            )}
            {isDone && !grade && (
              <span className="flex items-center gap-1 text-xs text-green-600 font-medium">
                <Check size={12} /> Submitted
              </span>
            )}
          </div>
        </div>

        <div className="mb-4">
          <RichTextRenderer content={q.text} />
        </div>

        {q.type === 'FREE_TEXT' && (
          <textarea
            rows={4}
            value={answers[q.id] ?? ''}
            onChange={(e) => setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
            disabled={isDisabled}
            placeholder={isDone ? '' : 'Your answer…'}
            className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none disabled:bg-gray-50 disabled:text-gray-500"
          />
        )}

        {q.type === 'MULTIPLE_CHOICE' && q.options && (
          <div className="space-y-2">
            {q.options.map((opt) => (
              <label key={opt} className={`flex items-center gap-3 p-3 border rounded-xl cursor-pointer transition-colors ${
                answers[q.id] === opt ? 'border-primary-500 bg-primary-50' : 'border-gray-200 hover:border-gray-300'
              } ${isDisabled ? 'opacity-60 cursor-not-allowed' : ''}`}>
                <input
                  type="radio"
                  name={`q-${q.id}`}
                  value={opt}
                  checked={answers[q.id] === opt}
                  onChange={() => !isDisabled && setAnswers((prev) => ({ ...prev, [q.id]: opt }))}
                  disabled={isDisabled}
                  className="text-primary-600"
                />
                <span className="text-sm text-gray-800">{opt}</span>
              </label>
            ))}
          </div>
        )}

        {q.type === 'YES_NO' && (
          <div className="flex gap-3">
            {['Yes', 'No'].map((opt) => (
              <label key={opt} className={`flex items-center gap-2 px-4 py-2.5 border rounded-xl cursor-pointer transition-colors ${
                answers[q.id] === opt
                  ? 'border-primary-500 bg-primary-50 text-primary-700'
                  : 'border-gray-200 text-gray-700 hover:border-gray-300'
              } ${isDisabled ? 'opacity-60 cursor-not-allowed' : ''}`}>
                <input
                  type="radio"
                  name={`q-${q.id}`}
                  value={opt}
                  checked={answers[q.id] === opt}
                  onChange={() => !isDisabled && setAnswers((prev) => ({ ...prev, [q.id]: opt }))}
                  disabled={isDisabled}
                  className="sr-only"
                />
                <span className="text-sm font-medium">{opt}</span>
              </label>
            ))}
          </div>
        )}

        {q.type === 'RATING' && (
          <div className="flex gap-2">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                disabled={isDisabled}
                onClick={() => !isDisabled && setAnswers((prev) => ({ ...prev, [q.id]: String(n) }))}
                className={`w-10 h-10 rounded-xl text-sm font-medium border transition-colors ${
                  answers[q.id] === String(n)
                    ? 'border-primary-500 bg-primary-50 text-primary-700'
                    : 'border-gray-200 text-gray-600 hover:border-gray-300'
                } disabled:opacity-60 disabled:cursor-not-allowed`}
              >
                {n}
              </button>
            ))}
          </div>
        )}

        {q.type === 'NUMERIC' && (
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={answers[q.id] ?? ''}
              onChange={(e) => setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
              disabled={isDisabled}
              placeholder={isDone ? '' : 'Your answer…'}
              className="w-48 border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:bg-gray-50 disabled:text-gray-500"
            />
            {q.unit && <span className="text-sm text-gray-500">{q.unit}</span>}
          </div>
        )}

        {q.type === 'MULTI_SELECT' && q.options && (
          <div className="space-y-2">
            {q.options.map((opt) => {
              let selected: string[] = []
              try { selected = JSON.parse(answers[q.id] ?? '[]') } catch { /* ignore */ }
              const isChecked = selected.includes(opt)
              return (
                <label key={opt} className={`flex items-center gap-3 p-3 border rounded-xl cursor-pointer transition-colors ${
                  isChecked ? 'border-primary-500 bg-primary-50' : 'border-gray-200 hover:border-gray-300'
                } ${isDisabled ? 'opacity-60 cursor-not-allowed' : ''}`}>
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => {
                      if (isDisabled) return
                      const next = isChecked ? selected.filter(v => v !== opt) : [...selected, opt]
                      setAnswers((prev) => ({ ...prev, [q.id]: JSON.stringify(next) }))
                    }}
                    disabled={isDisabled}
                    className="text-primary-600"
                  />
                  <span className="text-sm text-gray-800">{opt}</span>
                </label>
              )
            })}
          </div>
        )}

        {q.type === 'ORDERING' && q.options && (() => {
          let order: string[] = []
          try { order = JSON.parse(answers[q.id] ?? '[]') } catch { order = q.options }
          if (!order.length) order = q.options
          return (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={(event: DragEndEvent) => {
                if (isDisabled) return
                const { active, over } = event
                if (!over || active.id === over.id) return
                const oldIdx = order.indexOf(active.id as string)
                const newIdx = order.indexOf(over.id as string)
                if (oldIdx === -1 || newIdx === -1) return
                const next = arrayMove(order, oldIdx, newIdx)
                setAnswers((prev) => ({ ...prev, [q.id]: JSON.stringify(next) }))
              }}
            >
              <SortableContext items={order} strategy={verticalListSortingStrategy}>
                <div className="space-y-2">
                  {order.map((item) => (
                    <SortableOrderItem key={item} id={item} label={item} disabled={isDisabled} />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          )
        })()}

        {q.type === 'STRUCTURE' && (
          <Suspense fallback={<div className="h-48 bg-gray-50 rounded-lg animate-pulse" />}>
            <Jsme
              height="420px"
              width="600px"
              smiles={(jsmeInitialSmiles.current[q.id] ??= answers[q.id] ?? '')}
              onChange={(smiles: string) => !isDisabled && setAnswers((prev) => ({ ...prev, [q.id]: smiles }))}
              disabled={isDisabled}
            />
          </Suspense>
        )}

        {errors[q.id] && <p className="text-red-500 text-xs mt-2">{errors[q.id]}</p>}

        {!isDone && !data!.isPastDue && !isClosed && (
          <button
            onClick={() => handleSubmitQuestion(q)}
            disabled={
              submitMutation.isPending ||
              (!answers[q.id] && q.type !== 'ORDERING' && q.type !== 'STRUCTURE') ||
              (q.type === 'NUMERIC' && isNaN(parseFloat(answers[q.id] ?? ''))) ||
              (q.type === 'MULTI_SELECT' && (() => { try { return !JSON.parse(answers[q.id] ?? '[]').length } catch { return true } })())
            }
            className="mt-4 px-5 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50"
          >
            {submitMutation.isPending ? 'Submitting…' : 'Submit'}
          </button>
        )}
      </div>
    )
  }

  return (
    <StudentLayout>
      <div className="mb-6">
        <Link to="/student/classes" className="flex items-center gap-1 text-sm text-gray-400 hover:text-gray-600 mb-3">
          <ChevronLeft size={16} /> {data.class.name}
        </Link>
        <div className="flex items-start justify-between gap-3">
          <h1 className="text-xl font-bold text-gray-900">{data.title}</h1>
          <div className="flex items-center gap-2 shrink-0 mt-1">
            {isClosed && (
              <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">Closed</span>
            )}
            {data.deadline && !isClosed && (
              <span className={`flex items-center gap-1 text-xs ${data.isPastDue ? 'text-red-500' : 'text-gray-400'}`}>
                <Clock size={12} />
                {data.isPastDue ? 'Past due' : `Due ${new Date(data.deadline).toLocaleString()}`}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Grade summary banner */}
      {isClosed && gradesData && (
        <div className="mb-5 bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 flex items-center justify-between">
          <span className="text-sm text-blue-800 font-medium">Assignment closed</span>
          <span className="text-sm text-blue-700">
            Score: <span className="font-semibold">{gradesData.earned} / {gradesData.max}</span>
          </span>
        </div>
      )}

      {data.isPastDue && !allDone && !isClosed && (
        <div className="mb-5 bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700">
          This assignment is past due. No further submissions are accepted.
        </div>
      )}

      {allDone && !isClosed && (
        <div className="mb-5 bg-green-50 border border-green-200 rounded-xl px-4 py-3 text-sm text-green-700 flex items-center gap-2">
          <Check size={16} /> All questions submitted.
        </div>
      )}

      <div className="space-y-4">
        {displayList.map((item) => {
          if (item.kind === 'group') {
            return (
              <div key={`group-${item.group.id}`} className="pt-2">
                <div className="bg-amber-50 border border-amber-100 rounded-2xl p-5 mb-1">
                  <p className="text-sm font-semibold text-amber-900 mb-2">{item.group.title}</p>
                  {item.group.text && <RichTextRenderer content={item.group.text} />}
                </div>
              </div>
            )
          }
          return renderQuestionCard(item.question, item.globalIdx)
        })}
      </div>
    </StudentLayout>
  )
}
