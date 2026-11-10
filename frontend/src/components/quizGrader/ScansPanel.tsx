import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Camera, FileUp, ScanLine } from 'lucide-react'
import { api } from '@/api/client'
import Button from '@/components/ui/Button'
import Card from '@/components/ui/Card'
import Empty from '@/components/ui/Empty'
import Pill from '@/components/ui/Pill'
import { apiError } from '@/lib/errors'
import { inFlight, type QuizBatch } from '@/lib/quizGrader'

/**
 * An assessment's scans: upload copier PDFs or photos, and watch them get lined up.
 * Polls while anything is still being processed.
 */
export default function ScansPanel({ assessmentId }: { assessmentId: string }) {
  const qc = useQueryClient()
  const pdfInput = useRef<HTMLInputElement>(null)
  const photoInput = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState<string | null>(null)
  const [error, setError] = useState('')

  const { data: vision } = useQuery<{ configured: boolean; healthy: boolean }>({
    queryKey: ['quiz-grader', 'vision'],
    queryFn: () => api.get('/quiz-grader/vision').then((r) => r.data.data),
  })
  const { data: batches } = useQuery<QuizBatch[]>({
    queryKey: ['quiz-grader', 'batches', assessmentId],
    queryFn: () => api.get(`/quiz-grader/content/${assessmentId}/batches`).then((r) => r.data.data.batches),
    refetchInterval: (q) => ((q.state.data ?? []).some((b) => inFlight(b.counts) > 0) ? 2000 : false),
  })

  async function upload(files: File[]) {
    setError('')
    for (const f of files) {
      setUploading(f.name)
      try {
        const form = new FormData()
        form.append('file', f)
        await api.post(`/quiz-grader/content/${assessmentId}/batches`, form)
      } catch (e) {
        setError(`${f.name}: ${apiError(e, 'upload failed')}`)
      }
    }
    setUploading(null)
    void qc.invalidateQueries({ queryKey: ['quiz-grader', 'batches', assessmentId] })
  }

  const ready = vision?.configured && vision.healthy
  return (
    <section className="mb-8">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-3">
        <div>
          <h2 className="text-lg font-semibold text-ink">Scans</h2>
          <p className="text-xs text-muted">Upload a copier PDF (one quiz per page) or photos. Each page is lined up with the blank form, its version found, and every answer box cut out.</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" disabled={!ready || !!uploading} onClick={() => photoInput.current?.click()}><Camera size={13} />Photos</Button>
          <Button size="sm" variant="primary" disabled={!ready || !!uploading} onClick={() => pdfInput.current?.click()}><FileUp size={13} />Upload PDF</Button>
          <input ref={pdfInput} type="file" accept="application/pdf,.pdf" multiple className="hidden"
            onChange={(e) => { const f = Array.from(e.target.files ?? []); e.target.value = ''; void upload(f) }} />
          <input ref={photoInput} type="file" accept="image/*" multiple className="hidden"
            onChange={(e) => { const f = Array.from(e.target.files ?? []); e.target.value = ''; void upload(f) }} />
        </div>
      </div>

      {vision && !vision.configured && (
        <p className="text-sm text-muted mb-3">Scanning is not set up on this server yet: the vision service needs deploying (vision/README.md).</p>
      )}
      {vision?.configured && !vision.healthy && (
        <p className="text-sm text-warn mb-3">The vision service is not answering right now, so new uploads cannot be processed.</p>
      )}
      {uploading && <p className="text-sm text-muted mb-3">Uploading {uploading}…</p>}
      {error && <p className="text-sm text-warn mb-3">{error}</p>}

      {!batches?.length ? (
        <Card flat className="p-4"><Empty icon={ScanLine} message="No scans yet." className="py-6" /></Card>
      ) : (
        <Card className="divide-y divide-hairline">
          {batches.map((b) => {
            const done = (b.counts.DONE ?? 0)
            const pct = b.pageCount ? Math.round((100 * (b.pageCount - inFlight(b.counts))) / b.pageCount) : 100
            return (
              <Link key={b.id} to={`/professor/quiz-grader/batches/${b.id}`} className="block px-4 py-3 hover:bg-surface-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-ink truncate">{b.fileName}</span>
                  <span className="text-xs text-muted">{b.pageCount} page{b.pageCount === 1 ? '' : 's'} · {new Date(b.createdAt).toLocaleString()}</span>
                  <span className="flex-1" />
                  {done > 0 && <Pill variant="good">{done} ready</Pill>}
                  {(b.counts.NEEDS_VERSION ?? 0) > 0 && <Pill variant="warn">{b.counts.NEEDS_VERSION} need a version</Pill>}
                  {(b.counts.FAILED ?? 0) > 0 && <Pill variant="warn">{b.counts.FAILED} failed</Pill>}
                  {inFlight(b.counts) > 0 && <Pill variant="live" dot>{inFlight(b.counts)} processing</Pill>}
                </div>
                {inFlight(b.counts) > 0 && (
                  <div className="mt-2 h-1.5 rounded-full bg-surface-2 overflow-hidden">
                    <div className="h-full bg-signal transition-all" style={{ width: `${pct}%` }} />
                  </div>
                )}
              </Link>
            )
          })}
        </Card>
      )}
    </section>
  )
}
