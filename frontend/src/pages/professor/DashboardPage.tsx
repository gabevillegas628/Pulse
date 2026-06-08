import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { api } from '@/api/client'
import ProfessorLayout from '@/components/layout/ProfessorLayout'
import Button from '@/components/ui/Button'
import Card from '@/components/ui/Card'
import CodeChip from '@/components/ui/CodeChip'
import Empty from '@/components/ui/Empty'
import { Plus, BookOpen, Users, X } from 'lucide-react'
import type { ClassWithCounts } from 'shared'
import { apiError } from '@/lib/errors'

const schema = z.object({
  name: z.string().min(1, 'Class name is required'),
  description: z.string().optional(),
})
type FormData = z.infer<typeof schema>

export default function DashboardPage() {
  const qc = useQueryClient()
  const [showModal, setShowModal] = useState(false)
  const [createError, setCreateError] = useState('')

  const { data, isLoading } = useQuery<ClassWithCounts[]>({
    queryKey: ['classes'],
    queryFn: () => api.get('/classes').then((r) => r.data.data.classes),
  })

  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm<FormData>({
    resolver: zodResolver(schema),
  })

  const createMutation = useMutation({
    mutationFn: (body: FormData) => api.post('/classes', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['classes'] })
      setShowModal(false)
      reset()
    },
    onError: (e: unknown) => {
      setCreateError(apiError(e, 'Failed to create class'))
    },
  })

  async function onSubmit(data: FormData) {
    setCreateError('')
    createMutation.mutate(data)
  }

  return (
    <ProfessorLayout>
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-bold text-ink">Classes</h1>
        <Button variant="primary" onClick={() => setShowModal(true)}>
          <Plus size={16} />
          New class
        </Button>
      </div>

      {isLoading ? (
        <Empty icon={BookOpen} message="Loading classes…" />
      ) : data?.length === 0 ? (
        <Empty icon={BookOpen} message="No classes yet — create one to get started." />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {data?.map((cls) => (
            <Link key={cls.id} to={`/professor/classes/${cls.id}`}>
              <Card className="p-6 hover:shadow-pop transition-shadow cursor-pointer h-full">
                <h2 className="font-semibold text-ink mb-1">{cls.name}</h2>
                {cls.description && (
                  <p className="text-sm text-muted mb-3 line-clamp-1">{cls.description}</p>
                )}
                <div className="flex items-center gap-4 text-xs text-muted mt-auto">
                  <span className="flex items-center gap-1">
                    <BookOpen size={12} />
                    {cls._count.sessions} sessions
                  </span>
                  <span className="flex items-center gap-1">
                    <Users size={12} />
                    {cls._count.enrollments} students
                  </span>
                </div>
                <div className="mt-3 pt-3 border-t border-hairline">
                  <CodeChip>{cls.joinCode}</CodeChip>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}

      {/* Create class modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
          <Card className="w-full max-w-md p-6 shadow-pop">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-lg font-semibold text-ink">New class</h2>
              <button
                onClick={() => { setShowModal(false); reset() }}
                className="text-muted hover:text-ink-2 transition-colors"
              >
                <X size={20} />
              </button>
            </div>

            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-ink-2 mb-1">Class name</label>
                <input
                  {...register('name')}
                  placeholder="Biochemistry 395"
                  className="w-full border border-hairline rounded-sm px-3 py-2.5 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-signal"
                  autoFocus
                />
                {errors.name && <p className="text-red-500 text-xs mt-1">{errors.name.message}</p>}
              </div>

              <div>
                <label className="block text-sm font-medium text-ink-2 mb-1">Description (optional)</label>
                <input
                  {...register('description')}
                  placeholder="Fall 2026"
                  className="w-full border border-hairline rounded-sm px-3 py-2.5 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-signal"
                />
              </div>

              {createError && <p className="text-red-500 text-sm">{createError}</p>}

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => { setShowModal(false); reset() }}
                  className="px-4 py-2 text-sm text-muted hover:text-ink transition-colors"
                >
                  Cancel
                </button>
                <Button type="submit" variant="primary" disabled={isSubmitting}>
                  {isSubmitting ? 'Creating…' : 'Create class'}
                </Button>
              </div>
            </form>
          </Card>
        </div>
      )}
    </ProfessorLayout>
  )
}
