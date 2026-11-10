import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ChevronLeft, ChevronRight, RotateCw, Trash2 } from 'lucide-react'
import { api } from '@/api/client'
import ProfessorLayout from '@/components/layout/ProfessorLayout'
import Button from '@/components/ui/Button'
import Card from '@/components/ui/Card'
import Pill from '@/components/ui/Pill'
import ConfirmDialog, { type DialogRequest } from '@/components/ui/ConfirmDialog'
import AuthImage from '@/components/quizGrader/AuthImage'
import { apiError } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { STATUS_LABEL, inFlight, type PageStatus, type QuizBatch, type QuizPage } from '@/lib/quizGrader'

/**
 * One upload of scans, page by page; and one page in detail, with the boxes drawn over
 * the lined-up scan so a misplaced box or a bad alignment is plain to see.
 */

const PILL: Record<PageStatus, 'good' | 'warn' | 'live' | 'muted'> = {
  DONE: 'good', NEEDS_VERSION: 'warn', FAILED: 'warn', PROCESSING: 'live', PENDING: 'muted',
}

const METHOD_LABEL: Record<string, string> = {
  markers: 'corner markers',
  lines: 'printed lines',
  'paper edges': 'paper edges',
}

function pct(n: number | null | undefined) {
  return n == null ? '—' : `${Math.round(n * 100)}%`
}

type BatchDetail = QuizBatch & { pages: QuizPage[] }

