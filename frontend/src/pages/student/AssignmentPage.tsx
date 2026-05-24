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
import RichTextRenderer from '@/components/RichTextRenderer'
import { ChevronLeft, ChevronRight, Check, Clock, GripVertical, Save } from 'lucide-react'

const Jsme = lazy(() => import('@loschmidt/jsme-react').then(m => ({ default: m.Jsme })))

// ─── Types ────────────────────────────────────────────────────────────────────

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

type GroupedQuestion = { question: AssignmentQuestion; globalIdx: number }

type DisplayItem =
  | { kind: 'group'; group: AssignmentGroup; questions: GroupedQuestion[] }
  | { kind: 'question'; question: AssignmentQuestion; globalIdx: number }

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
  if (type === 'FREE_TEXT' && aiScore === null)
    return <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">Pending</span>
  if (score >= 1.0) return <span className="text-xs text-green-700 bg-green-100 px-2 py-0.5 rounded-full">Full credit</span>
  if (score >= 0.5) return <span className="text-xs text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">Partial credit</span>
  return <span className="text-xs text-red-700 bg-red-100 px-2 py-0.5 rounded-full">No credit</span>
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

function Sidebar({
  displayList,
  currentStep,
  onStep,
  answers,
  gradeMap,
  isClosed,
}: {
  displayList: DisplayItem[]
  currentStep: number
  onStep: (i: number) => void
  answers: Record<string, string>
  gradeMap: Map<string, GradeQuestion>
  isClosed: boolean
}) {
  return (
    <aside className="hidden md:flex w-56 shrink-0 flex-col border-r border-gray-200 bg-white">
      <div className="px-4 py-3 border-b border-gray-100 shrink-0">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Questions</p>
      </div>
      <nav className="flex-1 overflow-y-auto py-2">
        {displayList.map((item, i) => {
          const isActive = i === currentStep
          if (item.kind === 'group') {
            const groupAllSaved = item.questions.every(({ question: q }) => !!q.existingResponse)
            const groupAnyDraft = item.questions.some(({ question: q }) => !!answers[q.id] && !q.existingResponse)
            return (
              <button
                key={`group-${item.group.id}`}
                onClick={() => onStep(i)}
                className={`w-full text-left px-4 py-2.5 flex items-center justify-between gap-2 transition-colors ${
                  isActive ? 'bg-primary-50 text-primary-700' : 'text-gray-600 hover:bg-gray-50'
                }`}
              >
                <span className="text-xs font-medium truncate">{item.group.title}</span>
                {groupAllSaved ? (
                  <Check size={12} className="shrink-0 text-green-500" />
                ) : groupAnyDraft ? (
                  <Save size={12} className="shrink-0 text-amber-400" />
                ) : isActive ? (
                  <ChevronRight size={12} className="shrink-0 text-primary-400" />
                ) : null}
              </button>
            )
          }

          const q = item.question
          const grade = gradeMap.get(q.id)
          const hasDraft = !!answers[q.id] && !q.existingResponse
          const isSubmitted = !!q.existingResponse

          return (
            <button
              key={`q-${q.id}`}
              onClick={() => onStep(i)}
              className={`w-full text-left px-4 py-2.5 flex items-center justify-between gap-2 transition-colors ${
                isActive ? 'bg-primary-50 text-primary-700' : 'text-gray-600 hover:bg-gray-50'
              }`}
            >
              <span className="text-xs truncate">Q{item.globalIdx + 1}</span>
              {isClosed && grade ? (
                <ScoreBadge score={grade.score} aiScore={grade.response?.aiScore ?? null} type={q.type} />
              ) : isSubmitted ? (
                <Check size={12} className="shrink-0 text-green-500" />
              ) : hasDraft ? (
                <Save size={12} className="shrink-0 text-amber-400" />
              ) : null}
            </button>
          )
        })}
      </nav>
    </aside>
  )
}

// ─── Mobile progress bar ──────────────────────────────────────────────────────

