import { useEffect, useState, useRef } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { useForm, Controller } from 'react-hook-form'
import { api, getStudentToken } from '@/api/client'
import { useStudentAuth } from '@/context/StudentAuthContext'
import StudentLayout from '@/components/layout/StudentLayout'
import { io } from 'socket.io-client'
import type { StudentQuestion } from 'shared'
import { apiError, apiErrorCode } from '@/lib/errors'
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
import { ChevronDown, ChevronUp, GripVertical } from 'lucide-react'
import { Editor } from 'ketcher-react'
import { RemoteStructServiceProvider } from 'ketcher-core'
import type { Ketcher } from 'ketcher-core'

const structServiceProvider = new RemoteStructServiceProvider('/api/indigo')

/**
 * One row of an ordering answer.
 *
 * `touch-none` on the grip is the whole reason this works on a phone, and it is not
 * cosmetic. dnd-kit's PointerSensor abandons a drag as soon as the browser claims the
 * gesture for scrolling — it listens for `pointercancel` — and on a touchscreen the browser
 * claims it on the first vertical move. So the press registered, the finger moved, the page
 * scrolled, and the row never lifted: dragging did nothing at all on the one device every
 * student answers from. The rule has to sit on the element carrying the listeners, which is
 * the author's job; dnd-kit sets it on its own drag overlay but cannot reach in here.
 *
 * The grip also got bigger. Fourteen pixels of icon in a bare span is a target roughly a
 * third the width of a fingertip, so even with the gesture fixed it would have been a
 * question answered by repeatedly missing.
 *
 * The arrows are not a consolation prize for a broken gesture. A precise drag down a moving
 * list is genuinely hard one-handed in a lecture hall, and for most people tapping twice is
 * the faster way to answer — while also being the only way this question has ever been
 * answerable by keyboard or screen reader.
 */
