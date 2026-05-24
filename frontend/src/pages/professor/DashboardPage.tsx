import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { api } from '@/api/client'
import ProfessorLayout from '@/components/layout/ProfessorLayout'
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
        <h1 className="text-2xl font-bold text-gray-900">Classes</h1>
        <button
          onClick={() => setShowModal(true)}
          className="flex items-center gap-2 bg-primary-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary-700 transition-colors"
        >
          <Plus size={16} />
          New class
        </button>
      </div>

      {isLoading ? (
        <p className="text-gray-400">Loading…</p>
      ) : data?.length === 0 ? (
        <div className="text-center py-20 text-gray-400">
          <BookOpen className="mx-auto mb-4" size={40} />
          <p className="font-medium text-gray-500">No classes yet</p>
          <p className="text-sm mt-1">Create your first class to get started</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {data?.map((cls) => (
            <Link
              key={cls.id}
              to={`/professor/classes/${cls.id}`}
              className="bg-white border border-gray-200 rounded-2xl p-6 hover:shadow-md transition-shadow"
            >
              <h2 className="font-semibold text-gray-900 mb-1">{cls.name}</h2>
              {cls.description && <p className="text-sm text-gray-500 mb-3 line-clamp-1">{cls.description}</p>}
              <div className="flex items-center gap-4 text-xs text-gray-400 mt-auto">
                <span className="flex items-center gap-1">
                  <BookOpen size={12} />
                  {cls._count.sessions} sessions
                </span>
                <span className="flex items-center gap-1">
                  <Users size={12} />
                  {cls._count.enrollments} students
                </span>
              </div>
              <div className="mt-3 pt-3 border-t border-gray-100">
                <span className="text-xs font-mono bg-gray-100 text-gray-600 px-2 py-0.5 rounded">
                  {cls.joinCode}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}

      {/* Create class modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-lg font-semibold text-gray-900">New class</h2>
              <button onClick={() => { setShowModal(false); reset() }} className="text-gray-400 hover:text-gray-600">
                <X size={20} />
              </button>
            </div>

            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Class name</label>
                <input
                  {...register('name')}
                  placeholder="Biochemistry 395"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                  autoFocus
                />
                {errors.name && <p className="text-red-500 text-xs mt-1">{errors.name.message}</p>}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description (optional)</label>
                <input
                  {...register('description')}
                  placeholder="Fall 2026"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>

              {createError && <p className="text-red-500 text-sm">{createError}</p>}

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => { setShowModal(false); reset() }}
                  className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-5 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50"
                >
                  {isSubmitting ? 'Creating…' : 'Create class'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </ProfessorLayout>
  )
}
