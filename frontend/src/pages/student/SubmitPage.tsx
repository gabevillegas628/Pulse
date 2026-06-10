import { useEffect, useState, useRef } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { useForm, Controller } from 'react-hook-form'
import { api, getStudentToken } from '@/api/client'
import { useStudentAuth } from '@/context/StudentAuthContext'
import StudentLayout from '@/components/layout/StudentLayout'
import { io } from 'socket.io-client'
import type { Question } from 'shared'
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

interface SessionData {
  id: string
  title: string
  status: string
  questions: Question[]
  class: { name: string }
}

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

export default function SubmitPage() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const { isAuthenticated, isLoading: authLoading } = useStudentAuth()

  const [session, setSession] = useState<SessionData | null>(null)
  const [alreadySubmitted, setAlreadySubmitted] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [submitError, setSubmitError] = useState('')
  const [sessionClosed, setSessionClosed] = useState(false)
  const [orderedItems, setOrderedItems] = useState<Record<string, string[]>>({})
  const [multiSelectAnswers, setMultiSelectAnswers] = useState<Record<string, string[]>>({})
  const ketcherRefs = useRef<Record<string, Ketcher>>({})
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const { control, handleSubmit, register, formState: { isSubmitting } } = useForm<Record<string, string>>()

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      navigate(`/login?next=${location.pathname}`, { replace: true })
    }
  }, [authLoading, isAuthenticated, navigate, location.pathname])

  useEffect(() => {
    if (!isAuthenticated || !sessionId) return
    api.get(`/student/sessions/${sessionId}`)
      .then((r) => {
        const s: SessionData = r.data.data.session
        setSession(s)
        setAlreadySubmitted(r.data.data.alreadySubmitted)
        // Treat archived as closed; live status comes via run_status socket
        if (s.status === 'ARCHIVED') setSessionClosed(true)
        const initialOrders: Record<string, string[]> = {}
        s.questions.forEach((q) => {
          if (q.type === 'ORDERING' && q.options) {
            initialOrders[q.id] = [...q.options].sort(() => Math.random() - 0.5)
          }
        })
        setOrderedItems(initialOrders)
      })
      .catch((e) => {
        setLoadError(apiError(e, 'Session not found'))
      })
  }, [isAuthenticated, sessionId])

  useEffect(() => {
    if (!sessionId) return
    const socket = io({ path: '/socket.io', auth: { token: getStudentToken() } })
    socket.on('connect', () => socket.emit('join_session', sessionId))
    socket.on('run_status', ({ status }: { runId: string; status: string; sectionId: string | null }) => {
      if (status === 'CLOSED' || status === 'ARCHIVED') setSessionClosed(true)
    })
    return () => { socket.disconnect() }
  }, [sessionId])

  function handleOrderDragEnd(questionId: string) {
    return (event: DragEndEvent) => {
      const { active, over } = event
      if (!over || active.id === over.id) return
      setOrderedItems((prev) => {
        const items = prev[questionId] ?? []
        const oldIdx = items.indexOf(String(active.id))
        const newIdx = items.indexOf(String(over.id))
        return { ...prev, [questionId]: arrayMove(items, oldIdx, newIdx) }
      })
    }
  }

  async function onSubmit(data: Record<string, string>) {
    if (!session) return
    setSubmitError('')
    try {
      const responses = await Promise.all(session.questions.map(async (q) => {
        let responseText = data[q.id] ?? ''
        if (q.type === 'ORDERING') responseText = JSON.stringify(orderedItems[q.id] ?? [])
        if (q.type === 'MULTI_SELECT') responseText = JSON.stringify(multiSelectAnswers[q.id] ?? [])
        if (q.type === 'STRUCTURE') responseText = ketcherRefs.current[q.id] ? await ketcherRefs.current[q.id].getMolfile() : ''
        return { questionId: q.id, responseText }
      }))
      await api.post('/responses', { sessionId: session.id, responses })
      navigate(`/s/${session.id}/confirmation`)
    } catch (e: unknown) {
      setSubmitError(apiError(e, 'Submission failed — please try again'))
    }
  }

  if (authLoading || (!session && !loadError)) {
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

  if (alreadySubmitted) {
    return (
      <StudentLayout>
        <div className="bg-surface rounded-[14px] border border-hairline p-8 text-center">
          <p className="text-xl font-semibold text-ink mb-2">Already submitted</p>
          <p className="text-muted text-sm">You've already responded to this session.</p>
        </div>
      </StudentLayout>
    )
  }

  return (
    <StudentLayout>
      <div className="bg-surface rounded-[14px] shadow-card border border-hairline overflow-hidden">
        <div className="bg-signal px-6 py-4">
          <p className="text-white/70 text-xs font-medium uppercase tracking-wide">{session!.class.name}</p>
          <h1 className="text-white text-lg font-semibold mt-0.5">{session!.title}</h1>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="p-6 space-y-8">
          {session!.questions.map((q, idx) => (
            <div key={q.id}>
              <p className="text-sm font-medium text-ink mb-3">
                {session!.questions.length > 1 && <span className="text-signal mr-1">Q{idx + 1}.</span>}
                {q.text}
              </p>

              {q.type === 'FREE_TEXT' && (
                <textarea
                  {...register(q.id)}
                  rows={4}
                  placeholder="Write your response…"
                  className="w-full border border-hairline rounded-[14px] px-3 py-3 text-base bg-surface focus:outline-none focus:ring-2 focus:ring-signal resize-none"
                />
              )}

              {q.type === 'MULTIPLE_CHOICE' && q.options && (
                <Controller
                  name={q.id}
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
                  name={q.id}
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
                  name={q.id}
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
                  name={q.id}
                  control={control}
                  render={({ field }) => (
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        inputMode="decimal"
                        value={field.value ?? ''}
                        onChange={(e) => field.onChange(e.target.value)}
                        placeholder="Your answer…"
                        className="w-48 border border-hairline rounded-[14px] px-3 py-3 text-base font-mono bg-surface focus:outline-none focus:ring-2 focus:ring-signal"
                      />
                      {q.unit && <span className="text-sm text-muted">{q.unit}</span>}
                    </div>
                  )}
                />
              )}

              {q.type === 'MULTI_SELECT' && q.options && (
                <div className="space-y-2">
                  {q.options.map((opt) => {
                    const selected = multiSelectAnswers[q.id] ?? []
                    const isChecked = selected.includes(opt)
                    return (
                      <label key={opt} className={`flex items-center gap-3 p-3 border rounded-[14px] cursor-pointer transition-colors ${
                        isChecked ? 'border-signal bg-signal-soft' : 'border-hairline hover:border-hairline-strong'
                      }`}>
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => {
                            const next = isChecked ? selected.filter(v => v !== opt) : [...selected, opt]
                            setMultiSelectAnswers((prev) => ({ ...prev, [q.id]: next }))
                          }}
                          className="accent-[var(--signal)]"
                        />
                        <span className="text-ink">{opt}</span>
                      </label>
                    )
                  })}
                </div>
              )}

              {q.type === 'ORDERING' && (orderedItems[q.id] ?? []).length > 0 && (
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleOrderDragEnd(q.id)}
                >
                  <SortableContext items={orderedItems[q.id]} strategy={verticalListSortingStrategy}>
                    <div className="space-y-2">
                      {orderedItems[q.id].map((item) => (
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
                    onInit={(ketcher) => { ketcherRefs.current[q.id] = ketcher }}
                  />
                </div>
              )}
            </div>
          ))}

          {submitError && (
            <p className="text-red-500 text-sm bg-red-50 rounded-sm px-3 py-2">{submitError}</p>
          )}

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full bg-signal text-white rounded-[14px] py-4 text-base font-bold hover:bg-[var(--signal-bright)] disabled:opacity-50 transition-colors"
          >
            {isSubmitting ? 'Submitting…' : 'Submit response'}
          </button>
        </form>
      </div>
    </StudentLayout>
  )
}
