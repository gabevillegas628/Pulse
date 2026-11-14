import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ArrowLeft, ChevronLeft, ChevronRight, FileSpreadsheet, RotateCw, Trash2 } from 'lucide-react'
import { api } from '@/api/client'
import ProfessorLayout from '@/components/layout/ProfessorLayout'
import Button from '@/components/ui/Button'
import Card from '@/components/ui/Card'
import Pill from '@/components/ui/Pill'
import ConfirmDialog, { type DialogRequest } from '@/components/ui/ConfirmDialog'
import AuthImage from '@/components/quizGrader/AuthImage'
import StudentPicker, { type Student } from '@/components/quizGrader/StudentPicker'
import { apiError } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { STATUS_LABEL, describeRead, inFlight, type PageStatus, type QuizBatch, type QuizPage, type SlotResult } from '@/lib/quizGrader'

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
    refetchInterval: (q) => (q.state.data && (inFlight(q.state.data.counts) > 0
      || q.state.data.pages.some((pg) => pg.gradeStatus === 'PENDING' || pg.gradeStatus === 'GRADING')) ? 2000 : false),
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
            <ArrowLeft size={14} /> Quiz
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
                  {pg.status === 'PENDING' || pg.status === 'PROCESSING' ? (
                    // Nothing to show until the page has been fetched and lined up.
                    <div className="aspect-[17/22] bg-surface-2" />
                  ) : (
                    <AuthImage
                      src={`/quiz-grader/pages/${pg.id}/${pg.status === 'FAILED' ? 'original' : 'aligned'}`}
                      alt={`Page ${pg.index + 1}`}
                      className="aspect-[17/22] overflow-hidden"
                    />
                  )}
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
                    {pg.gradeStatus === 'GRADED' && (
                      <p className="text-xs text-ink">
                        <span className="font-semibold">{pg.pointsFinal ?? pg.pointsAuto}/{pg.maxPoints}</span>
                        {pg.toReview ? <span className="text-warn"> · {pg.toReview} to review</span> : null}
                      </p>
                    )}
                    {(pg.gradeStatus === 'PENDING' || pg.gradeStatus === 'GRADING') && <p className="text-xs text-muted">Grading…</p>}
                    {pg.gradeStatus === 'FAILED' && <p className="text-xs text-warn">Grading failed</p>}
                    {pg.status === 'FAILED' && <p className="text-xs text-warn line-clamp-2">{pg.error}</p>}
                  </div>
                </Card>
              </Link>
            ))}
          </div>
          <CompareWithHandGrades batchId={batch.id} />
        </>
      )}
      <ConfirmDialog request={dialog} onClose={() => setDialog(null)} />
    </ProfessorLayout>
  )
}

type PageDetail = QuizPage & { studentNetId?: string | null; versions: string[]; boxes: { id: string; box: [number, number, number, number] }[]; results: SlotResult[]; cost: number }