function SortableOrderItem({
  id,
  label,
  index,
  total,
  onMove,
}: {
  id: string
  label: string
  index: number
  total: number
  onMove: (from: number, to: number) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }
  const arrow =
    'p-1.5 rounded-md text-muted hover:bg-surface-2 active:bg-surface-2 disabled:opacity-25 disabled:hover:bg-transparent'
  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-1 pl-1 pr-1.5 py-1 border border-hairline-strong rounded-[14px] text-sm text-ink bg-surface"
    >
      <span
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${label}`}
        className="touch-none shrink-0 p-2.5 text-hairline-strong hover:text-muted cursor-grab active:cursor-grabbing"
      >
        <GripVertical size={18} />
      </span>
      <span className="shrink-0 font-mono tabular-nums text-muted">{index + 1}.</span>
      <span className="flex-1 min-w-0 py-1">{label}</span>
      <span className="flex flex-col shrink-0">
        <button
          type="button"
          onClick={() => onMove(index, index - 1)}
          disabled={index === 0}
          aria-label={`Move ${label} up`}
          className={arrow}
        >
          <ChevronUp size={16} />
        </button>
        <button
          type="button"
          onClick={() => onMove(index, index + 1)}
          disabled={index === total - 1}
          aria-label={`Move ${label} down`}
          className={arrow}
        >
          <ChevronDown size={16} />
        </button>
      </span>
    </div>
  )
}

export default function QuestionPage() {
  const { questionId } = useParams<{ questionId: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const { isAuthenticated, isLoading: authLoading } = useStudentAuth()

  const [question, setQuestion] = useState<StudentQuestion | null>(null)
  const [loadError, setLoadError] = useState('')
  const [submitError, setSubmitError] = useState('')
  const [sessionClosed, setSessionClosed] = useState(false)
  const [questionClosed, setQuestionClosed] = useState(false)
  const [imageZoomed, setImageZoomed] = useState(false)
  const [orderedItems, setOrderedItems] = useState<string[]>([])
  const [selectedOptions, setSelectedOptions] = useState<string[]>([])
  const ketcherRef = useRef<Ketcher | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const { control, handleSubmit, register, watch, formState: { isSubmitting } } = useForm<{ response: string }>()

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      navigate(`/student/login?next=${location.pathname}`, { replace: true })
    }
  }, [authLoading, isAuthenticated, navigate, location.pathname])

  useEffect(() => {
    if (!isAuthenticated || !questionId) return
    api.get(`/student/questions/${questionId}`)
      .then((r) => {
        const q: StudentQuestion = r.data.data.question
        setQuestion(q)
        // Only pre-close if the session is archived; live status comes via run_status socket
        if (q.session?.status === 'ARCHIVED') setSessionClosed(true)
        if (q.type === 'ORDERING' && q.options) {
          setOrderedItems([...q.options].sort(() => Math.random() - 0.5))
        }
        ketcherRef.current = null
        setSelectedOptions([])
      })
      .catch((e) => {
        setLoadError(apiError(e, 'Question not found'))
      })
  }, [isAuthenticated, questionId])

  useEffect(() => {
    if (!question) return
    const socket = io({ path: '/socket.io', auth: { token: getStudentToken() } })
    if (!question.session) return
    const sessionId = question.session.id
    socket.on('connect', () => socket.emit('join_session', sessionId))
    socket.on('run_status', ({ status }: { runId: string; status: string; sectionId: string | null }) => {
      if (status === 'CLOSED' || status === 'ARCHIVED') setSessionClosed(true)
    })
    // The countdown ran out. The server refuses the answer either way — this just
    // means the student sees it happen rather than losing a typed answer on submit.
    socket.on('question_closed', ({ questionId: closedId }: { questionId: string }) => {
      if (closedId === question.id) setQuestionClosed(true)
    })
    socket.on('question_reopened', ({ questionId: reopenedId }: { questionId: string }) => {
      if (reopenedId === question.id) setQuestionClosed(false)
    })
    return () => { socket.disconnect() }
  }, [question])

  function handleOrderDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    setOrderedItems((items) => {
      const oldIdx = items.indexOf(String(active.id))
      const newIdx = items.indexOf(String(over.id))
      return arrayMove(items, oldIdx, newIdx)
    })
  }

  // The arrows' half of the same move. Bounds are checked here as well as by disabling the
  // buttons, so a rapid double tap at either end cannot walk an item off the list.
  function moveOrderedItem(from: number, to: number) {
    setOrderedItems((items) => (to < 0 || to >= items.length ? items : arrayMove(items, from, to)))
  }

  async function onSubmit(data: { response: string }) {
    if (!question) return
    setSubmitError('')
    let responseText = data.response ?? ''
    if (question.type === 'ORDERING') responseText = JSON.stringify(orderedItems)
    if (question.type === 'MULTI_SELECT') responseText = JSON.stringify(selectedOptions)
    if (question.type === 'STRUCTURE') {
      // An empty canvas has no InChI; the server can only refuse it, so say so here.
      if (!ketcherRef.current || ketcherRef.current.editor.struct().isBlank()) {
        setSubmitError('Draw a structure before submitting')
        return
      }
      responseText = await ketcherRef.current.getMolfile()
    }
    try {
      await api.post('/responses', { questionId: question.id, responseText })
      navigate(`/q/${question.id}/confirmation`)
    } catch (e: unknown) {
      // The server is the authority on whether this question is still taking
      // answers, and its refusal is the same news the socket carries. Treating it
      // only as a message to display left the form live: a student whose socket
      // dropped never saw the close, and could re-submit into a wall as fast as
      // they could tap. One lecture produced fourteen POSTs in under four seconds.
      const code = apiErrorCode(e)
      if (code === 'QUESTION_CLOSED') { setQuestionClosed(true); return }
      if (code === 'SESSION_CLOSED') { setSessionClosed(true); return }
      if (code === 'ALREADY_ANSWERED') { setQuestion((q) => q && { ...q, alreadyAnswered: true }); return }
      setSubmitError(apiError(e, 'Submission failed — please try again'))
    }
  }

  if (authLoading || (!question && !loadError)) {
    return <StudentLayout><div className="text-center py-16 text-muted text-sm">Loading…</div></StudentLayout>
  }

  if (loadError) {
    return (
      <StudentLayout>
        <div className="bg-surface rounded-[14px] border border-hairline p-8 text-center">
          <p className="text-muted">{loadError}</p>
        </div>
      </StudentLayout>
    )
  }

  if (questionClosed && !question!.alreadyAnswered) {
    return (
      <StudentLayout>
        <div className="bg-surface rounded-[14px] border border-hairline p-8 text-center">
          <p className="text-xl font-semibold text-ink mb-2">Time's up</p>
          <p className="text-muted text-sm">This question has stopped accepting answers.</p>
        </div>
      </StudentLayout>
    )
  }

  if (sessionClosed) {
    return (
      <StudentLayout>
        <div className="bg-surface rounded-[14px] border border-hairline p-8 text-center">
          <p className="text-xl font-semibold text-ink mb-2">Session closed</p>
          <p className="text-muted text-sm">This session is no longer accepting responses.</p>
        </div>
      </StudentLayout>
    )
  }

  if (question!.alreadyAnswered) {
    return (
      <StudentLayout>
        <div className="bg-surface rounded-[14px] border border-hairline p-8 text-center">
          <p className="text-xl font-semibold text-ink mb-2">Already submitted</p>
          <p className="text-muted text-sm">You've already answered this question.</p>
        </div>
      </StudentLayout>
    )
  }

  const q = question!
  const responseValue = watch('response')
  const isAnswerEmpty =
    q.type === 'ORDERING' ? false :
    q.type === 'MULTI_SELECT' ? selectedOptions.length === 0 :
    q.type === 'STRUCTURE' ? false :
    q.type === 'NUMERIC' ? (() => {
      if (!responseValue?.trim()) return true
      if (!q.unit) return false
      const m = responseValue.trim().match(/^([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)\s+(\S.*)$/)
      return !m
    })() :
    !responseValue?.trim()

  return (
    <StudentLayout>
      <div className="bg-surface rounded-[14px] shadow-card border border-hairline overflow-hidden">
        <div className="bg-signal px-6 py-4">
          <p className="text-white/70 text-xs font-medium uppercase tracking-wide">{q.session?.class.name}</p>
          <h1 className="text-white text-base font-semibold mt-0.5">{q.session?.title}</h1>
        </div>

        <div className="p-6 space-y-6">
          <p className="text-sm font-medium text-ink">{q.text}</p>

          {q.imageUrl && (
            <img
              src={q.imageUrl}
              alt="Figure for this question"
              onClick={() => setImageZoomed(true)}
              className="w-full max-h-[60vh] object-contain rounded-[14px] border border-hairline bg-surface-2 cursor-zoom-in"
            />
          )}

          {/* Outside the form on purpose. Most of Ketcher's toolbar buttons carry no `type`,
              so inside a form every tool a student tapped submitted it — with an empty canvas. */}
          {q.type === 'STRUCTURE' && (
            <div className="h-[500px] border border-hairline rounded-[14px] overflow-hidden">
              <Editor
                staticResourcesUrl=""
                structServiceProvider={structServiceProvider}
                errorHandler={(err) => console.error('Ketcher error:', err)}
                onInit={(ketcher) => { ketcherRef.current = ketcher }}
              />
            </div>
          )}

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
            {q.type === 'FREE_TEXT' && (
              <textarea
                {...register('response')}
                rows={4}
                placeholder="Write your response…"
                className="w-full border border-hairline rounded-[14px] px-3 py-3 text-base bg-surface focus:outline-none focus:ring-2 focus:ring-signal resize-none"
              />
            )}

            {q.type === 'MULTIPLE_CHOICE' && q.options && (
              <Controller
                name="response"
                control={control}
                render={({ field }) => (
                  <div className="space-y-2">
                    {q.options!.map((opt) => (
                      <label key={opt} className="flex items-center gap-3 p-3 border border-hairline rounded-[14px] cursor-pointer hover:bg-surface-2 transition-colors">
                        <input
                          type="radio"
                          value={opt}
                          checked={field.value === opt}
                          onChange={() => field.onChange(opt)}
                          className="accent-[var(--signal)]"
                        />
                        <span className="text-ink">{opt}</span>
                      </label>
                    ))}
                  </div>
                )}
              />
            )}

            {q.type === 'RATING' && (
              <Controller
                name="response"
                control={control}
                render={({ field }) => (
                  <div className="flex gap-3">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => field.onChange(String(n))}
                        className={`flex-1 py-3 rounded-[14px] border-2 text-lg font-semibold transition-colors ${
                          field.value === String(n)
                            ? 'border-signal bg-signal-soft text-signal'
                            : 'border-hairline text-muted hover:border-hairline-strong'
                        }`}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                )}
              />
            )}

            {q.type === 'YES_NO' && (
              <Controller
                name="response"
                control={control}
                render={({ field }) => (
                  <div className="flex gap-3">
                    {['Yes', 'No'].map((opt) => (
                      <button
                        key={opt}
                        type="button"
                        onClick={() => field.onChange(opt.toLowerCase())}
                        className={`flex-1 py-3 rounded-[14px] border-2 font-medium transition-colors ${
                          field.value === opt.toLowerCase()
                            ? 'border-signal bg-signal-soft text-signal'
                            : 'border-hairline text-ink-2 hover:border-hairline-strong'
                        }`}
                      >
                        {opt}
                      </button>
                    ))}
                  </div>
                )}
              />
            )}

            {q.type === 'NUMERIC' && (
              <Controller
                name="response"
                control={control}
                render={({ field }) => {
                  const missingUnit = !!q.unit && !!field.value?.trim() &&
                    !field.value.trim().match(/^([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)\s+(\S.*)$/)
                  return (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <input
                          type="text"
                          inputMode={q.unit ? 'text' : 'decimal'}
                          value={field.value ?? ''}
                          onChange={(e) => field.onChange(e.target.value)}
                          placeholder={q.unit ? 'e.g. 5000 J, 3.2 mV' : 'Your answer…'}
                          className={`border border-hairline rounded-[14px] px-3 py-3 text-base font-mono bg-surface focus:outline-none focus:ring-2 focus:ring-signal ${q.unit ? 'w-64' : 'w-48'}`}
                        />
                      </div>
                      {missingUnit && (
                        <p className="text-xs text-warn">Remember to include units (e.g. 5000 J, 3.2 mV, 10 kJ/mol)</p>
                      )}
                    </div>
                  )
                }}
              />
            )}

            {q.type === 'MULTI_SELECT' && q.options && (
              <div className="space-y-2">
                {q.options.map((opt) => {
                  const isChecked = selectedOptions.includes(opt)
                  return (
                    <label key={opt} className={`flex items-center gap-3 p-3 border rounded-[14px] cursor-pointer transition-colors ${
                      isChecked ? 'border-signal bg-signal-soft' : 'border-hairline hover:border-hairline-strong'
                    }`}>
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => {
                          const next = isChecked
                            ? selectedOptions.filter(v => v !== opt)
                            : [...selectedOptions, opt]
                          setSelectedOptions(next)
                        }}
                        className="accent-[var(--signal)]"
                      />
                      <span className="text-ink">{opt}</span>
                    </label>
                  )
                })}
              </div>
            )}

            {q.type === 'ORDERING' && orderedItems.length > 0 && (
              <div className="space-y-2">
                {/* Said once, because neither affordance is obvious on a phone: the grip
                    reads as decoration until you know it moves, and nothing else on the
                    form is draggable. */}
                <p className="text-xs text-muted">
                  Drag the handle or use the arrows to put these in order.
                </p>
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleOrderDragEnd}>
                  <SortableContext items={orderedItems} strategy={verticalListSortingStrategy}>
                    <div className="space-y-2">
                      {orderedItems.map((item, i) => (
                        <SortableOrderItem
                          key={item}
                          id={item}
                          label={item}
                          index={i}
                          total={orderedItems.length}
                          onMove={moveOrderedItem}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
              </div>
            )}

            {submitError && (
              <p className="text-red-500 text-sm bg-red-50 rounded-sm px-3 py-2">{submitError}</p>
            )}

            <button
              type="submit"
              disabled={isSubmitting || isAnswerEmpty}
              className="w-full bg-signal text-white rounded-[14px] py-4 text-base font-bold hover:bg-[var(--signal-bright)] disabled:opacity-50 transition-colors"
            >
              {isSubmitting ? 'Submitting…' : 'Submit'}
            </button>
          </form>
        </div>
      </div>

      {/* A diagram at phone width is often unreadable — tapping it fills the screen. */}
      {imageZoomed && q.imageUrl && (
        <div
          className="fixed inset-0 bg-black/90 flex items-center justify-center z-50 cursor-zoom-out p-4"
          onClick={() => setImageZoomed(false)}
        >
          <img src={q.imageUrl} alt="" className="max-w-full max-h-full object-contain" />
        </div>
      )}
    </StudentLayout>
  )
}
