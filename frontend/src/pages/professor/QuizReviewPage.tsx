import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Check, CheckCheck, RotateCcw, X } from 'lucide-react'
import { api } from '@/api/client'
import ProfessorLayout from '@/components/layout/ProfessorLayout'
import Button from '@/components/ui/Button'
import Card from '@/components/ui/Card'
import Pill from '@/components/ui/Pill'
import AuthImage from '@/components/quizGrader/AuthImage'
import { apiError } from '@/lib/errors'
import { cn } from '@/lib/utils'

/**
 * Review by item: one box at a time, every paper's answer grouped by what was written, so
 * one decision covers everyone who wrote the same thing (and anyone who writes it later).
 * Structures are judged one drawing at a time against the key's feature checks.
 */

interface SlotSummary { slotId: string; label: string; kind: string; papers: number; open: number; groups: number }
interface Member {
  pageId: string; batchId: string; index: number; version: string | null
  status: string; blankBy: string | null; transcription: string | null
  detail: { match: { verdict: string; alias: string } | null; cofactors: { text: string; side: string }[] | null; features: { feature: string; present: boolean }[] | null; description: string | null }
  pointsAuto: number; maxPoints: number; points: number; source: 'paper' | 'group' | 'auto'
  open: boolean; needsReview: boolean; reviewReasons: string[]
  override: { points: number; features: boolean[] | null; note: string | null } | null
}
interface Group { groupKey: string | null; key: string; count: number; open: number; sample: string; status: string; decision: { points: number } | null; members: Member[] }
interface Item { slotId: string; label: string; kind: string; maxPoints: number; accept: string[] | null; features: string[] | null; groups: Group[] }
interface LogEntry { id: string; scope: string; slotId: string; groupKey: string | null; page: number | null; fromPoints: number | null; toPoints: number | null; papers: number | null; detail: { alias?: string; note?: string } | null; who: string; createdAt: string }

function readingOf(g: Group | Member, kind: string): string {
  const m = 'members' in g ? g.members[0]! : g
  if (m.status === 'blank') return m.blankBy === 'ink' ? 'Left empty' : 'Read as empty'
  if (m.status !== 'read') return m.status === 'illegible' ? 'Illegible' : 'No reading'
  if (kind === 'cofactors') return (m.detail.cofactors ?? []).map((c) => `${c.text} ${c.side === 'in' ? '→ in' : c.side === 'out' ? '→ out' : '(side?)'}`).join(', ') || 'nothing'
  return `“${'members' in g ? g.sample : m.transcription}”`
}