export function QuizBatchPage() {
  const { batchId } = useParams<{ batchId: string }>()
  const navigate = useNavigate()
  const [dialog, setDialog] = useState<DialogRequest | null>(null)
  const { data: batch, error } = useQuery<BatchDetail>({
    queryKey: ['quiz-grader', 'batch', batchId],
    queryFn: () => api.get(`/quiz-grader/batches/${batchId}`).then((r) => r.data.data),
    refetchInterval: (q) => (q.state.data && inFlight(q.state.data.counts) > 0 ? 2000 : false),
  })

  function remove() {
    setDialog({
      title: `Delete ${batch?.fileName}?`,
      body: 'Its page images and crops are deleted too. Upload the file again to get them back.',
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: async () => {
        await api.delete(`/quiz-grader/batches/${batchId}`)
        navigate(`/professor/quiz-grader/${batch?.assessmentId}`)
      },
    })
  }

  return (
    <ProfessorLayout>
      {error ? <p className="text-sm text-warn">{apiError(error, 'Could not open this upload')}</p> : !batch ? null : (
        <>
          <Link to={`/professor/quiz-grader/${batch.assessmentId}`} className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink mb-4">
            <ArrowLeft size={14} /> Assessment
          </Link>
          <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
            <div>
              <p className="text-xs font-bold uppercase tracking-widest text-muted">Scans</p>
              <h1 className="text-2xl font-bold text-ink">{batch.fileName}</h1>
              <p className="text-sm text-muted">
                {batch.pageCount} page{batch.pageCount === 1 ? '' : 's'}
                {(Object.keys(STATUS_LABEL) as PageStatus[]).filter((s) => batch.counts[s]).map((s) => ` · ${batch.counts[s]} ${STATUS_LABEL[s].toLowerCase()}`).join('')}
              </p>
            </div>
            <Button size="sm" onClick={remove}><Trash2 size={13} />Delete upload</Button>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {batch.pages.map((pg) => (
              <Link key={pg.id} to={`/professor/quiz-grader/pages/${pg.id}`} className="block">
                <Card className="overflow-hidden hover:ring-2 hover:ring-signal">
                  <AuthImage
                    src={`/quiz-grader/pages/${pg.id}/${pg.status === 'DONE' || pg.status === 'NEEDS_VERSION' ? 'aligned' : 'original'}`}
                    alt={`Page ${pg.index + 1}`}
                    className="aspect-[17/22] overflow-hidden"
                  />
                  <div className="p-2 space-y-1">
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-sm font-semibold text-ink">Page {pg.index + 1}</span>
                      <Pill variant={PILL[pg.status]} dot={pg.status === 'PROCESSING'}>{STATUS_LABEL[pg.status]}</Pill>
                    </div>
                    {pg.status === 'DONE' && (
                      <p className="text-xs text-muted">
                        Version {pg.version} · {METHOD_LABEL[pg.method ?? ''] ?? pg.method} · lines {pct(pg.match)}
                      </p>
                    )}
                    {pg.status === 'FAILED' && <p className="text-xs text-warn line-clamp-2">{pg.error}</p>}
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        </>
      )}
      <ConfirmDialog request={dialog} onClose={() => setDialog(null)} />
    </ProfessorLayout>
  )
}

type PageDetail = QuizPage & { versions: string[]; boxes: { id: string; box: [number, number, number, number] }[] }

export function QuizPageDebug() {
  const { pageId } = useParams<{ pageId: string }>()
  const qc = useQueryClient()
  const [view, setView] = useState<'aligned' | 'original'>('aligned')
  const [message, setMessage] = useState('')
  const { data: page, error } = useQuery<PageDetail>({
    queryKey: ['quiz-grader', 'page', pageId],
    queryFn: () => api.get(`/quiz-grader/pages/${pageId}`).then((r) => r.data.data),
    refetchInterval: (q) => (q.state.data && ['PENDING', 'PROCESSING'].includes(q.state.data.status) ? 1500 : false),
  })
  const { data: batch } = useQuery<BatchDetail>({
    queryKey: ['quiz-grader', 'batch', page?.batchId],
    queryFn: () => api.get(`/quiz-grader/batches/${page!.batchId}`).then((r) => r.data.data),
    enabled: !!page,
  })

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['quiz-grader', 'page', pageId] })
    void qc.invalidateQueries({ queryKey: ['quiz-grader', 'batch'] })
  }
  async function setVersion(version: string) {
    setMessage('')
    try { await api.post(`/quiz-grader/pages/${pageId}/version`, { version }); refresh() } catch (e) { setMessage(apiError(e, 'Could not set the version')) }
  }
  async function retry() {
    setMessage('')
    try { await api.post(`/quiz-grader/pages/${pageId}/retry`); refresh() } catch (e) { setMessage(apiError(e, 'Could not retry')) }
  }

  const siblings = batch?.pages ?? []
  const at = siblings.findIndex((p) => p.id === pageId)
  const prev = at > 0 ? siblings[at - 1] : undefined
  const next = at >= 0 && at < siblings.length - 1 ? siblings[at + 1] : undefined
  const blank = new Set((page?.slots ?? []).filter((s) => s.blank).map((s) => s.id))
  const processed = page?.status === 'DONE' || page?.status === 'NEEDS_VERSION'
  const showBoxes = view === 'aligned' && page?.status === 'DONE'

  return (
    <ProfessorLayout>
      {error ? <p className="text-sm text-warn">{apiError(error, 'Could not open this page')}</p> : !page ? null : (
        <>
          <div className="flex items-center justify-between mb-4">
            <Link to={`/professor/quiz-grader/batches/${page.batchId}`} className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
              <ArrowLeft size={14} /> {batch?.fileName ?? 'Upload'}
            </Link>
            <div className="flex gap-1">
              {prev && <Link to={`/professor/quiz-grader/pages/${prev.id}`} className="p-1.5 text-muted hover:text-ink" aria-label="Previous page"><ChevronLeft size={18} /></Link>}
              {next && <Link to={`/professor/quiz-grader/pages/${next.id}`} className="p-1.5 text-muted hover:text-ink" aria-label="Next page"><ChevronRight size={18} /></Link>}
            </div>
          </div>

          <div className="grid lg:grid-cols-[minmax(0,1fr)_320px] gap-5 items-start">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <h1 className="text-xl font-bold text-ink mr-2">Page {page.index + 1}</h1>
                {(['aligned', 'original'] as const).map((v) => (
                  <button key={v} onClick={() => setView(v)} disabled={v === 'aligned' && !processed}
                    className={cn('px-2.5 py-1 text-xs rounded-sm border disabled:opacity-40', view === v ? 'border-signal text-ink font-semibold' : 'border-hairline text-muted')}>
                    {v === 'aligned' ? 'Lined up, with boxes' : 'As uploaded'}
                  </button>
                ))}
              </div>
              <Card flat className="overflow-hidden">
                <div className="relative">
                  <AuthImage key={`${view}-${page.status}-${page.version}`} eager src={`/quiz-grader/pages/${page.id}/${processed ? view : 'original'}`} alt={`Page ${page.index + 1}`} />
                  {showBoxes && page.boxes.map((b) => (
                    <div key={b.id} title={b.id} className="absolute pointer-events-none"
                      style={{
                        left: `${b.box[0] * 100}%`, top: `${b.box[1] * 100}%`, width: `${b.box[2] * 100}%`, height: `${b.box[3] * 100}%`,
                        border: `2px solid ${blank.has(b.id) ? '#9ca3af' : '#2563eb'}`,
                      }}>
                      <span className="absolute left-0 top-0 text-[10px] leading-none px-1 py-0.5 text-white" style={{ background: blank.has(b.id) ? '#9ca3af' : '#2563eb' }}>{b.id}</span>
                    </div>
                  ))}
                </div>
              </Card>
              {showBoxes && <p className="text-xs text-muted mt-2">Every box should sit on its blank. Grey boxes look empty. If boxes are off for every page, fix the layout; if just this page, its scan is the problem.</p>}
            </div>

            <div className="space-y-4 lg:sticky lg:top-4">
              <Card className="p-4 space-y-2 text-sm">
                <div className="flex items-center justify-between"><span className="text-muted">Status</span><Pill variant={PILL[page.status]} dot={page.status === 'PROCESSING'}>{STATUS_LABEL[page.status]}</Pill></div>
                {processed && (
                  <>
                    <div className="flex justify-between"><span className="text-muted">Lined up by</span><span className="text-ink">{METHOD_LABEL[page.method ?? ''] ?? page.method}{page.method === 'markers' ? ` (${page.markers} of 4)` : ''}</span></div>
                    <div className="flex justify-between"><span className="text-muted">Form lines matched</span><span className={cn((page.match ?? 0) < 0.85 ? 'text-warn' : 'text-ink')}>{pct(page.match)}</span></div>
                    <div className="flex justify-between"><span className="text-muted">Version</span><span className="text-ink">{page.version ?? '—'}{page.versionForced ? ' (set by you)' : ''}</span></div>
                    {page.fits && Object.keys(page.fits).length > 1 && (
                      <p className="text-xs text-muted">Fit: {Object.entries(page.fits).map(([v, f]) => `${v} ${pct(f)}`).join(' · ')}</p>
                    )}
                  </>
                )}
                {page.error && <p className="text-xs text-warn">{page.error}</p>}
                {message && <p className="text-xs text-warn">{message}</p>}
              </Card>

              {page.versions.length > 1 && processed && (
                <Card className="p-4">
                  <p className="text-sm font-semibold text-ink mb-1">{page.status === 'NEEDS_VERSION' ? 'Which version is this?' : 'Wrong version?'}</p>
                  <p className="text-xs text-muted mb-2">{page.status === 'NEEDS_VERSION' ? 'It could not be told from the printed form. Pick it and the page is processed again.' : 'Pick the right one and the page is processed again.'}</p>
                  <div className="flex flex-wrap gap-2">
                    {page.versions.map((v) => (
                      <Button key={v} size="sm" variant={v === page.version ? 'primary' : 'ghost'} disabled={v === page.version} onClick={() => void setVersion(v)}>Version {v}</Button>
                    ))}
                  </div>
                </Card>
              )}

              {(page.status === 'FAILED' || page.status === 'DONE' || page.status === 'NEEDS_VERSION') && (
                <Button size="sm" onClick={() => void retry()}><RotateCw size={13} />Process again</Button>
              )}
            </div>
          </div>

          {page.status === 'DONE' && page.slots && (
            <section className="mt-8">
              <h2 className="text-lg font-semibold text-ink mb-1">Boxes</h2>
              <p className="text-xs text-muted mb-3">What each answer box cut out. Empty ones are skipped when grading.</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                {page.slots.map((s) => (
                  <Card key={s.id} className="overflow-hidden">
                    <AuthImage src={`/quiz-grader/pages/${page.id}/crops/${s.id}`} alt={s.id} />
                    <div className="px-2 py-1.5 flex items-center justify-between text-xs">
                      <span className="font-mono text-ink">{s.id}</span>
                      {s.blank ? <span className="text-muted">empty</span> : <span className="text-ink-2">{s.ink} px ink</span>}
                    </div>
                  </Card>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </ProfessorLayout>
  )
}
