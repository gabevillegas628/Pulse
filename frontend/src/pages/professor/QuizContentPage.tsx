import { useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ChevronRight, CircleAlert, Download, FileUp, Package, Plus, ScanLine, Trash2, X } from 'lucide-react'
import { api } from '@/api/client'
import ProfessorLayout from '@/components/layout/ProfessorLayout'
import Button from '@/components/ui/Button'
import Card from '@/components/ui/Card'
import Empty from '@/components/ui/Empty'
import Pill from '@/components/ui/Pill'
import ConfirmDialog, { type DialogRequest } from '@/components/ui/ConfirmDialog'
import { apiError, apiErrorCode } from '@/lib/errors'
import { KIND_LABEL, saveText, type QuizContentKind, type QuizContentSummary } from '@/lib/quizGrader'

/**
 * Paper quizzes: one row per quiz, each opening the quiz page where it is set up,
 * printed, scanned and graded. The YAML files underneath (settings, answer key, boxes)
 * are tucked under Files, for import, export and backup.
 */

const ORDER: QuizContentKind[] = ['ASSESSMENT', 'KEY', 'LAYOUT']
const SECTION: Record<QuizContentKind, { title: string; blurb: string }> = {
  ASSESSMENT: { title: 'Quiz settings', blurb: 'Points, review rules and versions. One per quiz.' },
  KEY: { title: 'Answer keys', blurb: 'Steps, intermediates and accepted answers.' },
  LAYOUT: { title: 'Boxes', blurb: 'Where each answer sits on a blank form, with the form’s PDF.' },
}

function ago(iso: string) {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  return hrs < 24 ? `${hrs}h ago` : `${Math.floor(hrs / 24)}d ago`
}