export default function QuizReviewPage() {
  const { id } = useParams<{ id: string }>()
  const qc = useQueryClient()
  const [selected, setSelected] = useState<string | null>(null)
  const [onlyOpen, setOnlyOpen] = useState(true)
  const [error, setError] = useState('')

  const { data: summary } = useQuery<{ slots: SlotSummary[]; open: number; boxes: number }>({
    queryKey: ['quiz-grader', 'review', id],
    queryFn: () => api.get(`/quiz-grader/content/${id}/review`).then((r) => r.data.data),
    staleTime: 0,
  })
  const { data: item } = useQuery<Item>({
    queryKey: ['quiz-grader', 'review', id, selected],
    queryFn: () => api.get(`/quiz-grader/content/${id}/review/${selected}`).then((r) => r.data.data),
    staleTime: 0,
    enabled: !!selected,
  })
  const { data: log } = useQuery<{ entries: LogEntry[] }>({
    queryKey: ['quiz-grader', 'review-log', id],
    queryFn: () => api.get(`/quiz-grader/content/${id}/log?limit=30`).then((r) => r.data.data),
  })

  // Start on the first box with something to review.
  useEffect(() => {
    if (!selected && summary?.slots.length) setSelected((summary.slots.find((s) => s.open > 0) ?? summary.slots[0]!).slotId)
  }, [summary, selected])

  const refresh = () => void qc.invalidateQueries({ queryKey: ['quiz-grader'] })

  async function decideGroup(g: Group, points: number | null, addAlias?: string) {
    setError('')
    try {
      await api.post(`/quiz-grader/content/${id}/review/${selected}/group`, { groupKey: g.groupKey, points, ...(addAlias ? { addAlias } : {}) })
      refresh()
    } catch (e) { setError(apiError(e, 'Could not save that decision')) }
  }
  async function decidePaper(m: Member, points: number | null, features?: boolean[]) {
    setError('')
    try {
      await api.post(`/quiz-grader/pages/${m.pageId}/boxes/${selected}`, { points, ...(features ? { features } : {}) })
      refresh()
    } catch (e) { setError(apiError(e, 'Could not save that decision')) }
  }

  const slots = (summary?.slots ?? []).filter((s) => !onlyOpen || s.open > 0 || s.slotId === selected)
  const flagged = summary ? summary.slots.reduce((a, s) => a + s.open, 0) : 0

  return (
    <ProfessorLayout>
      <Link to={`/professor/quiz-grader/${id}/results`} className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink mb-4">
        <ArrowLeft size={14} /> Results
      </Link>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-5">
        <div>
          <p className="text-xs font-bold uppercase tracking-widest text-muted">Review</p>
          {/* Nothing until the counts arrive: "nothing left" must never be a loading state. */}
          <h1 className="text-2xl font-bold text-ink min-h-8">
            {!summary ? '' : flagged === 0 ? 'Nothing left to review' : `${flagged} box${flagged === 1 ? '' : 'es'} left to review`}
          </h1>
          <p className="text-sm text-muted">One decision covers every paper that wrote the same thing, including papers uploaded later.</p>
        </div>
        <label className="text-sm text-ink-2 flex items-center gap-2">
          <input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} /> Only boxes with something to review
        </label>
      </div>
      {error && <p className="text-sm text-warn mb-3">{error}</p>}

      <div className="grid lg:grid-cols-[240px_minmax(0,1fr)] gap-5 items-start">
        <Card className="p-2 lg:sticky lg:top-4">
          {summary && slots.length === 0 && <p className="text-sm text-muted p-2">All reviewed.</p>}
          {slots.map((s) => (
            <button key={s.slotId} onClick={() => setSelected(s.slotId)}
              className={cn('w-full text-left px-2.5 py-1.5 rounded-sm flex items-center gap-2 text-sm', s.slotId === selected ? 'bg-surface-2 font-semibold text-ink' : 'text-ink-2 hover:bg-surface-2')}>
              <span className="flex-1 truncate">{s.label}</span>
              {s.open > 0 ? <span className="text-xs text-warn">{s.open}</span> : <Check size={13} className="text-good" />}
            </button>
          ))}
        </Card>

        <div className="min-w-0">
          {item && item.slotId === selected && (
            <>
              <div className="mb-4">
                <h2 className="text-lg font-semibold text-ink">{item.label}</h2>
                {item.accept && <p className="text-xs text-muted">Accepted: {item.accept.join(' · ')}</p>}
              </div>
              {item.kind === 'structure'
                ? <StructureList item={item} onDecide={decidePaper} />
                : <GroupList item={item} onGroup={decideGroup} onPaper={decidePaper} />}
            </>
          )}
        </div>
      </div>

      {log && log.entries.length > 0 && (
        <section className="mt-10">
          <h2 className="text-base font-semibold text-ink mb-2">Recent decisions</h2>
          <Card className="divide-y divide-hairline text-sm">
            {log.entries.map((e) => (
              <div key={e.id} className="px-4 py-2 flex flex-wrap gap-x-3 gap-y-0.5">
                <span className="text-muted text-xs w-36 shrink-0">{new Date(e.createdAt).toLocaleString()}</span>
                <span className="text-ink-2 flex-1 min-w-0">
                  {e.scope === 'alias' ? <>Added “{e.detail?.alias}” to the key for <span className="font-mono">{e.slotId}</span></>
                    : <>
                        <span className="font-mono">{e.slotId}</span>{' '}
                        {e.scope === 'group' ? <>“{e.groupKey}” ({e.papers} paper{e.papers === 1 ? '' : 's'})</> : <>page {e.page != null ? e.page + 1 : '?'}</>}
                        {': '}{e.fromPoints ?? 'auto'} → {e.toPoints ?? 'withdrawn'}
                        {e.detail?.note ? ` · ${e.detail.note}` : ''}
                      </>}
                </span>
                <span className="text-muted text-xs">{e.who}</span>
              </div>
            ))}
          </Card>
        </section>
      )}
    </ProfessorLayout>
  )
}

