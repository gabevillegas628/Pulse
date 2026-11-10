import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CircleAlert, Download, FileUp, Package, Printer, ScanLine, Trash2, X } from 'lucide-react'
import { api } from '@/api/client'
import ProfessorLayout from '@/components/layout/ProfessorLayout'
import Button from '@/components/ui/Button'
import Card from '@/components/ui/Card'
import Empty from '@/components/ui/Empty'
import Pill from '@/components/ui/Pill'
import ConfirmDialog, { type DialogRequest } from '@/components/ui/ConfirmDialog'
import { apiError, apiErrorCode } from '@/lib/errors'
import { KIND_LABEL, downloadPrintable, saveText, type QuizContentKind, type QuizContentSummary } from '@/lib/quizGrader'

/**
 * Paper quizzes: the answer keys, layouts and assessments the quiz grader works from,
 * each kept as a YAML file. Keys are edited here; layouts and assessments are imported
 * and exported for now (the layout editor is Phase 2 of docs/quiz-grader/PLAN.md).
 */

const ORDER: QuizContentKind[] = ['ASSESSMENT', 'KEY', 'LAYOUT']
const SECTION: Record<QuizContentKind, { title: string; blurb: string }> = {
  ASSESSMENT: { title: 'Assessments', blurb: 'Which blanks a quiz grades, for how many points, in each version.' },
  KEY: { title: 'Answer keys', blurb: 'Accepted enzyme names, cofactors and structure checks for a pathway. Reusable across quizzes.' },
  LAYOUT: { title: 'Layouts', blurb: 'Where each blank sits on a printed form.' },
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

  const starter = useMutation({
    mutationFn: () => api.post('/quiz-grader/starter').then((r) => r.data.data as { added: string[]; skipped: string[] }),
    onSuccess: (r) => {
      refresh()
      setNotice({ tone: 'good', text: r.added.length ? `Added ${r.added.length} starter files.` : 'You already have all the starter files.' })
    },
    onError: (e) => setNotice({ tone: 'warn', text: apiError(e, 'Could not load the starter content') }),
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
          <p className="text-sm text-muted mt-1">Answer keys and quiz setups for grading scanned, handwritten quizzes.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => starter.mutate()} disabled={starter.isPending}>
            <Package size={15} />
            Load glycolysis &amp; TCA starters
          </Button>
          <Button variant="primary" onClick={() => fileInput.current?.click()}>
            <FileUp size={15} />
            Import YAML
          </Button>
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
      </div>

      {notice && (
        <div className={`mb-4 text-sm rounded-sm px-4 py-2.5 flex items-center justify-between border ${notice.tone === 'good' ? 'bg-good-soft border-good/30 text-good' : 'bg-warn-soft border-warn/30 text-warn'}`}>
          <span>{notice.text}</span>
          <button onClick={() => setNotice(null)} className="hover:opacity-70" aria-label="Dismiss"><X size={14} /></button>
        </div>
      )}

      {isLoading ? null : !items?.length ? (
        <Card className="p-6">
          <Empty icon={ScanLine} message="Nothing here yet. Load the starters, or import a YAML file." />
        </Card>
      ) : (
        <div className="space-y-8">
          {ORDER.map((kind) => {
            const rows = items.filter((i) => i.kind === kind)
            if (!rows.length) return null
            return (
              <section key={kind}>
                <h2 className="text-base font-semibold text-ink">{SECTION[kind].title}</h2>
                <p className="text-xs text-muted mb-3">{SECTION[kind].blurb}</p>
                <Card className="divide-y divide-hairline">
                  {rows.map((item) => (
                    <div key={item.id} className="px-4 py-3 flex flex-wrap items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <Link to={`/professor/quiz-grader/${item.id}`} className="font-semibold text-ink hover:text-signal">
                          {item.title}
                        </Link>
                        <span className="ml-2 text-xs font-mono text-muted">{item.slug}</span>
                        <div className="text-xs text-muted mt-0.5">{KIND_LABEL[item.kind]} · updated {ago(item.updatedAt)}</div>
                        {item.issues.length > 0 && (
                          <p className="text-xs text-warn mt-1 flex gap-1"><CircleAlert size={13} className="shrink-0 mt-px" />{item.issues[0]}{item.issues.length > 1 ? ` (+${item.issues.length - 1} more)` : ''}</p>
                        )}
                        {item.warnings.map((w) => (
                          <p key={w} className="text-xs text-muted mt-1 flex gap-1"><AlertTriangle size={13} className="shrink-0 mt-px" />{w}</p>
                        ))}
                      </div>
                      {item.issues.length > 0 ? <Pill variant="warn">Has errors</Pill> : item.warnings.length > 0 ? <Pill variant="muted">Incomplete</Pill> : <Pill variant="good">Ready</Pill>}
                      <div className="flex gap-1.5">
                        {item.kind === 'ASSESSMENT' && (
                          <Button size="sm" title="Print-ready PDF: every version, with corner markers"
                            onClick={() => downloadPrintable(api, item.id, item.slug).catch((e) => setNotice({ tone: 'warn', text: apiError(e, 'Could not make the printable PDF') }))}>
                            <Printer size={13} />Print
                          </Button>
                        )}
                        <Button size="sm" onClick={() => void download(item)} title="Download YAML"><Download size={13} />YAML</Button>
                        <Button size="sm" onClick={() => remove(item)} title="Delete" aria-label={`Delete ${item.title}`}><Trash2 size={13} /></Button>
                      </div>
                    </div>
                  ))}
                </Card>
              </section>
            )
          })}
        </div>
      )}

      <ConfirmDialog request={dialog} onClose={() => setDialog(null)} />
    </ProfessorLayout>
  )
}
