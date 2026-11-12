import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, Copy, FolderInput, Package, Plus, ScanLine } from 'lucide-react'
import { api } from '@/api/client'
import Button from '@/components/ui/Button'
import Card from '@/components/ui/Card'
import Empty from '@/components/ui/Empty'
import Pill from '@/components/ui/Pill'
import { apiError } from '@/lib/errors'
import type { QuizContentSummary } from '@/lib/quizGrader'

/**
 * A class's paper quizzes: scanned, handwritten quizzes graded against an answer key.
 * Each quiz belongs to one class, whose roster its papers are matched against. Quizzes not
 * in any class yet (made before quizzes belonged to classes) can be moved in from here.
 */

type QuizRow = QuizContentSummary & { papers: number; graded: number; matched: number }
interface Data {
  class: { id: string; name: string }
  quizzes: QuizRow[]
  unfiled: QuizRow[]
  elsewhere: { id: string; title: string; classId: string }[]
}

const inputClass = 'border border-hairline rounded-sm px-2.5 py-1.5 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-signal'

export default function ClassPaperQuizzes({ classId }: { classId: string }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [newTitle, setNewTitle] = useState<string | null>(null)
  const [copyFrom, setCopyFrom] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ tone: 'good' | 'warn'; text: string } | null>(null)
  const { data, isLoading } = useQuery<Data>({
    queryKey: ['quiz-grader', 'class', classId],
    queryFn: () => api.get(`/quiz-grader/classes/${classId}/quizzes`).then((r) => r.data.data),
    staleTime: 0,
  })
  const refresh = () => void qc.invalidateQueries({ queryKey: ['quiz-grader'] })

  async function run(fn: () => Promise<void>, failure: string) {
    setBusy(true)
    setNote(null)
    try { await fn() } catch (e) { setNote({ tone: 'warn', text: apiError(e, failure) }) } finally { setBusy(false) }
  }

  const create = (title: string) => run(async () => {
    const r = await api.post('/quiz-grader/quizzes', { title, classId })
    refresh()
    navigate(`/professor/quiz-grader/${r.data.data.id}?tab=key`)
  }, 'Could not create the quiz')

  const examples = () => run(async () => {
    const r = await api.post('/quiz-grader/starter', { classId })
    const added = r.data.data.added as string[]
    setNote({ tone: 'good', text: added.length ? `Added ${added.length} example quiz${added.length > 1 ? 'zes' : ''}.` : 'This class already has the examples.' })
    refresh()
  }, 'Could not add the examples')

  const copy = (id: string) => run(async () => {
    await api.post(`/quiz-grader/quizzes/${id}/copy`, { classId })
    setCopyFrom('')
    setNote({ tone: 'good', text: 'Copied: its answer key, boxes, blank form and settings. Not its scans or grades.' })
    refresh()
  }, 'Could not copy the quiz')

  const moveHere = (id: string) => run(async () => {
    await api.put(`/quiz-grader/content/${id}/class`, { classId })
    refresh()
  }, 'Could not move the quiz')

  if (isLoading || !data) return null
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <Button variant="primary" onClick={() => setNewTitle('')}><Plus size={15} />New paper quiz</Button>
        {data.elsewhere.length > 0 && (
          <div className="flex items-center gap-2">
            <select className={inputClass} value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)} aria-label="Quiz to copy from another class">
              <option value="">Copy a quiz from another class…</option>
              {data.elsewhere.map((q) => <option key={q.id} value={q.id}>{q.title}</option>)}
            </select>
            {copyFrom && <Button size="sm" disabled={busy} onClick={() => void copy(copyFrom)}><Copy size={13} />Copy here</Button>}
          </div>
        )}
        <span className="flex-1" />
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void examples()} title="The glycolysis and TCA quizzes, ready to print">
          <Package size={13} />Add glycolysis &amp; TCA examples
        </Button>
      </div>

      {newTitle !== null && (
        <Card className="p-4 mb-4">
          <form className="flex flex-wrap gap-2 items-end" onSubmit={(e) => { e.preventDefault(); if (newTitle.trim()) void create(newTitle.trim()) }}>
            <label className="flex-1 min-w-56">
              <span className="text-xs font-semibold text-muted">Quiz name</span>
              <input autoFocus className={`${inputClass} w-full`} placeholder="e.g. Pentose phosphate pathway quiz"
                value={newTitle} onChange={(e) => setNewTitle(e.target.value)} />
            </label>
            <Button type="button" onClick={() => setNewTitle(null)}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={!newTitle.trim() || busy}>Create</Button>
          </form>
          <p className="text-xs text-muted mt-2">Next: write the answer key, upload the blank form, and draw a box for each answer.</p>
        </Card>
      )}
      {note && <p className={`text-sm mb-3 ${note.tone === 'good' ? 'text-good' : 'text-warn'}`}>{note.text}</p>}

      {data.quizzes.length === 0 ? (
        <Card className="p-6 mb-6">
          <Empty icon={ScanLine} message="No paper quizzes in this class yet. Make one, copy one from another class, or add the glycolysis and TCA examples." />
        </Card>
      ) : (
        <Card className="divide-y divide-hairline mb-6">
          {data.quizzes.map((q) => (
            <Link key={q.id} to={`/professor/quiz-grader/${q.id}`} className="px-4 py-3 flex items-center gap-3 hover:bg-surface-2">
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-ink">{q.title}</p>
                <p className="text-xs text-muted">
                  {q.papers ? `${q.graded} of ${q.papers} papers graded · ${q.matched} matched to students` : 'No scans yet'}
                </p>
              </div>
              {q.issues.length > 0 ? <Pill variant="warn">Has errors</Pill> : q.warnings.length > 0 ? <Pill variant="muted">Setting up</Pill> : <Pill variant="good">Ready</Pill>}
              <ChevronRight size={16} className="text-muted" />
            </Link>
          ))}
        </Card>
      )}

      {data.unfiled.length > 0 && (
        <section className="mb-6">
          <h3 className="text-sm font-semibold text-ink">Not in any class yet</h3>
          <p className="text-xs text-muted mb-2">Quizzes made before paper quizzes belonged to classes. Move each into the class that took it; its scans and grades come with it.</p>
          <Card className="divide-y divide-hairline">
            {data.unfiled.map((q) => (
              <div key={q.id} className="px-4 py-3 flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-ink">{q.title}</p>
                  <p className="text-xs text-muted">{q.papers ? `${q.papers} papers scanned` : 'No scans yet'}</p>
                </div>
                <Button size="sm" disabled={busy} onClick={() => void moveHere(q.id)}><FolderInput size={13} />Move to this class</Button>
              </div>
            ))}
          </Card>
        </section>
      )}

      <p className="text-xs text-muted">
        To back up or share quizzes as files, see <Link to="/professor/quiz-grader" className="text-signal hover:underline">all paper quizzes and files</Link>.
      </p>
    </div>
  )
}