function MobileProgress({
  displayList,
  currentStep,
  onStep,
  answers,
}: {
  displayList: DisplayItem[]
  currentStep: number
  onStep: (i: number) => void
  answers: Record<string, string>
}) {
  const total = displayList.length
  return (
    <div className="md:hidden flex items-center gap-2 px-4 py-2 border-b border-gray-200 bg-white overflow-x-auto shrink-0">
      {displayList.map((item, i) => {
        const isActive = i === currentStep
        let isSubmitted = false
        let hasDraft = false
        let label: React.ReactNode = '§'
        if (item.kind === 'question') {
          isSubmitted = !!item.question.existingResponse
          hasDraft = !!answers[item.question.id] && !item.question.existingResponse
          label = item.globalIdx + 1
        } else {
          isSubmitted = item.questions.every(({ question: q }) => !!q.existingResponse)
          hasDraft = item.questions.some(({ question: q }) => !!answers[q.id] && !q.existingResponse)
        }
        return (
          <button
            key={i}
            onClick={() => onStep(i)}
            className={`shrink-0 w-7 h-7 rounded-full text-xs font-medium transition-colors ${
              isActive
                ? 'bg-primary-600 text-white'
                : isSubmitted
                ? 'bg-green-100 text-green-700'
                : hasDraft
                ? 'bg-amber-100 text-amber-700'
                : 'bg-gray-100 text-gray-500'
            }`}
          >
            {label}
          </button>
        )
      })}
      <span className="shrink-0 text-xs text-gray-400 ml-1">{currentStep + 1}/{total}</span>
    </div>
  )
}

// ─── Main page ─────────────────────────────────────────────────────────────────

