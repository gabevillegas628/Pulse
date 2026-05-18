import { useEffect, useState, useRef, lazy, Suspense } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { useForm, Controller } from 'react-hook-form'
import { api } from '@/api/client'
import { useStudentAuth } from '@/context/StudentAuthContext'
import StudentLayout from '@/components/layout/StudentLayout'
import { io } from 'socket.io-client'
import type { Question } from 'shared'
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

const Jsme = lazy(() => import('@loschmidt/jsme-react').then(m => ({ default: m.Jsme })))

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
      className="flex items-center gap-2 px-3 py-2.5 border border-gray-300 rounded-xl text-sm text-gray-800 bg-white cursor-grab active:cursor-grabbing"
    >
      <span {...attributes} {...listeners} className="text-gray-300 hover:text-gray-500">
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
  // Per-question state for complex types
  const [orderedItems, setOrderedItems] = useState<Record<string, string[]>>({})
  const [multiSelectAnswers, setMultiSelectAnswers] = useState<Record<string, string[]>>({})
  const [structureAnswers, setStructureAnswers] = useState<Record<string, string>>({})
  const jsmeInitialSmiles = useRef<Record<string, string>>({})
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
        if (s.status !== 'OPEN') setSessionClosed(true)
        // Initialize ordering questions with shuffled options
        const initialOrders: Record<string, string[]> = {}
        s.questions.forEach((q) => {
          if (q.type === 'ORDERING' && q.options) {
            initialOrders[q.id] = [...q.options].sort(() => Math.random() - 0.5)
          }
        })
        setOrderedItems(initialOrders)
      })
      .catch((e) => {
        const msg = e?.response?.data?.error
        setLoadError(msg ?? 'Session not found')
      })
  }, [isAuthenticated, sessionId])

  useEffect(() => {
    if (!sessionId) return
    const socket = io({ path: '/socket.io' })
    socket.emit('join_session', sessionId)
    socket.on('session_status', ({ status }: { status: string }) => {
      if (status === 'CLOSED') setSessionClosed(true)
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
      const responses = session.questions.map((q) => {
        let responseText = data[q.id] ?? ''
        if (q.type === 'ORDERING') responseText = JSON.stringify(orderedItems[q.id] ?? [])
        if (q.type === 'MULTI_SELECT') responseText = JSON.stringify(multiSelectAnswers[q.id] ?? [])
        if (q.type === 'STRUCTURE') responseText = structureAnswers[q.id] ?? ''
        return { questionId: q.id, responseText }
      })
      await api.post('/responses', { sessionId: session.id, responses })
      navigate(`/s/${session.id}/confirmation`)
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error
      setSubmitError(msg ?? 'Submission failed — please try again')
    }
  }

  if (authLoading || (!session && !loadError)) {
    return <StudentLayout><div className="text-center py-16 text-gray-400">Loading…</div></StudentLayout>
  }

  if (loadError) {
    return (
      <StudentLayout>
        <div className="bg-white rounded-2xl border border-gray-200 p-8 text-center">
          <p className="text-gray-500">{loadError}</p>
        </div>
      </StudentLayout>
    )
  }

  if (sessionClosed) {
    return (
      <StudentLayout>
        <div className="bg-white rounded-2xl border border-gray-200 p-8 text-center">
          <p className="text-xl font-semibold text-gray-700 mb-2">Session closed</p>
          <p className="text-gray-400 text-sm">This session is no longer accepting responses.</p>
        </div>
      </StudentLayout>
    )
  }

  if (alreadySubmitted) {
    return (
      <StudentLayout>
        <div className="bg-white rounded-2xl border border-gray-200 p-8 text-center">
          <p className="text-xl font-semibold text-gray-700 mb-2">Already submitted</p>
          <p className="text-gray-400 text-sm">You've already responded to this session.</p>
        </div>
      </StudentLayout>
    )
  }

  return (
    <StudentLayout>
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
        <div className="bg-primary-600 px-6 py-4">
          <p className="text-primary-100 text-xs font-medium uppercase tracking-wide">{session!.class.name}</p>
          <h1 className="text-white text-lg font-semibold mt-0.5">{session!.title}</h1>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="p-6 space-y-8">
          {session!.questions.map((q, idx) => (
            <div key={q.id}>
              <p className="text-sm font-medium text-gray-800 mb-3">
                {session!.questions.length > 1 && <span className="text-primary-500 mr-1">Q{idx + 1}.</span>}
                {q.text}
              </p>

              {q.type === 'FREE_TEXT' && (
                <textarea
                  {...register(q.id)}
                  rows={4}
                  placeholder="Write your response…"
                  className="w-full border border-gray-300 rounded-lg px-3 py-3 text-base focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none"
                />
              )}

              {q.type === 'MULTIPLE_CHOICE' && q.options && (
                <Controller
                  name={q.id}
                  control={control}
                  render={({ field }) => (
                    <div className="space-y-2">
                      {q.options!.map((opt) => (
                        <label key={opt} className="flex items-center gap-3 p-3 border border-gray-200 rounded-lg cursor-pointer hover:bg-gray-50">
                          <input
                            type="radio"
                            value={opt}
                            checked={field.value === opt}
                            onChange={() => field.onChange(opt)}
                            className="accent-primary-600"
                          />
                          <span className="text-gray-800">{opt}</span>
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
                          className={`flex-1 py-3 rounded-lg border-2 text-lg font-semibold transition-colors ${
                            field.value === String(n)
                              ? 'border-primary-600 bg-primary-50 text-primary-700'
                              : 'border-gray-200 text-gray-500 hover:border-gray-300'
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
                          className={`flex-1 py-3 rounded-lg border-2 font-medium transition-colors ${
                            field.value === opt.toLowerCase()
                              ? 'border-primary-600 bg-primary-50 text-primary-700'
                              : 'border-gray-200 text-gray-600 hover:border-gray-300'
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
                        className="w-48 border border-gray-300 rounded-lg px-3 py-3 text-base focus:outline-none focus:ring-2 focus:ring-primary-500"
                      />
                      {q.unit && <span className="text-sm text-gray-500">{q.unit}</span>}
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
                      <label key={opt} className={`flex items-center gap-3 p-3 border rounded-xl cursor-pointer transition-colors ${
                        isChecked ? 'border-primary-500 bg-primary-50' : 'border-gray-200 hover:border-gray-300'
                      }`}>
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => {
                            const next = isChecked ? selected.filter(v => v !== opt) : [...selected, opt]
                            setMultiSelectAnswers((prev) => ({ ...prev, [q.id]: next }))
                          }}
                          className="accent-primary-600"
                        />
                        <span className="text-gray-800">{opt}</span>
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
                <Suspense fallback={<div className="h-40 bg-gray-50 rounded-xl animate-pulse" />}>
                  <Jsme
                    height="420px"
                    width="600px"
                    smiles={(jsmeInitialSmiles.current[q.id] ??= '')}
                    onChange={(s) => setStructureAnswers((prev) => ({ ...prev, [q.id]: s }))}
                    options="oldlook"
                  />
                </Suspense>
              )}
            </div>
          ))}

          {submitError && (
            <p className="text-red-500 text-sm bg-red-50 rounded-lg px-3 py-2">{submitError}</p>
          )}

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full bg-primary-600 text-white rounded-xl py-4 text-base font-semibold hover:bg-primary-700 disabled:opacity-50 transition-colors"
          >
            {isSubmitting ? 'Submitting…' : 'Submit response'}
          </button>
        </form>
      </div>
    </StudentLayout>
  )
}
