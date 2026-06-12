import { useEffect, useState, useRef } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { useForm, Controller } from 'react-hook-form'
import { api, getStudentToken } from '@/api/client'
import { useStudentAuth } from '@/context/StudentAuthContext'
import StudentLayout from '@/components/layout/StudentLayout'
import { io } from 'socket.io-client'
import type { StudentQuestion } from 'shared'
import { apiError } from '@/lib/errors'
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
import { GripVertical } from 'lucide-react'
import { Editor } from 'ketcher-react'
import { RemoteStructServiceProvider } from 'ketcher-core'
import type { Ketcher } from 'ketcher-core'

const structServiceProvider = new RemoteStructServiceProvider('/api/indigo')

function SortableOrderItem({ id, label }: { id: string; label: string }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }
  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-2 px-3 py-2.5 border border-hairline-strong rounded-[14px] text-sm text-ink bg-surface cursor-grab active:cursor-grabbing"
    >
      <span {...attributes} {...listeners} className="text-hairline-strong hover:text-muted">
        <GripVertical size={14} />
      </span>
      {label}
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

  async function onSubmit(data: { response: string }) {
    if (!question) return
    setSubmitError('')
    let responseText = data.response ?? ''
    if (question.type === 'ORDERING') responseText = JSON.stringify(orderedItems)
    if (question.type === 'MULTI_SELECT') responseText = JSON.stringify(selectedOptions)
    if (question.type === 'STRUCTURE') responseText = ketcherRef.current ? await ketcherRef.current.getMolfile() : ''
    try {
      await api.post('/responses', { questionId: question.id, responseText })
      navigate(`/q/${question.id}/confirmation`)
    } catch (e: unknown) {
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

        <form onSubmit={handleSubmit(onSubmit)} className="p-6 space-y-6">
          <p className="text-sm font-medium text-ink">{q.text}</p>

          <div>
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
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleOrderDragEnd}>
                <SortableContext items={orderedItems} strategy={verticalListSortingStrategy}>
                  <div className="space-y-2">
                    {orderedItems.map((item) => (
                      <SortableOrderItem key={item} id={item} label={item} />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            )}

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
          </div>

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
    </StudentLayout>
  )
}
