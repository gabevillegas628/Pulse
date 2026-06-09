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
import { Plus, BookOpen, X } from 'lucide-react'
import type { ClassWithCounts } from 'shared'
import { apiError } from '@/lib/errors'

const schema = z.object({
  name: z.string().min(1, 'Class name is required'),
  description: z.string().optional(),
})
type FormData = z.infer<typeof schema>

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

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

  const liveItems = (data ?? []).flatMap((cls) => {
    const session = cls.sessions[0] as (typeof cls.sessions[0] & { isLive?: boolean }) | undefined
    if (!session?.isLive) return []
    return [{ cls, session }]
  })

  const activeCount = (data ?? []).length

  return (
    <ProfessorLayout>
      {/* ── Live session banner ─────────────────────────────────────────── */}
      {liveItems.length > 0 && (
        <div className="mb-6 bg-signal rounded-[14px] px-6 py-5 text-white">
          <p className="text-xs font-bold uppercase tracking-widest opacity-80 mb-1.5">● Live now</p>
          {liveItems.map(({ cls, session }) => (
            <div key={session.id} className="flex items-center justify-between gap-4 flex-wrap">
              <div>
                <p className="text-xl font-bold leading-snug">
                  {session.title} — {cls.name}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Link
                  to={`/professor/sessions/${session.id}`}
                  className="inline-flex items-center gap-1.5 text-sm font-bold text-white border border-white/40 hover:border-white/80 px-4 py-2 rounded-sm transition-colors"
                >
                  End
                </Link>
                <Link
                  to={`/professor/sessions/${session.id}`}
                  className="inline-flex items-center gap-1.5 text-sm font-bold text-signal bg-white hover:bg-white/90 px-4 py-2 rounded-sm transition-colors"
                >
                  Open monitor ▸
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Page header ─────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-ink">Classes</h1>
          {activeCount > 0 && (
            <p className="text-sm text-muted mt-0.5">{activeCount} active</p>
          )}
        </div>
        <Button variant="primary" onClick={() => setShowModal(true)}>
          <Plus size={16} />
          New class
        </Button>
      </div>

      {/* ── Class grid ──────────────────────────────────────────────────── */}
      {isLoading ? (
        <Empty icon={BookOpen} message="Loading classes…" />
      ) : data?.length === 0 ? (
        <Empty icon={BookOpen} message="No classes yet — create one to get started." />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {data?.map((cls) => {
            const lastSession = cls.sessions[0] as (typeof cls.sessions[0] & { isLive?: boolean }) | undefined
            const isLive = lastSession?.isLive === true
            return (
              <Link key={cls.id} to={`/professor/classes/${cls.id}`}>
                <Card className={`p-6 hover:shadow-pop transition-shadow cursor-pointer h-full flex flex-col gap-4 ${isLive ? 'border-signal/30' : ''}`}>
                  {/* Title row */}
                  <div>
                    <p className="font-semibold text-ink leading-snug">{cls.name}</p>
                    {cls.description && (
                      <p className="text-xs text-muted mt-0.5 line-clamp-1">{cls.description}</p>
                    )}
                  </div>

                  {/* Stats row */}
                  <div className="flex items-end gap-5 mt-auto">
                    <div>
                      <p className="text-xl font-bold font-mono text-ink leading-none">{cls._count.enrollments}</p>
                      <p className="text-xs text-muted mt-0.5">students</p>
                    </div>
                    <div>
                      <p className="text-xl font-bold font-mono text-ink leading-none">{cls._count.sessions}</p>
                      <p className="text-xs text-muted mt-0.5">sessions</p>
                    </div>
                    {cls.participationRate != null && (
                      <div>
                        <p className={`text-xl font-bold font-mono leading-none ${cls.participationRate >= 0.75 ? 'text-signal' : cls.participationRate >= 0.5 ? 'text-warn' : 'text-muted'}`}>
                          {Math.round(cls.participationRate * 100)}%
                        </p>
                        <p className="text-xs text-muted mt-0.5">participation</p>
                      </div>
                    )}
                  </div>

                  {/* Participation bar */}
                  {cls.participationRate != null && (
                    <div className="h-1.5 bg-surface-2 rounded-full overflow-hidden -mb-1">
                      <div
                        className={`h-full rounded-full ${cls.participationRate >= 0.75 ? 'bg-signal' : cls.participationRate >= 0.5 ? 'bg-warn' : 'bg-muted'}`}
                        style={{ width: `${Math.round(cls.participationRate * 100)}%` }}
                      />
                    </div>
                  )}

                  {/* Footer: join code + recency */}
                  <div className="pt-3 border-t border-hairline flex items-center justify-between gap-2">
                    <CodeChip>{cls.joinCode}</CodeChip>
                    {lastSession && (
                      <span className="text-xs text-muted">
                        {isLive ? (
                          <span className="text-signal font-semibold">Live now</span>
                        ) : (
                          `opener ${timeAgo(lastSession.createdAt)}`
                        )}
                      </span>
                    )}
                  </div>
                </Card>
              </Link>
            )
          })}
        </div>
      )}

      {/* ── Create class modal ───────────────────────────────────────────── */}
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
