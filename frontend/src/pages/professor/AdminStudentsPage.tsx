import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/api/client'
import AdminLayout from '@/components/layout/AdminLayout'
import AdminSetPasswordModal from '@/components/AdminSetPasswordModal'
import Button from '@/components/ui/Button'
import Card from '@/components/ui/Card'
import Empty from '@/components/ui/Empty'
import { Search, Mail, KeyRound, Pencil, Trash2, X, Users } from 'lucide-react'
import type { AdminStudentSummary } from 'shared'
import { apiError } from '@/lib/errors'

/**
 * Student management: the unscoped cases no professor's class view can reach.
 * A typo'd email (no self-service path exists for it), a password with no
 * working email behind it, a duplicate account that should not exist.
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

export default function AdminStudentsPage() {
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [q, setQ] = useState('')
  const [editTarget, setEditTarget] = useState<AdminStudentSummary | null>(null)
  const [passwordTarget, setPasswordTarget] = useState<AdminStudentSummary | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<AdminStudentSummary | null>(null)
  const [sentId, setSentId] = useState('')
  const [actionError, setActionError] = useState('')

  // Debounced so the query keys off settled input, not every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setQ(search), 300)
    return () => clearTimeout(t)
  }, [search])

  const { data, isLoading } = useQuery<{ total: number; students: AdminStudentSummary[] }>({
    queryKey: ['admin', 'students', q],
    queryFn: () => api.get('/admin/students', { params: q ? { q } : {} }).then((r) => r.data.data),
  })

  const invalidate = () => qc.invalidateQueries({ queryKey: ['admin', 'students'] })

  const sendResetMutation = useMutation({
    mutationFn: (id: string) => api.post(`/admin/students/${id}/send-reset`),
    onSuccess: (_res, id) => setSentId(id),
    onError: (e: unknown) => setActionError(apiError(e, 'Failed to send reset link')),
  })

  const students = data?.students ?? []
  const total = data?.total ?? 0

  return (
    <AdminLayout>
      <div className="relative mb-4 max-w-md">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by netID or email…"
          className={`${inputClass} pl-9`}
        />
      </div>

      {actionError && (
        <div className="mb-4 bg-warn-soft border border-warn/30 text-warn text-sm rounded-sm px-4 py-2.5 flex items-center justify-between">
          <span>{actionError}</span>
          <button onClick={() => setActionError('')} className="hover:opacity-70"><X size={14} /></button>
        </div>
      )}

      {isLoading ? (
        <Empty message="Loading…" />
      ) : students.length === 0 ? (
        <Empty icon={Users} message={q ? `No students match “${q}”` : 'No student accounts'} />
      ) : (
        <Card className="p-5">
          <p className="text-xs text-muted mb-3">
            {students.length < total ? `Showing ${students.length} of ${total} students — narrow the search` : `${total} student${total === 1 ? '' : 's'}`}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] font-bold uppercase tracking-wide text-muted border-b border-hairline">
                  <th className="py-2 pr-4 font-bold">NetID</th>
                  <th className="py-2 pr-4 font-bold">Email</th>
                  <th className="py-2 pr-4 font-bold">Classes</th>
                  <th className="py-2 pr-4 font-bold">Responses</th>
                  <th className="py-2 pr-4 font-bold">Joined</th>
                  <th className="py-2 font-bold"></th>
                </tr>
              </thead>
              <tbody>
                {students.map((s) => (
                  <tr key={s.id} className="border-b border-hairline last:border-0">
                    <td className="py-2.5 pr-4 font-medium text-ink">{s.netId}</td>
                    <td className="py-2.5 pr-4 text-ink-2">{s.email}</td>
                    <td className="py-2.5 pr-4 text-muted">
                      {s.enrollments.length ? s.enrollments.map((e) => e.className).join(', ') : '—'}
                    </td>
                    <td className="py-2.5 pr-4 text-ink-2">{s.responseCount}</td>
                    <td className="py-2.5 pr-4 text-muted">{timeAgo(s.createdAt)}</td>
                    <td className="py-2.5 text-right whitespace-nowrap">
                      <button
                        onClick={() => { setActionError(''); sendResetMutation.mutate(s.id) }}
                        className={`inline-flex items-center gap-1 text-xs font-bold mr-3 transition-colors ${
                          sentId === s.id ? 'text-good' : 'text-muted hover:text-ink-2'
                        }`}
                        title="Email them a password reset link"
                      >
                        <Mail size={13} />
                        {sentId === s.id ? 'Link sent' : 'Reset link'}
                      </button>
                      <button
                        onClick={() => { setActionError(''); setPasswordTarget(s) }}
                        className="inline-flex items-center gap-1 text-muted hover:text-ink-2 transition-colors text-xs font-bold mr-3"
                        title="Set a temporary password"
                      >
                        <KeyRound size={13} />
                        Password
                      </button>
                      <button
                        onClick={() => { setActionError(''); setEditTarget(s) }}
                        className="inline-flex items-center gap-1 text-muted hover:text-ink-2 transition-colors text-xs font-bold mr-3"
                        title="Change netID or email"
                      >
                        <Pencil size={13} />
                        Edit
                      </button>
                      <button
                        onClick={() => { setActionError(''); setDeleteTarget(s) }}
                        className="inline-flex items-center gap-1 text-muted hover:text-warn transition-colors text-xs font-bold"
                        title="Delete this account"
                      >
                        <Trash2 size={13} />
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <EditStudentModal target={editTarget} onClose={() => setEditTarget(null)} onSaved={invalidate} />
      <AdminSetPasswordModal
        endpoint={passwordTarget ? `/admin/students/${passwordTarget.id}/set-password` : null}
        who={passwordTarget?.netId ?? ''}
        onClose={() => setPasswordTarget(null)}
      />
      <DeleteStudentModal target={deleteTarget} onClose={() => setDeleteTarget(null)} onDeleted={invalidate} />
    </AdminLayout>
  )
}

function EditStudentModal({ target, onClose, onSaved }: { target: AdminStudentSummary | null; onClose: () => void; onSaved: () => void }) {
  const [netId, setNetId] = useState('')
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // Seed the form when a student is picked; keyed on id so reopening reseeds.
  useEffect(() => {
    if (target) { setNetId(target.netId); setEmail(target.email); setError('') }
  }, [target?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!target) return
    setError('')
    setLoading(true)
    try {
      await api.patch(`/admin/students/${target.id}`, { netId, email })
      onSaved()
      onClose()
    } catch (err: unknown) {
      setError(apiError(err, 'Failed to update student'))
    } finally {
      setLoading(false)
    }
  }

  if (!target) return null

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
      <div className="bg-surface rounded-[14px] shadow-pop border border-hairline w-full max-w-sm p-6">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-base font-semibold text-ink">Edit {target.netId}</h2>
          <button onClick={onClose} className="text-muted hover:text-ink-2 transition-colors">
            <X size={18} />
          </button>
        </div>
        <p className="text-sm text-muted mb-4">
          Everything hangs off the account itself — changing these touches only how they sign in.
        </p>
        <form onSubmit={handleSubmit} className="space-y-3">
          <input value={netId} onChange={(e) => setNetId(e.target.value)} placeholder="NetID" className={inputClass} />
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="rutgers.edu email" className={inputClass} />
          {error && <p className="text-sm text-warn">{error}</p>}
          <Button variant="primary" type="submit" disabled={loading || !netId || !email} className="w-full">
            {loading ? 'Saving…' : 'Save'}
          </Button>
        </form>
      </div>
    </div>
  )
}

/**
 * Deleting a student is the one place cascade is the point: their responses,
 * enrollments, and reset tokens go with the row. An account with answers makes
 * the admin type the netID back — heavier than anything else here, because
 * unlike professors there is no deactivate to fall back on.
 */