export default function QuizContentPage() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [newTitle, setNewTitle] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const [dialog, setDialog] = useState<DialogRequest | null>(null)
  const [notice, setNotice] = useState<{ tone: 'good' | 'warn'; text: string } | null>(null)

  const { data: items, isLoading } = useQuery<QuizContentSummary[]>({
    queryKey: ['quiz-grader', 'content'],
    queryFn: () => api.get('/quiz-grader/content').then((r) => r.data.data.items),
  })
  const refresh = () => qc.invalidateQueries({ queryKey: ['quiz-grader'] })
  const quizzes = (items ?? []).filter((i) => i.kind === 'ASSESSMENT')

  const starter = useMutation({
    mutationFn: () => api.post('/quiz-grader/starter').then((r) => r.data.data as { added: string[]; skipped: string[] }),
    onSuccess: (r) => {
      refresh()
      setNotice({ tone: 'good', text: r.added.length ? `Added ${r.added.length} starter files.` : 'You already have all the starter files.' })
    },
    onError: (e) => setNotice({ tone: 'warn', text: apiError(e, 'Could not load the starter content') }),
  })

  const create = useMutation({
    mutationFn: (title: string) => api.post('/quiz-grader/quizzes', { title }).then((r) => r.data.data as { id: string }),
    onSuccess: (r) => { refresh(); navigate(`/professor/quiz-grader/${r.id}?tab=key`) },
    onError: (e) => setNotice({ tone: 'warn', text: apiError(e, 'Could not create the quiz') }),
  })

  async function importFile(file: File, replace = false): Promise<void> {
    const source = await file.text()
    try {
      await api.post('/quiz-grader/content', { source, replace })
      refresh()
      setNotice({ tone: 'good', text: `Imported ${file.name}.` })
    } catch (e) {
      if (apiErrorCode(e) === 'QUIZ_CONTENT_EXISTS') {
        setDialog({
          title: 'Replace the existing one?',
          body: `${apiError(e)} Replacing overwrites it with ${file.name}; any edits made here are lost.`,
          confirmLabel: 'Replace',
          destructive: true,
          onConfirm: () => void importFile(file, true),
        })
      } else {
        setNotice({ tone: 'warn', text: `${file.name}: ${apiError(e, 'could not be imported')}` })
      }
    }
  }

  async function download(item: QuizContentSummary) {
    const r = await api.get(`/quiz-grader/content/${item.id}/yaml`, { responseType: 'text', transformResponse: (x) => x })
    saveText(`${item.slug}.yaml`, r.data as string)
  }

  function remove(item: QuizContentSummary) {
    setDialog({
      title: `Delete ${item.title}?`,
      body: 'Download it first if you might want it back. This cannot be undone.',
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: async () => {
        try {
          await api.delete(`/quiz-grader/content/${item.id}`)
          refresh()
        } catch (e) {
          setNotice({ tone: 'warn', text: apiError(e, 'Could not delete') })
        }
      },
    })
  }

  return (
    <ProfessorLayout>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-ink">Paper quizzes</h1>
          <p className="text-sm text-muted mt-1">Print a quiz, scan the papers, and grade the handwriting against your answer key.</p>
        </div>
        <Button variant="primary" onClick={() => setNewTitle('')}><Plus size={15} />New quiz</Button>
      </div>

      {notice && (
        <div className={`mb-4 text-sm rounded-sm px-4 py-2.5 flex items-center justify-between border ${notice.tone === 'good' ? 'bg-good-soft border-good/30 text-good' : 'bg-warn-soft border-warn/30 text-warn'}`}>
          <span>{notice.text}</span>
          <button onClick={() => setNotice(null)} className="hover:opacity-70" aria-label="Dismiss"><X size={14} /></button>
        </div>
      )}

      {newTitle !== null && (
        <Card className="p-4 mb-5">
          <form className="flex flex-wrap gap-2 items-end" onSubmit={(e) => { e.preventDefault(); if (newTitle.trim()) create.mutate(newTitle.trim()) }}>
            <label className="flex-1 min-w-56">
              <span className="text-xs font-semibold text-muted">Quiz name</span>
              <input autoFocus className="w-full border border-hairline rounded-sm px-2.5 py-1.5 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-signal"
                placeholder="e.g. Pentose phosphate pathway quiz" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} />
            </label>
            <Button type="button" onClick={() => setNewTitle(null)}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={!newTitle.trim() || create.isPending}>Create</Button>
          </form>
          <p className="text-xs text-muted mt-2">Next: write the answer key, upload the blank form, and draw a box for each answer.</p>
        </Card>
      )}

      {isLoading ? null : (
        <>
          {!quizzes.length ? (
            <Card className="p-6 mb-8">
              <Empty icon={ScanLine} message="No quizzes yet. Create one, or load the glycolysis and TCA examples." />
              <div className="flex justify-center mt-2">
                <Button onClick={() => starter.mutate()} disabled={starter.isPending}><Package size={15} />Load glycolysis &amp; TCA examples</Button>
              </div>
            </Card>
          ) : (
            <Card className="divide-y divide-hairline mb-10">
              {quizzes.map((q) => (
                <Link key={q.id} to={`/professor/quiz-grader/${q.id}`} className="px-4 py-3 flex items-center gap-3 hover:bg-surface-2">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-ink">{q.title}</p>
                    <p className="text-xs text-muted">updated {ago(q.updatedAt)}</p>
                    {q.issues.length > 0 && <p className="text-xs text-warn mt-1 flex gap-1"><CircleAlert size={13} className="shrink-0 mt-px" />{q.issues[0]}</p>}
                  </div>
                  {q.issues.length > 0 ? <Pill variant="warn">Has errors</Pill> : q.warnings.length > 0 ? <Pill variant="muted">Setting up</Pill> : <Pill variant="good">Ready</Pill>}
                  <ChevronRight size={16} className="text-muted" />
                </Link>
              ))}
            </Card>
          )}

          <details className="group">
            <summary className="text-sm font-semibold text-ink cursor-pointer mb-1">Files</summary>
            <p className="text-xs text-muted mb-4 max-w-2xl">
              Each quiz is kept as three YAML files. You only need these to back up, share, or edit by hand and import again; a quiz’s Files tab has the same downloads.
            </p>
            <div className="flex flex-wrap gap-2 mb-6">
              <Button size="sm" onClick={() => fileInput.current?.click()}><FileUp size={13} />Import YAML</Button>
              <Button size="sm" onClick={() => starter.mutate()} disabled={starter.isPending}><Package size={13} />Load glycolysis &amp; TCA examples</Button>
              <input
                ref={fileInput}
                type="file"
                accept=".yaml,.yml,text/yaml,application/yaml"
                multiple
                className="hidden"
                onChange={async (e) => {
                  const files = Array.from(e.target.files ?? [])
                  e.target.value = ''
                  for (const f of files) await importFile(f)
                }}
              />
            </div>
            <div className="space-y-8">
              {ORDER.map((kind) => {
                const rows = (items ?? []).filter((i) => i.kind === kind)
                if (!rows.length) return null
                return (
                  <section key={kind}>
                    <h2 className="text-base font-semibold text-ink">{SECTION[kind].title}</h2>
                    <p className="text-xs text-muted mb-3">{SECTION[kind].blurb}</p>
                    <Card className="divide-y divide-hairline">
                      {rows.map((item) => (
                        <div key={item.id} className="px-4 py-3 flex flex-wrap items-center gap-3">
                          <div className="min-w-0 flex-1">
                            <Link to={`/professor/quiz-grader/${item.id}`} className="font-mono text-sm text-ink hover:text-signal">{item.slug}.yaml</Link>
                            <div className="text-xs text-muted mt-0.5">{KIND_LABEL[item.kind]} · {item.title} · updated {ago(item.updatedAt)}</div>
                            {item.issues.length > 0 && (
                              <p className="text-xs text-warn mt-1 flex gap-1"><CircleAlert size={13} className="shrink-0 mt-px" />{item.issues[0]}{item.issues.length > 1 ? ` (+${item.issues.length - 1} more)` : ''}</p>
                            )}
                            {item.warnings.map((w) => (
                              <p key={w} className="text-xs text-muted mt-1 flex gap-1"><AlertTriangle size={13} className="shrink-0 mt-px" />{w}</p>
                            ))}
                          </div>
                          <div className="flex gap-1.5">
                            <Button size="sm" onClick={() => void download(item)} title="Download YAML"><Download size={13} />YAML</Button>
                            <Button size="sm" onClick={() => remove(item)} title="Delete" aria-label={`Delete ${item.slug}`}><Trash2 size={13} /></Button>
                          </div>
                        </div>
                      ))}
                    </Card>
                  </section>
                )
              })}
            </div>
          </details>
        </>
      )}

      <ConfirmDialog request={dialog} onClose={() => setDialog(null)} />
    </ProfessorLayout>
  )
}