export function QuizPageDebug() {
  const { pageId } = useParams<{ pageId: string }>()
  const qc = useQueryClient()
  const [view, setView] = useState<'aligned' | 'original'>('aligned')
  const [message, setMessage] = useState('')
  const [onlyLost, setOnlyLost] = useState(false)
  const { data: page, error } = useQuery<PageDetail>({
    queryKey: ['quiz-grader', 'page', pageId],
    queryFn: () => api.get(`/quiz-grader/pages/${pageId}`).then((r) => r.data.data),
    refetchInterval: (q) => (q.state.data && (['PENDING', 'PROCESSING'].includes(q.state.data.status)
      || ['PENDING', 'GRADING'].includes(q.state.data.gradeStatus)) ? 1500 : false),
  })
  const { data: batch } = useQuery<BatchDetail>({
    queryKey: ['quiz-grader', 'batch', page?.batchId],
    queryFn: () => api.get(`/quiz-grader/batches/${page!.batchId}`).then((r) => r.data.data),
    enabled: !!page,
  })

  // Boxes scored below full marks (after review decisions), in layout order.
  const lost = (page?.slots ?? []).map((sl) => page?.results.find((x) => x.slotId === sl.id))
    .filter((r): r is NonNullable<typeof r> => !!r && r.maxPoints > 0 && r.points < r.maxPoints)

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['quiz-grader', 'page', pageId] })
    void qc.invalidateQueries({ queryKey: ['quiz-grader', 'batch'] })
  }
  async function setVersion(version: string) {
    setMessage('')
    try { await api.post(`/quiz-grader/pages/${pageId}/version`, { version }); refresh() } catch (e) { setMessage(apiError(e, 'Could not set the version')) }
  }
  async function regrade() {
    setMessage('')
    try { await api.post(`/quiz-grader/pages/${pageId}/regrade`); refresh() } catch (e) { setMessage(apiError(e, 'Could not grade again')) }
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
              {batch && <PageStudent pageId={page.id} assessmentId={batch.assessmentId} netId={page.studentNetId ?? null} onChanged={refresh} />}
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

              {page.status === 'DONE' && page.gradeStatus !== 'NONE' && (
                <Card className="p-4 space-y-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-muted">Grading</span>
                    {page.gradeStatus === 'GRADED' ? <span className="text-ink font-semibold">{page.pointsFinal ?? page.pointsAuto} / {page.maxPoints}</span>
                      : page.gradeStatus === 'FAILED' ? <Pill variant="warn">Failed</Pill> : <Pill variant="live" dot>Grading</Pill>}
                  </div>
                  {page.gradeStatus === 'GRADED' && (
                    <>
                      <div className="flex justify-between"><span className="text-muted">To review</span><span className={cn(page.toReview ? 'text-warn' : 'text-ink')}>{page.toReview ?? 0}</span></div>
                      <div className="flex justify-between"><span className="text-muted">Model cost</span><span className="text-ink">${page.cost.toFixed(3)}</span></div>
                    </>
                  )}
                  {page.gradeError && <p className="text-xs text-warn">{page.gradeError}</p>}
                  {(page.gradeStatus === 'FAILED' || page.gradeStatus === 'GRADED') && (
                    <Button size="sm" onClick={() => void regrade()}><RotateCw size={13} />Grade again</Button>
                  )}
                </Card>
              )}

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
              <div className="flex flex-wrap items-end justify-between gap-3 mb-3">
                <div>
                  <h2 className="text-lg font-semibold text-ink mb-1">Boxes</h2>
                  <p className="text-xs text-muted">What each answer box cut out, what the model read, and the points. Empty boxes and names are never sent to the model.</p>
                </div>
                {lost.length > 0 && (
                  <label className="text-sm text-ink-2 flex items-center gap-2">
                    <input type="checkbox" checked={onlyLost} onChange={(e) => setOnlyLost(e.target.checked)} /> Only boxes that lost points
                  </label>
                )}
              </div>
              {page.gradeStatus === 'GRADED' && (
                <Card flat className="p-3 mb-4 text-sm">
                  {lost.length === 0 ? <p className="text-good font-semibold">Full marks on every box.</p> : (
                    <>
                      <p className="text-ink mb-2"><span className="font-semibold">Lost points on {lost.length} box{lost.length === 1 ? '' : 'es'}</span> <span className="text-muted">(click one to jump to it)</span></p>
                      <div className="flex flex-wrap gap-1.5">
                        {lost.map((r) => (
                          <button key={r.slotId} onClick={() => document.getElementById(`box-${r.slotId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
                            className={cn('font-mono text-xs px-2 py-0.5 rounded-sm border', r.points === 0 ? 'border-signal text-signal bg-signal-soft' : 'border-warn text-warn bg-warn-soft')}>
                            {r.slotId} {r.points}/{r.maxPoints}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </Card>
              )}
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                {page.slots.map((s) => {
                  const r = page.results.find((x) => x.slotId === s.id)
                  const short = !!r && r.points < r.maxPoints
                  if (onlyLost && !short) return null
                  const tone = !r || r.maxPoints === 0 ? null : r.points === 0 ? 'zero' : short ? 'part' : 'full'
                  return (
                    <Card key={s.id} id={`box-${s.id}`} className={cn('overflow-hidden scroll-mt-4',
                      tone === 'zero' ? 'ring-2 ring-signal' : tone === 'part' ? 'ring-2 ring-warn' : r?.needsReview && 'ring-1 ring-warn/50')}>
                      <AuthImage src={`/quiz-grader/pages/${page.id}/crops/${s.id}`} alt={s.id} />
                      <div className={cn('px-2 py-1.5 text-xs space-y-0.5', tone === 'zero' ? 'bg-signal-soft' : tone === 'part' && 'bg-warn-soft')}>
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-ink">{s.id}</span>
                          {r ? (
                            <span className={cn('font-semibold px-1.5 rounded-sm',
                              tone === 'zero' ? 'bg-signal text-white' : tone === 'part' ? 'bg-warn text-white' : tone === 'full' ? 'text-good' : 'text-ink')}>
                              {tone === 'full' && '✓ '}{r.points}/{r.maxPoints}
                            </span>
                          ) : s.blank ? <span className="text-muted">empty</span> : <span className="text-muted">{['name', 'netid'].includes(s.id) ? 'not sent' : ''}</span>}
                        </div>
                        {r && <p className="text-ink-2 break-words">{describeRead(r)}</p>}
                        {r?.detail.secondLook && (
                          <p className={cn('break-words', r.detail.secondLook.agrees ? 'text-muted' : 'text-warn')}>
                            second look: {r.detail.secondLook.status === 'read' ? `“${r.detail.secondLook.transcription}”` : r.detail.secondLook.status}
                            {r.detail.secondLook.agrees ? ' (agrees)' : ''}
                          </p>
                        )}
                        {r?.detail.match && r.detail.match.verdict !== 'exact' && (
                          <p className="text-muted">closest: {r.detail.match.alias}</p>
                        )}
                        {r?.kind === 'structure' && r.detail.features && (
                          <ul className="text-muted">
                            {r.detail.features.map((f) => <li key={f.feature}>{f.present ? '✓' : '✗'} {f.feature}</li>)}
                          </ul>
                        )}
                        {r?.open && (
                          <p className="text-warn flex gap-1"><AlertTriangle size={12} className="shrink-0 mt-px" />{r.reviewReasons.join('; ')}</p>
                        )}
                        {r && <BoxDecision pageId={page.id} r={r} onDone={refresh} />}
                      </div>
                    </Card>
                  )
                })}
              </div>
            </section>
          )}
        </>
      )}
    </ProfessorLayout>
  )
}

interface Comparison {
  byKind: { kind: string; compared: number; agree: number; flagged: number; unflaggedAgree: number; unflagged: number; afterReview: number }[]
  disagreements: { page: number; slotId: string; read: string; auto: number; hand: number; flagged: string | null }[]
  unmatchedPages: string[]
}

/** The Phase 0 check, on pages graded in Pulse: upload a hand-grades CSV, see agreement. */
function CompareWithHandGrades({ batchId }: { batchId: string }) {
  const [result, setResult] = useState<Comparison | null>(null)
  const [error, setError] = useState('')
  const share = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : '—')

  async function run(file: File) {
    setError('')
    try {
      const r = await api.post(`/quiz-grader/batches/${batchId}/compare`, { csv: await file.text() })
      setResult(r.data.data)
    } catch (e) {
      setError(apiError(e, 'Could not compare'))
    }
  }

  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-3">
        <div>
          <h2 className="text-lg font-semibold text-ink">Compare with hand grades</h2>
          <p className="text-xs text-muted">A CSV with a <span className="font-mono">page</span> column (1, 2, … or names ending in the number) and one column per box, points in each cell. The spike&rsquo;s hand-grades file works as is.</p>
        </div>
        <label className="inline-flex">
          <span className="inline-flex items-center gap-1.5 rounded-sm px-2.5 py-1.5 text-xs font-medium bg-surface border border-hairline-strong text-ink-2 hover:bg-surface-2 cursor-pointer">
            <FileSpreadsheet size={13} />Choose CSV
          </span>
          <input type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void run(f) }} />
        </label>
      </div>
      {error && <p className="text-sm text-warn mb-3">{error}</p>}
      {result && (
        <Card className="p-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted text-left">
              <tr><th className="py-1 pr-4">Box kind</th><th className="pr-4">Compared</th><th className="pr-4">Agree</th><th className="pr-4">Flagged</th><th className="pr-4">Unflagged agree</th><th>After review</th></tr>
            </thead>
            <tbody>
              {result.byKind.map((k) => (
                <tr key={k.kind} className="border-t border-hairline">
                  <td className="py-1.5 pr-4 text-ink">{k.kind}</td><td className="pr-4">{k.compared}</td><td className="pr-4">{share(k.agree, k.compared)}</td>
                  <td className="pr-4">{share(k.flagged, k.compared)}</td><td className="pr-4">{share(k.unflaggedAgree, k.unflagged)}</td><td>{share(k.afterReview, k.compared)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs text-muted mt-2">&ldquo;Unflagged agree&rdquo; is the one to watch: those are scores nobody would look at. &ldquo;After review&rdquo; counts a flagged box as fixed.</p>
          {result.unmatchedPages.length > 0 && <p className="text-xs text-warn mt-2">Not matched to a graded page: {result.unmatchedPages.join(', ')}</p>}
          {result.disagreements.length > 0 && (
            <table className="w-full text-xs mt-4">
              <thead className="text-muted text-left"><tr><th className="py-1 pr-3">Page</th><th className="pr-3">Box</th><th className="pr-3">Read</th><th className="pr-3">Auto</th><th className="pr-3">Hand</th><th>Flagged</th></tr></thead>
              <tbody>
                {result.disagreements.map((d) => (
                  <tr key={`${d.page}-${d.slotId}`} className="border-t border-hairline">
                    <td className="py-1 pr-3">{d.page}</td><td className="pr-3 font-mono">{d.slotId}</td><td className="pr-3">{d.read}</td>
                    <td className="pr-3">{d.auto}</td><td className="pr-3">{d.hand}</td><td className={d.flagged ? 'text-muted' : 'text-warn font-semibold'}>{d.flagged ?? 'no'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
    </section>
  )
}

/** Decide one box of one paper from the page view: a regrade, or an exception to its group. */
function BoxDecision({ pageId, r, onDone }: { pageId: string; r: SlotResult; onDone: () => void }) {
  const [error, setError] = useState('')
  const set = async (points: number | null) => {
    setError('')
    try { await api.post(`/quiz-grader/pages/${pageId}/boxes/${r.slotId}`, { points }); onDone() } catch (e) { setError(apiError(e, 'Could not save')) }
  }
  const label = r.source === 'paper' ? 'set for this paper' : r.source === 'group' ? 'decided for its group' : r.pointsAuto !== r.points ? '' : 'automatic'
  return (
    <div className="pt-1 flex flex-wrap items-center gap-1">
      <span className="text-muted mr-1">{label}</span>
      {[...new Set([0, r.maxPoints])].filter((v) => v !== r.points || r.source !== 'paper').map((v) => (
        <button key={v} onClick={() => void set(v)} className="px-1.5 py-0.5 rounded-sm border border-hairline hover:bg-surface-2">{v}</button>
      ))}
      {r.source === 'paper' && <button onClick={() => void set(null)} className="px-1.5 py-0.5 rounded-sm border border-hairline hover:bg-surface-2">undo</button>}
      {error && <span className="text-warn">{error}</span>}
    </div>
  )
}

/**
 * Whose paper this is, set from the page itself: for papers whose name or NetID is not in its
 * box, so the whole page has to be read to tell. Same picker and roster as the matching screen.
 */
function PageStudent({ pageId, assessmentId, netId, onChanged }: { pageId: string; assessmentId: string; netId: string | null; onChanged: () => void }) {
  const qc = useQueryClient()
  const [error, setError] = useState('')
  const { data } = useQuery<{ classId: string | null; roster: Student[]; pages: { id: string; netId: string | null }[] }>({
    queryKey: ['quiz-grader', 'match', assessmentId],
    queryFn: () => api.get(`/quiz-grader/content/${assessmentId}/match`).then((r) => r.data.data),
  })
  async function match(n: string | null) {
    setError('')
    try {
      await api.put(`/quiz-grader/pages/${pageId}/student`, { netId: n })
      // The results list, the matching screen and the gradebook all show whose paper it is.
      void qc.invalidateQueries({ queryKey: ['quiz-grader'] })
      onChanged()
    } catch (e) { setError(apiError(e, 'Could not save the student')) }
  }
  const roster = data?.roster ?? []
  const lower = netId?.toLowerCase()
  const duplicate = !!lower && (data?.pages ?? []).some((p) => p.id !== pageId && p.netId?.toLowerCase() === lower)
  const offRoster = !!lower && !!data?.classId && !roster.some((s) => s.netId.toLowerCase() === lower)
  return (
    <Card className="p-4 text-sm">
      <p className="text-muted mb-1.5">Student</p>
      {!data ? null : (
        <StudentPicker key={pageId} netId={netId} roster={roster} onMatch={(n) => void match(n)}
          placeholder={data.classId ? 'Type a NetID…' : 'Type the NetID, then Enter'} />
      )}
      {(duplicate || offRoster) && (
        <p className="text-xs text-warn mt-1.5 flex gap-1">
          <AlertTriangle size={12} className="shrink-0 mt-0.5" />
          {duplicate ? 'Another paper of this quiz has this NetID.' : 'Not on the class roster.'}
        </p>
      )}
      {error && <p className="text-xs text-warn mt-1.5">{error}</p>}
      <Link to={`/professor/quiz-grader/${assessmentId}/match`} className="text-xs text-signal hover:underline inline-block mt-2">All papers and students</Link>
    </Card>
  )
}
