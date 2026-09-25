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
import LiveDot from '@/components/ui/LiveDot'
import Empty from '@/components/ui/Empty'
import { Plus, BookOpen, X } from 'lucide-react'
import type { ClassWithCounts } from 'shared'
import { apiError } from '@/lib/errors'

const schema = z.object({
  name: z.string().min(1, 'Class name is required'),
  description: z.string().optional(),
})
type FormData = z.infer<typeof schema>

/** "today, 10:30 AM", "yesterday, 2:15 PM", "Tue, Sep 16, 10:30 AM": reads after "Last run" */
function whenTaught(dateStr: string): string {
  const d = new Date(dateStr)
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86_400_000)
  if (days === 0) return `today, ${time}`
  if (days === 1) return `yesterday, ${time}`
  const date = d.toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
    year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
  })
  return `${date}, ${time}`
}

function rateTone(rate: number): string {
  if (rate >= 0.75) return 'text-signal'
  if (rate >= 0.5) return 'text-warn'
  return 'text-muted'
}

/**
 * One point per session taught, oldest on the left.
 *
 * A line, not bars: a bar's length claims a quantity from zero, so it can't honestly start
 * anywhere else, and from zero a 97 → 86 slide is a few pixels. A line only encodes
 * position. The floor is a fixed 50% — not the data's own minimum, which would turn every
 * wobble into a cliff and leave no two cards on the same scale — dropping by quarters only
 * for a class that goes below it.
 */
function ParticipationTrend({ points }: { points: Array<{ label: string; rate: number }> }) {
  // Steps down in quarters so the floor is always a labeled gridline
  const floor = Math.min(0.5, Math.floor(Math.min(...points.map((p) => p.rate)) * 4) / 4)
  const x = (i: number) => (i / (points.length - 1)) * 100
  const y = (rate: number) => (1 - (rate - floor) / (1 - floor)) * 100
  const last = points[points.length - 1]
  const pct = (rate: number) => `${Math.round(rate * 100)}%`
  const grid = [1, 0.75, 0.5, 0.25, 0].filter((g) => g >= floor)
  return (
    <div className="flex items-center gap-3" role="img" aria-label={`Participation by session: ${points.map((p) => pct(p.rate)).join(', ')}`}>
      {/* my-1.5 keeps a dot at 100% or at the floor from being clipped by the card's gap */}
      <div className="relative w-6 h-16 my-1.5 shrink-0" aria-hidden>
        {grid.map((g) => (
          <span
            key={g}
            className="absolute right-0 -translate-y-1/2 text-[10px] leading-none font-mono text-muted"
            style={{ top: `${y(g)}%` }}
          >
            {Math.round(g * 100)}
          </span>
        ))}
      </div>
      <div className="relative flex-1 h-16 my-1.5">
        {grid.map((g) => (
          <div key={g} className="absolute inset-x-0 border-t border-hairline" style={{ top: `${y(g)}%` }} />
        ))}
        <svg className="absolute inset-0 w-full h-full overflow-visible text-muted" viewBox="0 0 100 100" preserveAspectRatio="none">
          <polyline
            points={points.map((p, i) => `${x(i)},${y(p.rate)}`).join(' ')}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {points.map((p, i) => {
          const isLast = i === points.length - 1
          return (
            // Hit target is twice the dot, so hovering a point doesn't take aim
            <span
              key={i}
              title={`${p.label} · ${pct(p.rate)}`}
              className="absolute w-4 h-4 -translate-x-1/2 -translate-y-1/2 flex items-center justify-center"
              style={{ left: `${x(i)}%`, top: `${y(p.rate)}%` }}
            >
              <span className={`w-2 h-2 rounded-full ring-2 ring-surface ${isLast ? 'bg-signal' : 'bg-muted'}`} />
            </span>
          )
        })}
      </div>
      <span className="text-xs font-mono font-semibold text-ink shrink-0">{pct(last.rate)}</span>
    </div>
  )
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

  const liveItems = (data ?? []).flatMap((cls) => cls.liveSessions.map((session) => ({ cls, session })))

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
            const live = cls.liveSessions[0]
            return (
              <Link key={cls.id} to={`/professor/classes/${cls.id}`}>
                <Card className={`p-6 hover:shadow-pop transition-shadow cursor-pointer h-full flex flex-col gap-4 ${live ? 'border-signal/30' : ''}`}>
                  {/* Title row. The description gives way before the date does. */}
                  <div>
                    <p className="font-semibold text-ink leading-snug">{cls.name}</p>
                    <p className="flex items-center gap-1.5 text-xs text-muted mt-0.5 whitespace-nowrap">
                      {cls.description && (
                        <>
                          <span className="truncate min-w-0">{cls.description}</span>
                          <span aria-hidden>·</span>
                        </>
                      )}
                      {live ? (
                        <span className="flex items-center gap-1.5 min-w-0 text-signal font-semibold">
                          <LiveDot className="shrink-0" />
                          <span className="truncate">Live · {live.title}</span>
                        </span>
                      ) : (
                        <span className="shrink-0">
                          {cls.lastTaughtAt ? `Last run ${whenTaught(cls.lastTaughtAt)}` : 'Not run yet'}
                        </span>
                      )}
                    </p>
                  </div>

                  {/* Stats row */}
                  <div className="flex items-end gap-5 mt-auto">
                    <div>
                      <p className="text-xl font-bold font-mono text-ink leading-none">{cls._count.enrollments}</p>
                      <p className="text-xs text-muted mt-0.5">
                        students{cls.sectionCount > 1 && ` · ${cls.sectionCount} sections`}
                      </p>
                    </div>
                    <div>
                      <p className="text-xl font-bold font-mono text-ink leading-none">{cls.sessionsRun}</p>
                      <p className="text-xs text-muted mt-0.5">taught</p>
                    </div>
                    {cls.participationRate != null && (
                      <div>
                        <p className={`text-xl font-bold font-mono leading-none ${rateTone(cls.participationRate)}`}>
                          {Math.round(cls.participationRate * 100)}%
                        </p>
                        <p className="text-xs text-muted mt-0.5">participation</p>
                      </div>
                    )}
                  </div>

                  {cls.participationTrend.length > 1 && (
                    <div className="pt-3 border-t border-hairline">
                      <p className="text-xs text-muted mb-1.5">Participation trend</p>
                      <ParticipationTrend points={cls.participationTrend} />
                    </div>
                  )}
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
