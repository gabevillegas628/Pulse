import { useState, useEffect, useRef } from 'react'
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
import StructureRenderer from '@/components/StructureRenderer'
import { ChevronLeft, ChevronRight, Check, Clock, GripVertical, Save, Loader2 } from 'lucide-react'
import { Editor } from 'ketcher-react'
import { RemoteStructServiceProvider } from 'ketcher-core'
import type { Ketcher } from 'ketcher-core'

const structServiceProvider = new RemoteStructServiceProvider('/api/indigo')

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
  correctAnswer: string | null
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
      className={`flex items-center gap-2 px-3 py-2.5 border rounded-[14px] text-sm text-ink bg-surface ${
        disabled ? 'border-hairline opacity-60' : 'border-hairline-strong cursor-grab active:cursor-grabbing'
      }`}
    >
      {!disabled && (
        <span {...attributes} {...listeners} className="text-hairline-strong hover:text-muted">
          <GripVertical size={14} />
        </span>
      )}
      {label}
    </div>
  )
}

function ScoreBadge({ score, aiScore, type }: { score: number; aiScore: number | null; type: string }) {
  if (type === 'FREE_TEXT' && aiScore === null)
    return <span className="text-xs text-muted bg-surface-2 px-2 py-0.5 rounded-full font-mono">Pending</span>
  if (score >= 1.0) return <span className="text-xs text-good bg-good-soft px-2 py-0.5 rounded-full">Full credit</span>
  if (score >= 0.5) return <span className="text-xs text-warn bg-warn-soft px-2 py-0.5 rounded-full">Partial credit</span>
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
    <aside className="hidden md:flex w-56 shrink-0 flex-col border-r border-hairline bg-surface">
      <div className="px-4 py-3 border-b border-hairline shrink-0">
        <p className="text-xs font-semibold text-muted uppercase tracking-wider">Questions</p>
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
                  isActive ? 'bg-signal-soft text-signal' : 'text-ink-2 hover:bg-surface-2'
                }`}
              >
                <span className="text-xs font-medium truncate">{item.group.title}</span>
                {groupAllSaved ? (
                  <Check size={12} className="shrink-0 text-good" />
                ) : groupAnyDraft ? (
                  <Save size={12} className="shrink-0 text-warn" />
                ) : isActive ? (
                  <ChevronRight size={12} className="shrink-0 text-signal" />
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
                isActive ? 'bg-signal-soft text-signal' : 'text-ink-2 hover:bg-surface-2'
              }`}
            >
              <span className="text-xs truncate font-mono">Q{item.globalIdx + 1}</span>
              {isClosed && grade ? (
                <ScoreBadge score={grade.score} aiScore={grade.response?.aiScore ?? null} type={q.type} />
              ) : isSubmitted ? (
                <Check size={12} className="shrink-0 text-good" />
              ) : hasDraft ? (
                <Save size={12} className="shrink-0 text-warn" />
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
    <div className="md:hidden flex items-center gap-2 px-4 py-2 border-b border-hairline bg-surface overflow-x-auto shrink-0">
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
                ? 'bg-signal text-white'
                : isSubmitted
                ? 'bg-good-soft text-good'
                : hasDraft
                ? 'bg-warn-soft text-warn'
                : 'bg-surface-2 text-muted'
            }`}
          >
            {label}
          </button>
        )
      })}
      <span className="shrink-0 text-xs text-muted ml-1 font-mono">{currentStep + 1}/{total}</span>
    </div>
  )
}

// ─── Main page ─────────────────────────────────────────────────────────────────

export default function AssignmentPage() {
  const { assignmentId } = useParams<{ assignmentId: string }>()
  const qc = useQueryClient()

  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [currentStep, setCurrentStep] = useState(0)
  const [lastSaved, setLastSaved] = useState<Date | null>(null)
  const ketcherRef = useRef<Ketcher | null>(null)
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const currentItemRef = useRef<DisplayItem | undefined>(undefined)
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

  const saveMutation = useMutation({
    mutationFn: ({ questionId, responseText }: { questionId: string; responseText: string }) =>
      api.post('/responses', { questionId, responseText }),
    onSuccess: () => {
      setLastSaved(new Date())
      qc.invalidateQueries({ queryKey: ['student-assignment', assignmentId] })
      qc.invalidateQueries({ queryKey: ['student-assignments'] })
    },
    onError: () => { /* auto-save will retry on next change */ },
  })

  const submitMutation = useMutation({
    mutationFn: () => api.post(`/student/assignments/${assignmentId}/submit`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['student-assignment', assignmentId] })
      qc.invalidateQueries({ queryKey: ['student-assignments'] })
    },
  })

  function scheduleAutoSave(questionId: string, responseText: string) {
    clearTimeout(saveTimers.current[questionId])
    saveTimers.current[questionId] = setTimeout(() => {
      saveMutation.mutate({ questionId, responseText })
    }, 1500)
  }

  function setAnswer(questionId: string, value: string) {
    setAnswers((prev) => ({ ...prev, [questionId]: value }))
    scheduleAutoSave(questionId, value)
  }

  async function saveCurrentNow() {
    const item = currentItemRef.current
    if (!item) return
    const qs = item.kind === 'group'
      ? item.questions.map(({ question }) => question)
      : [item.question]
    for (const q of qs) {
      let val = answers[q.id]
      if (q.type === 'STRUCTURE' && ketcherRef.current) {
        val = await ketcherRef.current.getMolfile()
        if (val) setAnswers((prev) => ({ ...prev, [q.id]: val }))
      }
      if (!val) continue
      clearTimeout(saveTimers.current[q.id])
      saveMutation.mutate({ questionId: q.id, responseText: val })
    }
  }

  if (isLoading || !data) {
    return (
      <div className="min-h-screen bg-canvas flex items-center justify-center">
        <p className="text-muted text-sm">Loading…</p>
      </div>
    )
  }

  // Build display list
  const displayList: DisplayItem[] = []
  const usedIds = new Set<string>()

  data.groups.forEach((group) => {
    const groupQuestions = data.questions
      .filter((q) => q.groupId === group.id)
      .map((q) => ({ question: q, globalIdx: 0 }))
    if (!groupQuestions.length) return
    groupQuestions.forEach(({ question }) => usedIds.add(question.id))
    displayList.push({ kind: 'group', group, questions: groupQuestions })
  })
  data.questions.forEach((q) => {
    if (!usedIds.has(q.id))
      displayList.push({ kind: 'question', question: q, globalIdx: 0 })
  })

  const questionNumbers = new Map<string, number>()
  let qCounter = 0
  for (const item of displayList) {
    if (item.kind === 'group') {
      for (const gq of item.questions) {
        gq.globalIdx = qCounter++
        questionNumbers.set(gq.question.id, gq.globalIdx)
      }
    } else {
      item.globalIdx = qCounter++
      questionNumbers.set(item.question.id, item.globalIdx)
    }
  }

  const safeStep = Math.min(currentStep, displayList.length - 1)
  const currentItem = displayList[safeStep]
  currentItemRef.current = currentItem
  const hasExplicitlySubmitted = submitMutation.isSuccess

  function renderQuestionCard(q: AssignmentQuestion) {
    const isSubmitted = !!q.existingResponse
    const isDisabled = isLocked || hasExplicitlySubmitted
    const grade = gradeMap.get(q.id)
    const displayNum = (questionNumbers.get(q.id) ?? 0) + 1

    return (
      <div key={q.id} className={`bg-surface border rounded-[14px] p-6 ${isSubmitted ? 'border-good/20' : 'border-hairline'}`}>
        <div className="flex items-start justify-between gap-3 mb-4">
          <p className="text-xs font-medium text-muted uppercase tracking-wide">Question {displayNum}</p>
          <div className="flex items-center gap-2 shrink-0">
            {grade && <ScoreBadge score={grade.score} aiScore={grade.response?.aiScore ?? null} type={q.type} />}
            {!grade && isSubmitted && (
              <span className="flex items-center gap-1 text-xs text-good font-medium">
                <Check size={12} /> Saved
              </span>
            )}
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
            className="w-full border border-hairline rounded-[14px] px-4 py-3 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-signal resize-none disabled:bg-surface-2 disabled:text-muted"
          />
        )}

        {q.type === 'MULTIPLE_CHOICE' && q.options && (
          <div className="space-y-2">
            {q.options.map((opt) => (
              <label key={opt} className={`flex items-center gap-3 p-3.5 border rounded-[14px] cursor-pointer transition-colors ${
                answers[q.id] === opt ? 'border-signal bg-signal-soft' : 'border-hairline hover:border-hairline-strong'
              } ${isDisabled ? 'opacity-60 cursor-not-allowed' : ''}`}>
                <input type="radio" name={`q-${q.id}`} value={opt} checked={answers[q.id] === opt}
                  onChange={() => !isDisabled && setAnswer(q.id, opt)} disabled={isDisabled}
                  className="accent-[var(--signal)]" />
                <span className="text-sm text-ink">{opt}</span>
              </label>
            ))}
          </div>
        )}

        {q.type === 'YES_NO' && (
          <div className="flex gap-3">
            {['Yes', 'No'].map((opt) => (
              <label key={opt} className={`flex items-center gap-2 px-5 py-3 border rounded-[14px] cursor-pointer transition-colors ${
                answers[q.id] === opt ? 'border-signal bg-signal-soft text-signal' : 'border-hairline text-ink-2 hover:border-hairline-strong'
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
                className={`w-12 h-12 rounded-[14px] text-sm font-medium border transition-colors ${
                  answers[q.id] === String(n) ? 'border-signal bg-signal-soft text-signal' : 'border-hairline text-muted hover:border-hairline-strong'
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
              className="w-48 border border-hairline rounded-[14px] px-4 py-3 text-sm bg-surface font-mono focus:outline-none focus:ring-2 focus:ring-signal disabled:bg-surface-2 disabled:text-muted"
            />
            {q.unit && <span className="text-sm text-muted">{q.unit}</span>}
          </div>
        )}

        {q.type === 'MULTI_SELECT' && q.options && (
          <div className="space-y-2">
            {q.options.map((opt) => {
              let selected: string[] = []
              try { selected = JSON.parse(answers[q.id] ?? '[]') } catch { /* ignore */ }
              const isChecked = selected.includes(opt)
              return (
                <label key={opt} className={`flex items-center gap-3 p-3.5 border rounded-[14px] cursor-pointer transition-colors ${
                  isChecked ? 'border-signal bg-signal-soft' : 'border-hairline hover:border-hairline-strong'
                } ${isDisabled ? 'opacity-60 cursor-not-allowed' : ''}`}>
                  <input type="checkbox" checked={isChecked} disabled={isDisabled}
                    className="accent-[var(--signal)]"
                    onChange={() => {
                      if (isDisabled) return
                      const next = isChecked ? selected.filter(v => v !== opt) : [...selected, opt]
                      setAnswer(q.id, JSON.stringify(next))
                    }}
                  />
                  <span className="text-sm text-ink">{opt}</span>
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
          isDisabled ? (
            answers[q.id] ? (
              <StructureRenderer inchi={answers[q.id]} width={400} height={280} />
            ) : (
              <div className="h-40 bg-surface-2 rounded-[14px] flex items-center justify-center text-sm text-muted">No structure submitted</div>
            )
          ) : (
            <div className="h-[500px] border border-hairline rounded-[14px] overflow-hidden">
              <Editor
                staticResourcesUrl=""
                structServiceProvider={structServiceProvider}
                errorHandler={(err) => console.error('Ketcher error:', err)}
                onInit={async (ketcher) => {
                  ketcherRef.current = ketcher
                  const existing = answers[q.id]
                  if (existing) await ketcher.setMolecule(existing)
                }}
              />
            </div>
          )
        )}
        {/* Debug panel */}
        <details className="mt-4 border border-hairline rounded-sm text-xs font-mono">
          <summary className="px-3 py-1.5 cursor-pointer text-muted select-none">Debug</summary>
          <div className="px-3 py-2 space-y-2 border-t border-hairline bg-surface-2 break-all">
            <div>
              <span className="text-muted">stored answer: </span>
              <span className="text-ink-2">{q.existingResponse?.responseText ?? '—'}</span>
            </div>
            <div>
              <span className="text-muted">correct answer: </span>
              <span className="text-ink-2">{q.correctAnswer ?? '—'}</span>
            </div>
          </div>
        </details>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-canvas flex flex-col">
      {/* Header */}
      <header className="bg-surface border-b border-hairline shrink-0">
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between gap-4">
          <Link
            to={`/student/classes/${data.class.id}`}
            className="flex items-center gap-1 text-sm text-muted hover:text-ink shrink-0 transition-colors"
          >
            <ChevronLeft size={16} /> {data.class.name}
          </Link>
          <h1 className="text-sm font-semibold text-ink truncate">{data.title}</h1>
          <div className="flex items-center gap-3 shrink-0">
            {data.deadline && !isClosed && (
              <span className={`flex items-center gap-1 text-xs font-mono ${data.isPastDue ? 'text-red-500' : 'text-muted'}`}>
                <Clock size={12} />
                {data.isPastDue ? 'Past due' : `Due ${new Date(data.deadline).toLocaleString()}`}
              </span>
            )}
            {isClosed && <span className="text-xs text-muted bg-surface-2 px-2 py-0.5 rounded-full">Closed</span>}
            {!isLocked && (
              <button
                onClick={() => submitMutation.mutate()}
                disabled={submitMutation.isPending || hasExplicitlySubmitted}
                className="flex items-center gap-1.5 bg-signal text-white text-sm font-bold px-4 py-1.5 rounded-sm hover:bg-[var(--signal-bright)] disabled:opacity-50 transition-colors"
              >
                {submitMutation.isPending ? 'Submitting…' : hasExplicitlySubmitted ? 'Submitted ✓' : 'Submit'}
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Grade banner */}
      {isClosed && gradesData && (
        <div className="bg-surface-2 border-b border-hairline px-4 py-2.5">
          <div className="max-w-6xl mx-auto flex items-center justify-between">
            <span className="text-sm text-ink font-medium">Assignment closed</span>
            <span className="text-sm text-ink-2">
              Score: <span className="font-semibold font-mono">{gradesData.earned} / {gradesData.max}</span>
            </span>
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
                <div className="bg-amber-50 border border-amber-100 rounded-[14px] p-6">
                  <p className="text-sm font-semibold text-amber-900 mb-2">{currentItem.group.title}</p>
                  {currentItem.group.text && <RichTextRenderer content={currentItem.group.text} />}
                </div>
                {currentItem.questions.map(({ question }) =>
                  renderQuestionCard(question)
                )}
              </div>
            )}
            {currentItem?.kind === 'question' && renderQuestionCard(currentItem.question)}
          </div>

          {/* Prev / Next / Save */}
          <div className="shrink-0 flex items-center justify-between gap-3 px-4 md:px-8 py-4 border-t border-hairline bg-surface">
            <button
              onClick={async () => { await saveCurrentNow(); setCurrentStep((s) => Math.max(0, s - 1)) }}
              disabled={safeStep === 0}
              className="flex items-center gap-1.5 text-sm text-ink-2 border border-hairline px-4 py-2 rounded-sm hover:bg-surface-2 disabled:opacity-40 transition-colors"
            >
              <ChevronLeft size={15} /> Previous
            </button>

            <div className="flex flex-col items-center gap-1">
              {!isLocked && !hasExplicitlySubmitted && (
                <button
                  onClick={saveCurrentNow}
                  disabled={saveMutation.isPending}
                  className="flex items-center gap-1.5 text-xs text-muted border border-hairline px-3 py-1.5 rounded-sm hover:bg-surface-2 disabled:opacity-40 transition-colors"
                >
                  {saveMutation.isPending
                    ? <><Loader2 size={12} className="animate-spin" /> Saving…</>
                    : <><Save size={12} /> Save</>
                  }
                </button>
              )}
              {lastSaved && (
                <span className="text-xs text-muted font-mono">
                  Last saved {lastSaved.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              )}
              {!lastSaved && (
                <span className="text-xs text-muted font-mono">{safeStep + 1} / {displayList.length}</span>
              )}
            </div>

            <button
              onClick={async () => { await saveCurrentNow(); setCurrentStep((s) => Math.min(displayList.length - 1, s + 1)) }}
              disabled={safeStep === displayList.length - 1}
              className="flex items-center gap-1.5 text-sm text-ink-2 border border-hairline px-4 py-2 rounded-sm hover:bg-surface-2 disabled:opacity-40 transition-colors"
            >
              Next <ChevronRight size={15} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