export default function AssignmentPage() {
  const { assignmentId } = useParams<{ assignmentId: string }>()
  const qc = useQueryClient()

  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [currentStep, setCurrentStep] = useState(0)
  const [saveStatus, setSaveStatus] = useState<Record<string, 'saving' | 'saved' | null>>({})
  const jsmeInitialSmiles = useRef<Record<string, string>>({})
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const { data, isLoading } = useQuery<AssignmentData>({
    queryKey: ['student-assignment', assignmentId],
    queryFn: () => api.get(`/student/assignments/${assignmentId}`).then((r) => r.data.data.assignment),
  })

  const isClosed = data?.status === 'CLOSED' || data?.status === 'ARCHIVED'
  const isLocked = isClosed || !!data?.isPastDue

  const { data: gradesData } = useQuery<GradesData>({
    queryKey: ['student-assignment-grades', assignmentId],
    queryFn: () => api.get(`/student/assignments/${assignmentId}/grades`).then((r) => r.data.data.assignment),
    enabled: isClosed,
  })

  const gradeMap = new Map<string, GradeQuestion>(gradesData?.questions.map((q) => [q.id, q]) ?? [])

  // Pre-fill from existing responses
  useEffect(() => {
    if (!data) return
    const pre: Record<string, string> = {}
    data.questions.forEach((q) => {
      if (q.existingResponse) pre[q.id] = q.existingResponse.responseText
      else if (q.type === 'ORDERING' && q.options)
        pre[q.id] = JSON.stringify([...q.options].sort(() => Math.random() - 0.5))
    })
    setAnswers((prev) => ({ ...pre, ...prev }))
  }, [data])

  // Auto-save mutation
  const saveMutation = useMutation({
    mutationFn: ({ questionId, responseText }: { questionId: string; responseText: string }) =>
      api.post('/responses', { questionId, responseText }),
    onSuccess: (_res, { questionId }) => {
      setSaveStatus((prev) => ({ ...prev, [questionId]: 'saved' }))
      qc.invalidateQueries({ queryKey: ['student-assignment', assignmentId] })
      qc.invalidateQueries({ queryKey: ['student-assignments'] })
    },
    onError: (_err, { questionId }) => {
      setSaveStatus((prev) => ({ ...prev, [questionId]: null }))
    },
  })

  // Submit assignment mutation
  const submitMutation = useMutation({
    mutationFn: () => api.post(`/student/assignments/${assignmentId}/submit`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['student-assignment', assignmentId] })
      qc.invalidateQueries({ queryKey: ['student-assignments'] })
    },
  })

  // Debounced auto-save
  function scheduleAutoSave(questionId: string, responseText: string) {
    setSaveStatus((prev) => ({ ...prev, [questionId]: 'saving' }))
    clearTimeout(saveTimers.current[questionId])
    saveTimers.current[questionId] = setTimeout(() => {
      saveMutation.mutate({ questionId, responseText })
    }, 1500)
  }

  function setAnswer(questionId: string, value: string) {
    setAnswers((prev) => ({ ...prev, [questionId]: value }))
    scheduleAutoSave(questionId, value)
  }

  if (isLoading || !data) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <p className="text-gray-400">Loading…</p>
      </div>
    )
  }

  // Build display list
  const displayList: DisplayItem[] = []
  const usedIds = new Set<string>()
  const globalOrder = data.questions

  data.groups.forEach((group) => {
    const groupQuestions = data.questions
      .filter((q) => q.groupId === group.id)
      .map((q) => ({ question: q, globalIdx: globalOrder.findIndex((gq) => gq.id === q.id) }))
    if (!groupQuestions.length) return
    groupQuestions.forEach(({ question }) => usedIds.add(question.id))
    displayList.push({ kind: 'group', group, questions: groupQuestions })
  })
  data.questions.forEach((q) => {
    if (!usedIds.has(q.id))
      displayList.push({ kind: 'question', question: q, globalIdx: globalOrder.findIndex((gq) => gq.id === q.id) })
  })

  const safeStep = Math.min(currentStep, displayList.length - 1)
  const currentItem = displayList[safeStep]
  const hasExplicitlySubmitted = submitMutation.isSuccess

  function renderQuestionCard(q: AssignmentQuestion, globalIdx: number) {
    const isSubmitted = !!q.existingResponse
    const isDisabled = isLocked || hasExplicitlySubmitted
    const grade = gradeMap.get(q.id)
    const status = saveStatus[q.id]

    return (
      <div key={q.id} className={`bg-white border rounded-2xl p-6 ${isSubmitted ? 'border-green-200' : 'border-gray-200'}`}>
        <div className="flex items-start justify-between gap-3 mb-4">
          <p className="text-xs font-medium text-gray-400 uppercase tracking-wide">Question {globalIdx + 1}</p>
          <div className="flex items-center gap-2 shrink-0">
            {grade && <ScoreBadge score={grade.score} aiScore={grade.response?.aiScore ?? null} type={q.type} />}
            {!grade && isSubmitted && (
              <span className="flex items-center gap-1 text-xs text-green-600 font-medium">
                <Check size={12} /> Saved
              </span>
            )}
            {!isSubmitted && status === 'saving' && <span className="text-xs text-gray-400">Saving…</span>}
            {!isSubmitted && status === 'saved' && <span className="text-xs text-green-500">Saved ✓</span>}
          </div>
        </div>

        <div className="mb-5">
          <RichTextRenderer content={q.text} />
        </div>

        {q.type === 'FREE_TEXT' && (
          <textarea
            rows={5}
            value={answers[q.id] ?? ''}
            onChange={(e) => setAnswer(q.id, e.target.value)}
            disabled={isDisabled}
            placeholder={isDisabled ? '' : 'Your answer…'}
            className="w-full border border-gray-300 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none disabled:bg-gray-50 disabled:text-gray-500"
          />
        )}

        {q.type === 'MULTIPLE_CHOICE' && q.options && (
          <div className="space-y-2">
            {q.options.map((opt) => (
              <label key={opt} className={`flex items-center gap-3 p-3.5 border rounded-xl cursor-pointer transition-colors ${
                answers[q.id] === opt ? 'border-primary-500 bg-primary-50' : 'border-gray-200 hover:border-gray-300'
              } ${isDisabled ? 'opacity-60 cursor-not-allowed' : ''}`}>
                <input type="radio" name={`q-${q.id}`} value={opt} checked={answers[q.id] === opt}
                  onChange={() => !isDisabled && setAnswer(q.id, opt)} disabled={isDisabled} className="text-primary-600" />
                <span className="text-sm text-gray-800">{opt}</span>
              </label>
            ))}
          </div>
        )}

        {q.type === 'YES_NO' && (
          <div className="flex gap-3">
            {['Yes', 'No'].map((opt) => (
              <label key={opt} className={`flex items-center gap-2 px-5 py-3 border rounded-xl cursor-pointer transition-colors ${
                answers[q.id] === opt ? 'border-primary-500 bg-primary-50 text-primary-700' : 'border-gray-200 text-gray-700 hover:border-gray-300'
              } ${isDisabled ? 'opacity-60 cursor-not-allowed' : ''}`}>
                <input type="radio" name={`q-${q.id}`} value={opt} checked={answers[q.id] === opt}
                  onChange={() => !isDisabled && setAnswer(q.id, opt)} disabled={isDisabled} className="sr-only" />
                <span className="text-sm font-medium">{opt}</span>
              </label>
            ))}
          </div>
        )}

        {q.type === 'RATING' && (
          <div className="flex gap-2">
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} type="button" disabled={isDisabled}
                onClick={() => !isDisabled && setAnswer(q.id, String(n))}
                className={`w-12 h-12 rounded-xl text-sm font-medium border transition-colors ${
                  answers[q.id] === String(n) ? 'border-primary-500 bg-primary-50 text-primary-700' : 'border-gray-200 text-gray-600 hover:border-gray-300'
                } disabled:opacity-60 disabled:cursor-not-allowed`}
              >{n}</button>
            ))}
          </div>
        )}

        {q.type === 'NUMERIC' && (
          <div className="flex items-center gap-2">
            <input type="text" value={answers[q.id] ?? ''}
              onChange={(e) => setAnswer(q.id, e.target.value)}
              disabled={isDisabled} placeholder={isDisabled ? '' : 'Your answer…'}
              className="w-48 border border-gray-300 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:bg-gray-50 disabled:text-gray-500"
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
                <label key={opt} className={`flex items-center gap-3 p-3.5 border rounded-xl cursor-pointer transition-colors ${
                  isChecked ? 'border-primary-500 bg-primary-50' : 'border-gray-200 hover:border-gray-300'
                } ${isDisabled ? 'opacity-60 cursor-not-allowed' : ''}`}>
                  <input type="checkbox" checked={isChecked} disabled={isDisabled} className="text-primary-600"
                    onChange={() => {
                      if (isDisabled) return
                      const next = isChecked ? selected.filter(v => v !== opt) : [...selected, opt]
                      setAnswer(q.id, JSON.stringify(next))
                    }}
                  />
                  <span className="text-sm text-gray-800">{opt}</span>
                </label>
              )
            })}
          </div>
        )}

        {q.type === 'ORDERING' && q.options && (() => {
          let order: string[] = []
          try { order = JSON.parse(answers[q.id] ?? '[]') } catch { order = q.options! }
          if (!order.length) order = q.options!
          return (
            <DndContext sensors={sensors} collisionDetection={closestCenter}
              onDragEnd={(event: DragEndEvent) => {
                if (isDisabled) return
                const { active, over } = event
                if (!over || active.id === over.id) return
                const oldIdx = order.indexOf(active.id as string)
                const newIdx = order.indexOf(over.id as string)
                if (oldIdx === -1 || newIdx === -1) return
                const next = arrayMove(order, oldIdx, newIdx)
                setAnswer(q.id, JSON.stringify(next))
              }}
            >
              <SortableContext items={order} strategy={verticalListSortingStrategy}>
                <div className="space-y-2">
                  {order.map((item) => <SortableOrderItem key={item} id={item} label={item} disabled={isDisabled} />)}
                </div>
              </SortableContext>
            </DndContext>
          )
        })()}

        {q.type === 'STRUCTURE' && (
          <Suspense fallback={<div className="h-48 bg-gray-50 rounded-xl animate-pulse" />}>
            <Jsme height="420px" width="600px"
              smiles={(jsmeInitialSmiles.current[q.id] ??= answers[q.id] ?? '')}
              onChange={(smiles: string) => !isDisabled && setAnswer(q.id, smiles)}
              disabled={isDisabled}
            />
          </Suspense>
        )}
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 shrink-0">
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between gap-4">
          <Link
            to={`/student/classes/${data.class.id}`}
            className="flex items-center gap-1 text-sm text-gray-400 hover:text-gray-600 shrink-0"
          >
            <ChevronLeft size={16} /> {data.class.name}
          </Link>
          <h1 className="text-sm font-semibold text-gray-800 truncate">{data.title}</h1>
          <div className="flex items-center gap-3 shrink-0">
            {data.deadline && !isClosed && (
              <span className={`flex items-center gap-1 text-xs ${data.isPastDue ? 'text-red-500' : 'text-gray-400'}`}>
                <Clock size={12} />
                {data.isPastDue ? 'Past due' : `Due ${new Date(data.deadline).toLocaleString()}`}
              </span>
            )}
            {isClosed && <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">Closed</span>}
            {!isLocked && (
              <button
                onClick={() => submitMutation.mutate()}
                disabled={submitMutation.isPending || hasExplicitlySubmitted}
                className="flex items-center gap-1.5 bg-primary-600 text-white text-sm font-medium px-4 py-1.5 rounded-lg hover:bg-primary-700 disabled:opacity-50 transition-colors"
              >
                {submitMutation.isPending ? 'Submitting…' : hasExplicitlySubmitted ? 'Submitted ✓' : 'Submit'}
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Grade banner */}
      {isClosed && gradesData && (
        <div className="bg-blue-50 border-b border-blue-200 px-4 py-2.5">
          <div className="max-w-6xl mx-auto flex items-center justify-between">
            <span className="text-sm text-blue-800 font-medium">Assignment closed</span>
            <span className="text-sm text-blue-700">Score: <span className="font-semibold">{gradesData.earned} / {gradesData.max}</span></span>
          </div>
        </div>
      )}
      {data.isPastDue && !isClosed && (
        <div className="bg-red-50 border-b border-red-200 px-4 py-2.5">
          <p className="max-w-6xl mx-auto text-sm text-red-700">This assignment is past due. No further changes are accepted.</p>
        </div>
      )}

      {/* Body: sidebar + content */}
      <div className="flex-1 flex overflow-hidden max-w-6xl w-full mx-auto">
        <Sidebar
          displayList={displayList}
          currentStep={safeStep}
          onStep={setCurrentStep}
          answers={answers}
          gradeMap={gradeMap}
          isClosed={isClosed}
        />

        <div className="flex-1 flex flex-col overflow-hidden">
          <MobileProgress
            displayList={displayList}
            currentStep={safeStep}
            onStep={setCurrentStep}
            answers={answers}
          />

          {/* Current step */}
          <div className="flex-1 overflow-y-auto px-4 md:px-8 py-6">
            {currentItem?.kind === 'group' && (
              <div className="space-y-4">
                <div className="bg-amber-50 border border-amber-100 rounded-2xl p-6">
                  <p className="text-sm font-semibold text-amber-900 mb-2">{currentItem.group.title}</p>
                  {currentItem.group.text && <RichTextRenderer content={currentItem.group.text} />}
                </div>
                {currentItem.questions.map(({ question, globalIdx }) =>
                  renderQuestionCard(question, globalIdx)
                )}
              </div>
            )}
            {currentItem?.kind === 'question' && renderQuestionCard(currentItem.question, currentItem.globalIdx)}
          </div>

          {/* Prev / Next */}
          <div className="shrink-0 flex items-center justify-between gap-3 px-4 md:px-8 py-4 border-t border-gray-200 bg-white">
            <button
              onClick={() => setCurrentStep((s) => Math.max(0, s - 1))}
              disabled={safeStep === 0}
              className="flex items-center gap-1.5 text-sm text-gray-600 border border-gray-200 px-4 py-2 rounded-lg hover:bg-gray-50 disabled:opacity-40"
            >
              <ChevronLeft size={15} /> Previous
            </button>
            <span className="text-xs text-gray-400">{safeStep + 1} / {displayList.length}</span>
            <button
              onClick={() => setCurrentStep((s) => Math.min(displayList.length - 1, s + 1))}
              disabled={safeStep === displayList.length - 1}
              className="flex items-center gap-1.5 text-sm text-gray-600 border border-gray-200 px-4 py-2 rounded-lg hover:bg-gray-50 disabled:opacity-40"
            >
              Next <ChevronRight size={15} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
