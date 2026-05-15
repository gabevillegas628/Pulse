import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm, useFieldArray } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { api } from '@/api/client'
import ProfessorLayout from '@/components/layout/ProfessorLayout'
import { Plus, Trash2, X, ChevronLeft } from 'lucide-react'
import type { QuestionType } from 'shared'

const questionSchema = z.object({
  text: z.string().min(1, 'Question text required'),
  type: z.enum(['FREE_TEXT', 'MULTIPLE_CHOICE', 'RATING', 'YES_NO']),
  options: z.array(z.string()).optional(),
})

const sessionSchema = z.object({
  title: z.string().min(1, 'Title required'),
  questions: z.array(questionSchema).min(1, 'Add at least one question'),
})
type SessionFormData = z.infer<typeof sessionSchema>

const TYPE_LABELS: Record<QuestionType, string> = {
  FREE_TEXT: 'Free text',
  MULTIPLE_CHOICE: 'Multiple choice',
  RATING: 'Rating (1–5)',
  YES_NO: 'Yes / No',
}

export default function ClassPage() {
  const { classId } = useParams<{ classId: string }>()
  const qc = useQueryClient()
  const [showModal, setShowModal] = useState(false)
  const [createError, setCreateError] = useState('')

  const { data, isLoading } = useQuery({
    queryKey: ['class', classId],
    queryFn: () => api.get(`/classes/${classId}`).then((r) => r.data.data.class),
  })

  const { register, control, handleSubmit, reset, watch, setValue, formState: { errors, isSubmitting } } = useForm<SessionFormData>({
    resolver: zodResolver(sessionSchema),
    defaultValues: { title: '', questions: [{ text: '', type: 'FREE_TEXT', options: [] }] },
  })

  const { fields, append, remove } = useFieldArray({ control, name: 'questions' })

  const createMutation = useMutation({
    mutationFn: (body: SessionFormData) =>
      api.post(`/classes/${classId}/sessions`, {
        title: body.title,
        questions: body.questions.map((q, i) => ({ ...q, order: i })),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['class', classId] })
      setShowModal(false)
      reset()
    },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error
      setCreateError(msg ?? 'Failed to create session')
    },
  })

  const watchedQuestions = watch('questions')

  if (isLoading) return <ProfessorLayout><p className="text-gray-400">Loading…</p></ProfessorLayout>

  return (
    <ProfessorLayout>
      <div className="mb-6">
        <Link to="/professor" className="flex items-center gap-1 text-sm text-gray-400 hover:text-gray-600 mb-4">
          <ChevronLeft size={16} /> All classes
        </Link>
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{data?.name}</h1>
            {data?.description && <p className="text-gray-500 text-sm">{data.description}</p>}
            <div className="flex items-center gap-3 mt-2">
              <span className="text-xs text-gray-400">Join code:</span>
              <span className="font-mono text-sm bg-gray-100 px-2 py-0.5 rounded font-medium tracking-wider">{data?.joinCode}</span>
            </div>
          </div>
          <button
            onClick={() => setShowModal(true)}
            className="flex items-center gap-2 bg-primary-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary-700 transition-colors"
          >
            <Plus size={16} /> New session
          </button>
        </div>
      </div>

      {data?.sessions?.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-sm">No sessions yet — create one to start collecting responses</p>
        </div>
      ) : (
        <div className="space-y-3">
          {data?.sessions?.map((s: { id: string; title: string; status: string; questions: Array<{ id: string }>; createdAt: string }) => (
            <Link
              key={s.id}
              to={`/professor/sessions/${s.id}`}
              className="flex items-center justify-between bg-white border border-gray-200 rounded-xl p-5 hover:shadow-sm transition-shadow"
            >
              <div>
                <p className="font-medium text-gray-900">{s.title}</p>
                <p className="text-xs text-gray-400 mt-0.5">
                  {s.questions?.length ?? 0} question{(s.questions?.length ?? 0) !== 1 ? 's' : ''} ·{' '}
                  {new Date(s.createdAt).toLocaleDateString()}
                </p>
              </div>
              <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${
                s.status === 'OPEN' ? 'bg-green-100 text-green-700' :
                s.status === 'CLOSED' ? 'bg-gray-100 text-gray-500' :
                'bg-gray-50 text-gray-400'
              }`}>
                {s.status.charAt(0) + s.status.slice(1).toLowerCase()}
              </span>
            </Link>
          ))}
        </div>
      )}

      {/* Create session modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-start justify-center z-50 px-4 py-8 overflow-y-auto">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6 my-auto">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-lg font-semibold">New session</h2>
              <button onClick={() => { setShowModal(false); reset() }}><X size={20} className="text-gray-400" /></button>
            </div>

            <form onSubmit={handleSubmit((d) => { setCreateError(''); createMutation.mutate(d) })} className="space-y-5">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Session title</label>
                <input
                  {...register('title')}
                  placeholder="Week 3 Opener"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                  autoFocus
                />
                {errors.title && <p className="text-red-500 text-xs mt-1">{errors.title.message}</p>}
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm font-medium text-gray-700">Questions</label>
                  <button
                    type="button"
                    onClick={() => append({ text: '', type: 'FREE_TEXT', options: [] })}
                    className="text-xs text-primary-600 hover:text-primary-800 flex items-center gap-1"
                  >
                    <Plus size={13} /> Add question
                  </button>
                </div>

                <div className="space-y-4">
                  {fields.map((field, idx) => (
                    <div key={field.id} className="border border-gray-200 rounded-xl p-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-gray-400">Question {idx + 1}</span>
                        {fields.length > 1 && (
                          <button type="button" onClick={() => remove(idx)} className="text-gray-300 hover:text-red-400">
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>

                      <input
                        {...register(`questions.${idx}.text`)}
                        placeholder="Enter question text…"
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                      />
                      {errors.questions?.[idx]?.text && (
                        <p className="text-red-500 text-xs">{errors.questions[idx]?.text?.message}</p>
                      )}

                      <select
                        {...register(`questions.${idx}.type`)}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white"
                      >
                        {Object.entries(TYPE_LABELS).map(([val, label]) => (
                          <option key={val} value={val}>{label}</option>
                        ))}
                      </select>

                      {/* MCQ options */}
                      {watchedQuestions[idx]?.type === 'MULTIPLE_CHOICE' && (
                        <div className="space-y-2">
                          <p className="text-xs text-gray-500">Options (one per line)</p>
                          <textarea
                            rows={3}
                            placeholder={"Option A\nOption B\nOption C"}
                            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none"
                            onChange={(e) => {
                              const opts = e.target.value.split('\n').map((s) => s.trim()).filter(Boolean)
                              setValue(`questions.${idx}.options`, opts)
                            }}
                          />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {createError && <p className="text-red-500 text-sm">{createError}</p>}

              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => { setShowModal(false); reset() }} className="px-4 py-2 text-sm text-gray-600">
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-5 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50"
                >
                  {isSubmitting ? 'Creating…' : 'Create session'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </ProfessorLayout>
  )
}
