import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ChevronRight, CircleAlert, Download, FileUp, ScanLine, Trash2, X } from 'lucide-react'
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
 * Every paper quiz, grouped by the class it belongs to. Quizzes are made and run from a
 * class's Paper Quizzes tab; this page is the overview across classes, plus the YAML
 * files underneath (settings, answer key, boxes) for import, export and backup.
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
  const fileInput = useRef<HTMLInputElement>(null)
  const [dialog, setDialog] = useState<DialogRequest | null>(null)
  const [notice, setNotice] = useState<{ tone: 'good' | 'warn'; text: string } | null>(null)

  const { data: items, isLoading } = useQuery<QuizContentSummary[]>({
    queryKey: ['quiz-grader', 'content'],
    queryFn: () => api.get('/quiz-grader/content').then((r) => r.data.data.items),
  })
  const refresh = () => qc.invalidateQueries({ queryKey: ['quiz-grader'] })
  const quizzes = (items ?? []).filter((i) => i.kind === 'ASSESSMENT')
  const { data: classes } = useQuery<{ id: string; name: string }[]>({
    queryKey: ['classes', 'list-for-quizzes'],
    queryFn: () => api.get('/classes').then((r) => r.data.data.classes),
  })
  // Quizzes by class, in the classes' order; those in no class last.
  const byClass = [
    ...(classes ?? []).map((c) => ({ id: c.id, name: c.name, quizzes: quizzes.filter((q) => q.classId === c.id) })).filter((g) => g.quizzes.length),
    { id: '', name: 'Not in any class yet', quizzes: quizzes.filter((q) => !q.classId || !(classes ?? []).some((c) => c.id === q.classId)) },
  ].filter((g) => g.quizzes.length)

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
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-ink">Paper quizzes</h1>
        <p className="text-sm text-muted mt-1">Every paper quiz, by class. Make and run quizzes from a class&rsquo;s <span className="font-semibold">Paper Quizzes</span> tab.</p>
      </div>

      {notice && (
        <div className={`mb-4 text-sm rounded-sm px-4 py-2.5 flex items-center justify-between border ${notice.tone === 'good' ? 'bg-good-soft border-good/30 text-good' : 'bg-warn-soft border-warn/30 text-warn'}`}>
          <span>{notice.text}</span>
          <button onClick={() => setNotice(null)} className="hover:opacity-70" aria-label="Dismiss"><X size={14} /></button>
        </div>
      )}

      {isLoading ? null : (
        <>
          {!quizzes.length ? (
            <Card className="p-6 mb-8">
              <Empty icon={ScanLine} message="No paper quizzes yet. Open a class and use its Paper Quizzes tab to make one or add the glycolysis and TCA examples." />
            </Card>
          ) : (
            <div className="space-y-6 mb-10">
              {byClass.map((g) => (
                <section key={g.id || 'none'}>
                  <div className="flex items-baseline justify-between gap-3 mb-2">
                    <h2 className="text-base font-semibold text-ink">{g.name}</h2>
                    {g.id
                      ? <Link to={`/professor/classes/${g.id}?tab=papers`} className="text-xs text-signal hover:underline">Open class</Link>
                      : <span className="text-xs text-muted">Open a quiz to move it into a class</span>}
                  </div>
                  <Card className="divide-y divide-hairline">
                    {g.quizzes.map((q) => (
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
                </section>
              ))}
            </div>
          )}

          <details className="group">
            <summary className="text-sm font-semibold text-ink cursor-pointer mb-1">Files</summary>
            <p className="text-xs text-muted mb-4 max-w-2xl">
              Each quiz is kept as three YAML files. You only need these to back up, share, or edit by hand and import again; a quiz’s Files tab has the same downloads.
            </p>
            <div className="flex flex-wrap gap-2 mb-6">
              <Button size="sm" onClick={() => fileInput.current?.click()}><FileUp size={13} />Import YAML</Button>
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