function GroupList({ item, onGroup, onPaper }: {
  item: Item
  onGroup: (g: Group, points: number | null, addAlias?: string) => Promise<void>
  onPaper: (m: Member, points: number | null) => Promise<void>
}) {
  const [showDone, setShowDone] = useState(false)
  const open = item.groups.filter((g) => g.open > 0)
  const rest = item.groups.filter((g) => g.open === 0)
  return (
    <div className="space-y-3">
      {open.map((g) => <GroupCard key={g.key} g={g} item={item} onGroup={onGroup} onPaper={onPaper} />)}
      {open.length === 0 && <p className="text-sm text-good">Every flagged answer in this box is decided.</p>}
      {rest.length > 0 && (
        <button className="text-sm text-signal hover:underline" onClick={() => setShowDone((v) => !v)}>
          {showDone ? 'Hide' : 'Show'} {rest.length} other answer{rest.length === 1 ? '' : 's'} (not flagged, or already decided)
        </button>
      )}
      {showDone && rest.map((g) => <GroupCard key={g.key} g={g} item={item} onGroup={onGroup} onPaper={onPaper} />)}
    </div>
  )
}

function GroupCard({ g, item, onGroup, onPaper }: {
  g: Group
  item: Item
  onGroup: (g: Group, points: number | null, addAlias?: string) => Promise<void>
  onPaper: (m: Member, points: number | null) => Promise<void>
}) {
  const [more, setMore] = useState(false)
  const [alias, setAlias] = useState(false)
  const [busy, setBusy] = useState(false)
  const first = g.members[0]!
  const autoPoints = useMemo(() => [...new Set(g.members.map((m) => m.pointsAuto))], [g.members])
  const inexact = (item.kind === 'enzyme' || item.kind === 'name') && first.status === 'read' && first.detail.match?.verdict !== 'exact'
  const shown = more ? g.members : g.members.slice(0, 8)
  const act = async (points: number | null, withAlias = false) => {
    setBusy(true)
    try { await onGroup(g, points, withAlias ? g.sample : undefined) } finally { setBusy(false) }
  }
  return (
    <Card className={cn('p-4', g.open > 0 && 'ring-1 ring-warn/40')}>
      <div className="flex flex-wrap items-start gap-3 mb-3">
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-ink break-words">{readingOf(g, item.kind)}</p>
          <p className="text-xs text-muted">
            {g.count} paper{g.count === 1 ? '' : 's'} · automatic {autoPoints.join('/')} of {item.maxPoints}
            {first.detail.match && first.detail.match.verdict !== 'exact' ? ` · closest accepted: ${first.detail.match.alias}` : ''}
          </p>
          {g.open > 0 && first.reviewReasons.length > 0 && <p className="text-xs text-warn mt-0.5">{first.reviewReasons.join('; ')}</p>}
        </div>
        {g.decision ? <Pill variant="good">Decided: {g.decision.points}</Pill> : g.open > 0 ? <Pill variant="warn">{g.open} to review</Pill> : <Pill variant="muted">Automatic</Pill>}
      </div>

      <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-2 mb-3">
        {shown.map((m) => <PaperThumb key={m.pageId} m={m} slotId={item.slotId} max={item.maxPoints} onPaper={onPaper} />)}
      </div>
      {g.members.length > 8 && (
        <button className="text-xs text-signal hover:underline mb-3" onClick={() => setMore((v) => !v)}>{more ? 'Show fewer' : `Show all ${g.members.length}`}</button>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary" disabled={busy} onClick={() => void act(item.maxPoints, alias)}><Check size={13} />Correct ({item.maxPoints})</Button>
        <Button size="sm" disabled={busy} onClick={() => void act(0)}><X size={13} />Wrong (0)</Button>
        {!g.decision && autoPoints.length === 1 && (
          <Button size="sm" disabled={busy} onClick={() => void act(autoPoints[0]!)} title="Keep the automatic score, and stop flagging it"><CheckCheck size={13} />Keep {autoPoints[0]}</Button>
        )}
        {g.decision && <Button size="sm" disabled={busy} onClick={() => void act(null)}><RotateCcw size={13} />Undo decision</Button>}
        {inexact && (
          <label className="text-xs text-ink-2 flex items-center gap-1.5 ml-1">
            <input type="checkbox" checked={alias} onChange={(e) => setAlias(e.target.checked)} />
            Also accept “{g.sample}” in the key, for every quiz using it
          </label>
        )}
      </div>
    </Card>
  )
}

/** One paper's crop; click to decide this paper alone. */
function PaperThumb({ m, slotId, max, onPaper }: { m: Member; slotId: string; max: number; onPaper: (m: Member, points: number | null) => Promise<void> }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <button onClick={() => setOpen((v) => !v)} className={cn('block w-full rounded-sm overflow-hidden border', m.source === 'paper' ? 'border-signal' : 'border-hairline')}
        title={`Page ${m.index + 1}: ${m.points}/${max}${m.source === 'paper' ? ' (decided for this paper)' : ''}`}>
        <AuthImage src={`/quiz-grader/pages/${m.pageId}/crops/${slotId}`} alt={`Page ${m.index + 1}`} />
        <span className="absolute bottom-0 right-0 text-[10px] bg-surface/90 px-1">{m.points}</span>
      </button>
      {open && (
        <Card className="absolute z-20 mt-1 p-2 w-48 text-xs space-y-1.5">
          <Link to={`/professor/quiz-grader/pages/${m.pageId}`} className="text-signal hover:underline block">Open page {m.index + 1}</Link>
          <p className="text-muted">This paper only:</p>
          <div className="flex flex-wrap gap-1">
            {[...new Set([0, max])].map((v) => (
              <Button key={v} size="sm" onClick={() => { setOpen(false); void onPaper(m, v) }}>{v}</Button>
            ))}
            {m.source === 'paper' && <Button size="sm" onClick={() => { setOpen(false); void onPaper(m, null) }}>Undo</Button>}
          </div>
        </Card>
      )}
    </div>
  )
}

function StructureList({ item, onDecide }: { item: Item; onDecide: (m: Member, points: number | null, features?: boolean[]) => Promise<void> }) {
  const papers = item.groups.flatMap((g) => g.members)
  const open = papers.filter((m) => m.open)
  const [showDone, setShowDone] = useState(false)
  const done = papers.filter((m) => !m.open)
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">Check what the drawing shows. The model&rsquo;s answers are filled in; the points follow from the key&rsquo;s rules.</p>
      {open.map((m) => <StructureCard key={m.pageId} m={m} item={item} onDecide={onDecide} />)}
      {open.length === 0 && <p className="text-sm text-good">Every drawing in this box is decided.</p>}
      {done.length > 0 && <button className="text-sm text-signal hover:underline" onClick={() => setShowDone((v) => !v)}>{showDone ? 'Hide' : 'Show'} {done.length} decided</button>}
      {showDone && done.map((m) => <StructureCard key={m.pageId} m={m} item={item} onDecide={onDecide} />)}
    </div>
  )
}