function DeleteStudentModal({ target, onClose, onDeleted }: { target: AdminStudentSummary | null; onClose: () => void; onDeleted: () => void }) {
  const [typed, setTyped] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (target) { setTyped(''); setError('') }
  }, [target?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleDelete() {
    if (!target) return
    setError('')
    setLoading(true)
    try {
      await api.delete(`/admin/students/${target.id}`)
      onDeleted()
      onClose()
    } catch (err: unknown) {
      setError(apiError(err, 'Failed to delete student'))
    } finally {
      setLoading(false)
    }
  }

  if (!target) return null

  const hasWork = target.responseCount > 0
  const armed = !hasWork || typed.trim() === target.netId

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
      <div className="bg-surface rounded-[14px] shadow-pop border border-hairline w-full max-w-sm p-6">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-base font-semibold text-ink">Delete {target.netId}?</h2>
          <button onClick={onClose} className="text-muted hover:text-ink-2 transition-colors">
            <X size={18} />
          </button>
        </div>
        <p className="text-sm text-muted mb-3">
          This removes the account
          {hasWork
            ? <> and <strong className="text-warn">{target.responseCount} response{target.responseCount === 1 ? '' : 's'}</strong></>
            : ''}
          {target.enrollments.length > 0
            ? <> across {target.enrollments.length} class{target.enrollments.length === 1 ? '' : 'es'}</>
            : ''}
          . It cannot be undone. For an account that should be kept but locked out, fix its sign-in instead of deleting it.
        </p>
        {hasWork && (
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={`Type ${target.netId} to confirm`}
            className={`${inputClass} mb-3`}
            autoFocus
          />
        )}
        {error && <p className="text-sm text-warn mb-3">{error}</p>}
        <Button
          variant="primary"
          onClick={handleDelete}
          disabled={loading || !armed}
          className="w-full !bg-warn hover:!bg-warn"
        >
          {loading ? 'Deleting…' : 'Delete account'}
        </Button>
      </div>
    </div>
  )
}
