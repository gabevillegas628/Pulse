import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/api/client'
import { useProfessorAuth } from '@/context/ProfessorAuthContext'
import AdminLayout from '@/components/layout/AdminLayout'
import AdminSetPasswordModal from '@/components/AdminSetPasswordModal'
import Button from '@/components/ui/Button'
import Card from '@/components/ui/Card'
import Empty from '@/components/ui/Empty'
import { UserPlus, UserX, UserCheck, ArrowRightLeft, Pencil, KeyRound, X, Users } from 'lucide-react'
import type { AdminProfessorSummary, AdminClassSummary } from 'shared'
import { apiError } from '@/lib/errors'

/**
 * The system view: every professor, every class, and the numbers that make a
 * forgotten account visible. The motivating case was a real class — 61 students,
 * 121 answers — running for a term under a second account no screen would ever
 * have shown. This page's one job is that nothing can hide like that again.
 *
 * Admin power lives only here. The rest of the app treats an admin as an
 * ordinary professor: their dashboard shows their own classes, and nothing
 * they own gains any reach.
 */

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

const inputClass =
  'w-full border border-hairline rounded-sm px-3 py-2.5 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-signal'

export default function AdminPage() {
  const qc = useQueryClient()
  const { professor: me } = useProfessorAuth()
  const [showCreate, setShowCreate] = useState(false)
  const [transferTarget, setTransferTarget] = useState<{ cls: AdminClassSummary; fromId: string } | null>(null)
  const [editTarget, setEditTarget] = useState<AdminProfessorSummary | null>(null)
  const [passwordTarget, setPasswordTarget] = useState<AdminProfessorSummary | null>(null)
  const [actionError, setActionError] = useState('')

  const { data, isLoading } = useQuery<AdminProfessorSummary[]>({
    queryKey: ['admin', 'professors'],
    queryFn: () => api.get('/admin/professors').then((r) => r.data.data.professors),
    enabled: !!me?.isAdmin,
  })

  const invalidate = () => qc.invalidateQueries({ queryKey: ['admin', 'professors'] })

  const deactivateMutation = useMutation({
    mutationFn: (id: string) => api.post(`/admin/professors/${id}/deactivate`),
    onSuccess: invalidate,
    onError: (e: unknown) => setActionError(apiError(e, 'Failed to deactivate account')),
  })

  const reactivateMutation = useMutation({
    mutationFn: (id: string) => api.post(`/admin/professors/${id}/reactivate`),
    onSuccess: invalidate,
    onError: (e: unknown) => setActionError(apiError(e, 'Failed to reactivate account')),
  })

  return (
    <AdminLayout>
      <div className="flex justify-end mb-4">
        <Button variant="primary" onClick={() => setShowCreate(true)}>
          <UserPlus size={15} />
          Create account
        </Button>
      </div>

      {actionError && (
        <div className="mb-4 bg-warn-soft border border-warn/30 text-warn text-sm rounded-sm px-4 py-2.5 flex items-center justify-between">
          <span>{actionError}</span>
          <button onClick={() => setActionError('')} className="hover:opacity-70"><X size={14} /></button>
        </div>
      )}

      {isLoading ? (
        <Empty message="Loading…" />
      ) : !data?.length ? (
        <Empty icon={Users} message="No professor accounts" />
      ) : (
        <div className="space-y-4">
          {data.map((prof) => (
            <Card key={prof.id} className="p-5">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-bold text-ink">{prof.name}</span>
                    {prof.isAdmin && (
                      <span className="text-[11px] font-bold uppercase tracking-wide bg-signal-soft text-signal rounded-full px-2 py-0.5">Admin</span>
                    )}
                    {prof.deactivatedAt && (
                      <span className="text-[11px] font-bold uppercase tracking-wide bg-warn-soft text-warn rounded-full px-2 py-0.5">
                        Deactivated {timeAgo(prof.deactivatedAt)}
                      </span>
                    )}
                    {prof.id === me?.id && (
                      <span className="text-[11px] font-bold uppercase tracking-wide bg-surface-2 text-muted rounded-full px-2 py-0.5">You</span>
                    )}
                  </div>
                  <p className="text-sm text-muted mt-0.5">{prof.email}</p>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <Button onClick={() => { setActionError(''); setEditTarget(prof) }} title="Change name or email">
                    <Pencil size={15} />
                    Edit
                  </Button>
                  {prof.id !== me?.id && (
                    <Button onClick={() => { setActionError(''); setPasswordTarget(prof) }} title="Set a temporary password">
                      <KeyRound size={15} />
                      Password
                    </Button>
                  )}
                  {prof.id !== me?.id && (
                    prof.deactivatedAt ? (
                      <Button onClick={() => { setActionError(''); reactivateMutation.mutate(prof.id) }}>
                        <UserCheck size={15} />
                        Reactivate
                      </Button>
                    ) : (
                      <Button
                        onClick={() => {
                          setActionError('')
                          // Nothing in the student path checks the professor's status: a
                          // deactivated professor's courses keep running, unattended. So
                          // the moment of deactivation is the moment to say "transfer first".
                          const owns = prof.classes.length
                          const warning = owns > 0
                            ? `\n\nThey still own ${owns === 1 ? 'a class' : `${owns} classes`}. If a course is still being taught, transfer it first — students keep access either way, but nobody will be grading.`
                            : ''
                          if (!confirm(`Deactivate ${prof.name}? They will be signed out everywhere and unable to sign back in. Their classes and data are kept.${warning}`)) return
                          deactivateMutation.mutate(prof.id)
                        }}
                      >
                        <UserX size={15} />
                        Deactivate
                      </Button>
                    )
                  )}
                </div>
              </div>

              {prof.classes.length === 0 ? (
                <p className="text-sm text-muted mt-4">No classes</p>
              ) : (
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-[11px] font-bold uppercase tracking-wide text-muted border-b border-hairline">
                        <th className="py-2 pr-4 font-bold">Class</th>
                        <th className="py-2 pr-4 font-bold">Students</th>
                        <th className="py-2 pr-4 font-bold">Sessions</th>
                        <th className="py-2 pr-4 font-bold">Assignments</th>
                        <th className="py-2 pr-4 font-bold">Answers</th>
                        <th className="py-2 pr-4 font-bold">Last answer</th>
                        <th className="py-2 font-bold"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {prof.classes.map((cls) => (
                        <tr key={cls.id} className="border-b border-hairline last:border-0">
                          <td className="py-2.5 pr-4 font-medium text-ink">{cls.name}</td>
                          <td className="py-2.5 pr-4 text-ink-2">{cls.enrollmentCount}</td>
                          <td className="py-2.5 pr-4 text-ink-2">{cls.sessionCount}</td>
                          <td className="py-2.5 pr-4 text-ink-2">{cls.assignmentCount}</td>
                          <td className="py-2.5 pr-4 text-ink-2">{cls.responseCount}</td>
                          <td className="py-2.5 pr-4 text-muted">
                            {cls.lastResponseAt ? timeAgo(cls.lastResponseAt) : '—'}
                          </td>
                          <td className="py-2.5 text-right">
                            <button
                              onClick={() => { setActionError(''); setTransferTarget({ cls, fromId: prof.id }) }}
                              className="inline-flex items-center gap-1 text-muted hover:text-ink-2 transition-colors text-xs font-bold"
                              title="Transfer this class to another professor"
                            >
                              <ArrowRightLeft size={13} />
                              Transfer
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      <CreateAccountModal open={showCreate} onClose={() => setShowCreate(false)} onCreated={invalidate} />
      <TransferModal
        target={transferTarget}
        professors={data ?? []}
        onClose={() => setTransferTarget(null)}
        onTransferred={invalidate}
      />
      <EditProfessorModal target={editTarget} onClose={() => setEditTarget(null)} onSaved={invalidate} />
      <AdminSetPasswordModal
        endpoint={passwordTarget ? `/admin/professors/${passwordTarget.id}/set-password` : null}
        who={passwordTarget?.name ?? ''}
        onClose={() => setPasswordTarget(null)}
      />
    </AdminLayout>
  )
}

/**
 * The door that replaces the shared invite code for colleague number two: an
 * admin creates the account with a temporary password and hands it over out of
 * band. The professor changes it from the header menu once they're in.
 */
function CreateAccountModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)

  function handleClose() {
    setName(''); setEmail(''); setPassword(''); setError(''); setDone(false)
    onClose()
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await api.post('/admin/professors', { name, email, password })
      setDone(true)
      onCreated()
    } catch (err: unknown) {
      setError(apiError(err, 'Failed to create account'))
    } finally {
      setLoading(false)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
      <div className="bg-surface rounded-[14px] shadow-pop border border-hairline w-full max-w-sm p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-ink">Create professor account</h2>
          <button onClick={handleClose} className="text-muted hover:text-ink-2 transition-colors">
            <X size={18} />
          </button>
        </div>

        {done ? (
          <div className="py-2">
            <p className="text-good font-medium mb-2">Account created</p>
            <p className="text-sm text-muted">
              Hand <span className="font-medium text-ink-2">{email}</span> the temporary password out of band —
              they can change it from the key icon in the header once signed in.
            </p>
            <button onClick={handleClose} className="text-sm text-signal hover:underline mt-4">Close</button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" className={inputClass} autoFocus />
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="rutgers.edu email" className={inputClass} />
            <input type="text" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Temporary password (min 8 chars)" className={inputClass} />
            {error && <p className="text-sm text-warn">{error}</p>}
            <Button variant="primary" type="submit" disabled={loading || !name || !email || password.length < 8} className="w-full">
              {loading ? 'Creating…' : 'Create account'}
            </Button>
          </form>
        )}
      </div>
    </div>
  )
}

function TransferModal({
  target,
  professors,
  onClose,
  onTransferred,
}: {
  target: { cls: AdminClassSummary; fromId: string } | null
  professors: AdminProfessorSummary[]
  onClose: () => void
  onTransferred: () => void
}) {
  const [toId, setToId] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  function handleClose() {
    setToId(''); setError('')
    onClose()
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!target || !toId) return
    setError('')
    setLoading(true)
    try {
      await api.post(`/admin/classes/${target.cls.id}/transfer`, { toProfessorId: toId })
      onTransferred()
      handleClose()
    } catch (err: unknown) {
      setError(apiError(err, 'Failed to transfer class'))
    } finally {
      setLoading(false)
    }
  }

  if (!target) return null

  // Deactivated accounts are not offered: the server refuses them anyway, and
  // the workflow for someone leaving is transfer first, deactivate second.
  const candidates = professors.filter((p) => p.id !== target.fromId && !p.deactivatedAt)

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
      <div className="bg-surface rounded-[14px] shadow-pop border border-hairline w-full max-w-sm p-6">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-base font-semibold text-ink">Transfer class</h2>
          <button onClick={handleClose} className="text-muted hover:text-ink-2 transition-colors">
            <X size={18} />
          </button>
        </div>
        <p className="text-sm text-muted mb-4">
          Move <span className="font-medium text-ink-2">{target.cls.name}</span> — sessions, assignments,
          enrollments, and every answer — to another professor.
        </p>

        <form onSubmit={handleSubmit} className="space-y-3">
          <select value={toId} onChange={(e) => setToId(e.target.value)} className={inputClass}>
            <option value="">Choose a professor…</option>
            {candidates.map((p) => (
              <option key={p.id} value={p.id}>{p.name} ({p.email})</option>
            ))}
          </select>
          {error && <p className="text-sm text-warn">{error}</p>}
          <Button variant="primary" type="submit" disabled={loading || !toId} className="w-full">
            {loading ? 'Transferring…' : 'Transfer'}
          </Button>
        </form>
      </div>
    </div>
  )
}

function EditProfessorModal({ target, onClose, onSaved }: { target: AdminProfessorSummary | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (target) { setName(target.name); setEmail(target.email); setError('') }
  }, [target?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!target) return
    setError('')
    setLoading(true)
    try {
      await api.patch(`/admin/professors/${target.id}`, { name, email })
      onSaved()
      onClose()
    } catch (err: unknown) {
      setError(apiError(err, 'Failed to update professor'))
    } finally {
      setLoading(false)
    }
  }

  if (!target) return null

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
      <div className="bg-surface rounded-[14px] shadow-pop border border-hairline w-full max-w-sm p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-ink">Edit {target.name}</h2>
          <button onClick={onClose} className="text-muted hover:text-ink-2 transition-colors">
            <X size={18} />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" className={inputClass} />
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="rutgers.edu email" className={inputClass} />
          {error && <p className="text-sm text-warn">{error}</p>}
          <Button variant="primary" type="submit" disabled={loading || !name || !email} className="w-full">
            {loading ? 'Saving…' : 'Save'}
          </Button>
        </form>
      </div>
    </div>
  )
}