function StructureCard({ m, item, onDecide }: { m: Member; item: Item; onDecide: (m: Member, points: number | null, features?: boolean[]) => Promise<void> }) {
  const features = item.features ?? []
  const initial = m.override?.features ?? features.map((_, i) => !!m.detail.features?.[i]?.present)
  const [checks, setChecks] = useState<boolean[]>(initial)
  const [busy, setBusy] = useState(false)
  useEffect(() => setChecks(m.override?.features ?? features.map((_, i) => !!m.detail.features?.[i]?.present)), [m.override, m.detail.features, features])
  const save = async (points: number | null, f?: boolean[]) => { setBusy(true); try { await onDecide(m, points, f) } finally { setBusy(false) } }
  return (
    <Card className={cn('p-4 grid sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-4', m.open && 'ring-1 ring-warn/40')}>
      <div>
        <AuthImage src={`/quiz-grader/pages/${m.pageId}/crops/${item.slotId}`} alt={`Page ${m.index + 1}`} className="rounded-sm overflow-hidden border border-hairline" />
        <p className="text-xs text-muted mt-1">
          <Link to={`/professor/quiz-grader/pages/${m.pageId}`} className="text-signal hover:underline">Page {m.index + 1}</Link>
          {m.detail.description ? ` · model: ${m.detail.description}` : ''}
        </p>
      </div>
      <div className="space-y-2">
        {m.status !== 'read' ? <p className="text-sm text-muted">{m.status === 'blank' ? 'Left empty' : 'Could not be read'}</p> : features.map((f, i) => (
          <label key={f} className="flex items-start gap-2 text-sm text-ink-2">
            <input type="checkbox" className="mt-1" checked={checks[i] ?? false} onChange={(e) => setChecks((c) => c.map((x, j) => (j === i ? e.target.checked : x)))} />
            <span>{f}</span>
          </label>
        ))}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {m.status === 'read' && <Button size="sm" variant="primary" disabled={busy} onClick={() => void save(item.maxPoints, checks)}><Check size={13} />Save checks</Button>}
          <Button size="sm" disabled={busy} onClick={() => void save(0)}><X size={13} />0 points</Button>
          {m.source === 'paper' && <Button size="sm" disabled={busy} onClick={() => void save(null)}><RotateCcw size={13} />Undo</Button>}
          <span className="text-xs text-muted">Now {m.points}/{item.maxPoints}{m.source === 'paper' ? ' (decided)' : ''}</span>
        </div>
      </div>
    </Card>
  )
}
