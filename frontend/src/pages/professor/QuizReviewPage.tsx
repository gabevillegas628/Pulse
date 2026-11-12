import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Check, CheckCheck, CircleHelp, RotateCcw, X } from 'lucide-react'
import { api } from '@/api/client'
import ProfessorLayout from '@/components/layout/ProfessorLayout'
import Button from '@/components/ui/Button'
import Card from '@/components/ui/Card'
import Pill from '@/components/ui/Pill'
import AuthImage from '@/components/quizGrader/AuthImage'
import { apiError } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { REASON_TALLY, explainReason, reasonKind, type ReasonKind } from '@/lib/quizGrader'

/**
 * Review by item: one box at a time, every paper's answer grouped by what was written, so
 * one decision covers everyone who wrote the same thing (and anyone who writes it later).
 * Structures are judged one drawing at a time against the key's feature checks.
 */

interface SlotSummary { slotId: string; label: string; kind: string; papers: number; open: number; groups: number; reasons?: string[] }
interface Member {
  pageId: string; batchId: string; index: number; version: string | null
  status: string; blankBy: string | null; transcription: string | null
  detail: { match: { verdict: string; alias: string } | null; cofactors: { text: string; side: string }[] | null; features: { feature: string; present: boolean; confidence?: number }[] | null; description: string | null }
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
  const tally = useMemo(() => {
    const t = new Map<ReasonKind, number>()
    for (const s of summary?.slots ?? []) for (const r of s.reasons ?? []) t.set(reasonKind(r), (t.get(reasonKind(r)) ?? 0) + 1)
    return [...t.entries()].sort((a, b) => b[1] - a[1])
  }, [summary])

  /** Every open answer in this box keeps its automatic score: one decision per group (structures: per paper). */
  async function keepAll(shown: Item) {
    setError('')
    try {
      // Fresh from the server, not the list as last loaded: a decision saved a moment ago
      // must never be overwritten by an automatic score because the page had not caught up.
      const it = (await api.get(`/quiz-grader/content/${id}/review/${shown.slotId}`)).data.data as Item
      if (it.kind === 'structure') {
        for (const m of it.groups.flatMap((g) => g.members).filter((m) => m.open)) {
          await api.post(`/quiz-grader/pages/${m.pageId}/boxes/${it.slotId}`, { points: m.pointsAuto })
        }
      } else {
        for (const g of it.groups.filter((g) => g.open > 0 && new Set(g.members.map((m) => m.pointsAuto)).size === 1)) {
          await api.post(`/quiz-grader/content/${id}/review/${it.slotId}/group`, { groupKey: g.groupKey, points: g.members[0]!.pointsAuto })
        }
      }
    } catch (e) { setError(apiError(e, 'Could not save those decisions')) }
    refresh()
  }

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
          {tally.length > 0 && (
            <p className="text-sm text-ink-2">{tally.map(([k, n]) => `${n} ${REASON_TALLY[k]}`).join(' · ')}</p>
          )}
          <p className="text-sm text-muted">Answers are grouped by how they were read. One decision covers every paper in a group, including papers uploaded later.</p>
        </div>
        <label className="text-sm text-ink-2 flex items-center gap-2">
          <input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} /> Only boxes with something to review
        </label>
      </div>
      {error && <p className="text-sm text-warn mb-3">{error}</p>}

      <div className="grid lg:grid-cols-[200px_minmax(0,1fr)] gap-5 items-start">
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
              <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold text-ink">{item.label}</h2>
                  {item.accept && <p className="text-xs text-muted">Accepted: {item.accept.join(' · ')}</p>}
                </div>
                {item.groups.some((g) => g.open > 0) && (
                  <Button size="sm" onClick={() => void keepAll(item)} title="Agree with the automatic score on every flagged answer in this box">
                    <CheckCheck size={13} />Keep all as scored
                  </Button>
                )}
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
  // Groups decided while this box is open stay where they were, collapsed, so their
  // decision can be seen and undone. Cleared on moving to another box.
  const [recent, setRecent] = useState<Set<string>>(new Set())
  useEffect(() => { setRecent(new Set()); setShowDone(false) }, [item.slotId])
  const here = item.groups.filter((g) => g.open > 0 || recent.has(g.key))
  const open = item.groups.filter((g) => g.open > 0)
  const rest = item.groups.filter((g) => g.open === 0 && !recent.has(g.key))
  return (
    <div className="space-y-3">
      {here.map((g) => g.open === 0 && g.decision
        ? <DecidedRow key={g.key} text={readingOf(g, item.kind)} count={g.count} points={g.decision.points} max={item.maxPoints}
            onUndo={() => void onGroup(g, null)} />
        : g.open === 0 && g.members.every((m) => m.source === 'paper')
        ? <PaperByPaper key={g.key} g={g} item={item}>
            <GroupCard g={g} item={item} onGroup={onGroup} onPaper={onPaper} />
          </PaperByPaper>
        : <GroupCard key={g.key} g={g} item={item} onGroup={onGroup} onDecided={() => setRecent((r) => new Set(r).add(g.key))}
            // A paper decided alone keeps its group in view too, so the decision stays visible.
            onPaper={async (m, points) => { await onPaper(m, points); setRecent((r) => new Set(r).add(g.key)) }} />)}
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

const CORRECT = '!border-good !text-good hover:!bg-good-soft'
const WRONG = '!border-signal !text-signal hover:!bg-signal-soft'

/** The tag on the button that matches the automatic score. */
function AsScored() {
  return <span className="ml-1 text-[10px] font-normal uppercase tracking-wide opacity-70">as scored</span>
}

/** A group whose every paper was decided on its own: one line, crops a click away. */
function PaperByPaper({ g, item, children }: { g: Group; item: Item; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const right = g.members.filter((m) => m.points === item.maxPoints).length
  if (open) return <div className="space-y-1">{children}<button className="text-xs text-signal hover:underline" onClick={() => setOpen(false)}>Collapse</button></div>
  return (
    <Card flat className="px-4 py-2.5 flex flex-wrap items-center gap-3 text-sm">
      <Check size={15} className="text-good shrink-0" />
      <span className="flex-1 min-w-0 text-ink-2 truncate">
        <span className="font-semibold text-ink">{g.count === 1 ? `Decided: ${right ? 'Correct' : 'not correct'}` : `All ${g.count} decided paper by paper`}</span>
        {g.count > 1 ? ` (${right} correct, ${g.count - right} not)` : ''} · {readingOf(g, item.kind)}
      </span>
      <Button size="sm" onClick={() => setOpen(true)}>Show</Button>
    </Card>
  )
}

/** A group or drawing decided while this box is open: kept in place, one line, undoable. */
function DecidedRow({ text, count, points, max, onUndo }: { text: string; count?: number; points: number; max: number; onUndo: () => void }) {
  const verdict = points === max ? `Correct (${points})` : points === 0 ? 'Wrong (0)' : `${points} of ${max}`
  return (
    <Card flat className="px-4 py-2.5 flex flex-wrap items-center gap-3 text-sm">
      <Check size={15} className="text-good shrink-0" />
      <span className="flex-1 min-w-0 text-ink-2 truncate">
        <span className="font-semibold text-ink">Decided: {verdict}</span>
        {count && count > 1 ? ` for all ${count}` : ''} · {text}
      </span>
      <Button size="sm" onClick={onUndo}><RotateCcw size={13} />Undo</Button>
    </Card>
  )
}

function GroupCard({ g, item, onGroup, onPaper, onDecided }: {
  g: Group
  item: Item
  onDecided?: () => void
  onGroup: (g: Group, points: number | null, addAlias?: string) => Promise<void>
  onPaper: (m: Member, points: number | null) => Promise<void>
}) {
  const [more, setMore] = useState(false)
  const [alias, setAlias] = useState(false)
  const [busy, setBusy] = useState(false)
  const first = g.members[0]!
  const autoPoints = useMemo(() => [...new Set(g.members.map((m) => m.pointsAuto))], [g.members])
  const inexact = (item.kind === 'enzyme' || item.kind === 'name') && first.status === 'read' && first.detail.match?.verdict !== 'exact'
  // Flagged papers first, then the rest of the group: the same reading, shown so a glance
  // confirms they really say the same thing.
  // Papers you decided alone stay up here with the flagged ones, not among the faded rest.
  const flagged = g.members.filter((m) => m.open || m.source === 'paper')
  const others = g.members.filter((m) => !m.open && m.source !== 'paper')
  const shownOthers = more ? others : others.slice(0, Math.max(0, 8 - flagged.length))
  const all = g.count > 1 ? ` for all ${g.count}` : ''
  // Every reason any open paper in the group was flagged for, once each.
  const reasons = useMemo(() => [...new Map(g.members.filter((m) => m.open).flatMap((m) => m.reviewReasons).map((r) => [reasonKind(r), r])).values()], [g.members])
  const keep = !g.decision && autoPoints.length === 1 ? autoPoints[0]! : null
  const act = async (points: number | null, withAlias = false) => {
    setBusy(true)
    try {
      await onGroup(g, points, withAlias ? g.sample : undefined)
      if (points !== null) onDecided?.()
    } finally { setBusy(false) }
  }
  return (
    <Card className={cn('p-4', g.open > 0 && 'ring-1 ring-warn/40')}>
      <div className="flex flex-wrap items-start gap-3 mb-3">
        <div className="flex-1 min-w-0">
          <p className="text-xs text-muted">{g.count === 1 ? '1 paper' : `${g.count} papers`} {first.status === 'read' ? 'read as' : 'were'}</p>
          <p className="font-semibold text-ink break-words">{readingOf(g, item.kind)}</p>
          <p className="text-xs text-muted">
            scored {autoPoints.join(' or ')} of {item.maxPoints} automatically
            {first.detail.match && first.detail.match.verdict !== 'exact' ? ` · closest accepted answer: ${first.detail.match.alias}` : ''}
          </p>
        </div>
        {g.decision ? <Pill variant="good">Decided{all}: {g.decision.points}</Pill>
          : g.open > 0 ? <Pill variant="warn">{g.open === g.count ? (g.count === 1 ? 'Flagged' : `All ${g.count} flagged`) : `${g.open} of ${g.count} flagged`}</Pill>
          : g.members.some((m) => m.source === 'paper') ? <Pill variant="good">Decided paper by paper</Pill>
          : <Pill variant="muted">Automatic</Pill>}
      </div>
      {g.open > 0 && reasons.length > 0 && (
        <div className="text-sm text-ink-2 bg-warn-soft/60 rounded-sm px-3 py-2 mb-3 space-y-0.5">
          {reasons.map((r) => <p key={r} className="flex gap-1.5"><CircleHelp size={15} className="shrink-0 mt-0.5 text-warn" />{explainReason(r, first.detail.match?.alias)}</p>)}
          <p className="text-xs text-muted pl-5">Scored {autoPoints.join(' or ')} of {item.maxPoints} until you decide.</p>
        </div>
      )}

      {flagged.length > 0 && others.length > 0 && <p className="text-xs font-semibold text-warn mb-1.5">Flagged</p>}
      <div className={cn('grid gap-3 mb-3', others.length === 0 && flagged.length > 2 ? 'grid-cols-2 sm:grid-cols-3' : 'grid-cols-1 sm:grid-cols-2')}>
        {flagged.map((m) => <PaperThumb key={m.pageId} m={m} slotId={item.slotId} max={item.maxPoints} onPaper={onPaper} flagged={others.length > 0} />)}
      </div>
      {others.length > 0 && (
        <>
          {flagged.length > 0 && <p className="text-xs text-muted mb-1.5">Read the same way, not flagged{shownOthers.length < others.length ? ` (${shownOthers.length} of ${others.length} shown)` : ''}</p>}
          <div className={cn('grid grid-cols-2 sm:grid-cols-3 gap-2 mb-3', flagged.length > 0 && 'opacity-80')}>
            {shownOthers.map((m) => <PaperThumb key={m.pageId} m={m} slotId={item.slotId} max={item.maxPoints} onPaper={onPaper} />)}
          </div>
          {shownOthers.length < others.length || more ? (
            <button className="text-xs text-signal hover:underline mb-3" onClick={() => setMore((v) => !v)}>{more ? 'Show fewer' : `Show all ${others.length}`}</button>
          ) : null}
        </>
      )}
      {g.members.every((m) => m.source === 'paper') && !g.decision ? (
        <p className="text-xs text-muted">Every paper here has its own call. Click a crop to change or undo it.</p>
      ) : (<>
      <p className="text-xs text-muted mb-2">
        {g.count > 1 ? `A decision here applies to all ${g.count} papers that read this way, and to any uploaded later. ` : ''}
        Click a crop to decide that paper alone.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        {/* Always in this order, whatever was scored: Correct, Wrong, then Keep for a
            partial score. The one matching the automatic score is tagged, never moved. */}
        <Button size="sm" disabled={busy} onClick={() => void act(item.maxPoints, alias)} className={CORRECT}>
          <Check size={13} />Correct ({item.maxPoints}){all}{keep === item.maxPoints && <AsScored />}
        </Button>
        <Button size="sm" disabled={busy} onClick={() => void act(0)} className={WRONG}>
          <X size={13} />Wrong (0){all}{keep === 0 && <AsScored />}
        </Button>
        {keep !== null && keep !== 0 && keep !== item.maxPoints && (
          <Button size="sm" disabled={busy} onClick={() => void act(keep)} title="Agree with the automatic partial score">
            <CheckCheck size={13} />Keep {keep}{all}
          </Button>
        )}
        {g.decision && <Button size="sm" disabled={busy} onClick={() => void act(null)}><RotateCcw size={13} />Undo decision</Button>}
        {inexact && (
          <label className="text-xs text-ink-2 flex items-center gap-1.5 ml-1">
            <input type="checkbox" checked={alias} onChange={(e) => setAlias(e.target.checked)} />
            Also accept “{g.sample}” in the key, for every quiz using it
          </label>
        )}
      </div>
      </>)}
    </Card>
  )
}

/** One paper's crop; click to decide this paper alone. */
function PaperThumb({ m, slotId, max, onPaper, flagged }: { m: Member; slotId: string; max: number; onPaper: (m: Member, points: number | null) => Promise<void>; flagged?: boolean }) {
  const [open, setOpen] = useState(false)
  const src = `/quiz-grader/pages/${m.pageId}/crops/${slotId}`
  return (
    <div className="relative">
      <button onClick={() => setOpen(true)} className={cn('block w-full rounded-sm overflow-hidden bg-white cursor-zoom-in', m.source === 'paper' ? 'border border-signal' : flagged ? 'ring-2 ring-warn' : 'border border-hairline')}
        title={`Page ${m.index + 1}: ${m.points}/${max}${m.source === 'paper' ? ' (decided for this paper)' : ''}${m.open && m.reviewReasons[0] ? ` · flagged: ${explainReason(m.reviewReasons[0])}` : ''} · click to enlarge`}>
        <AuthImage src={src} alt={`Page ${m.index + 1}`} />
        <span className="absolute bottom-0 left-0 text-[10px] bg-surface/90 px-1 text-muted">p{m.index + 1}</span>
        {m.source === 'paper' && (
          <span className="absolute top-0 left-0 text-[11px] font-semibold bg-signal text-white px-1.5 py-0.5">your call: {m.points}</span>
        )}
        <span className="absolute bottom-0 right-0 text-[11px] font-semibold bg-surface/90 px-1">{m.points}</span>
      </button>
      {open && (
        <Lightbox src={src} alt={`Page ${m.index + 1}`} onClose={() => setOpen(false)}>
          <div className="space-y-2 text-sm">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-ink">Page {m.index + 1} · <span className="font-semibold">{m.points}/{max}</span>{m.source === 'paper' ? ' (decided for this paper)' : ''}</span>
              <Link to={`/professor/quiz-grader/pages/${m.pageId}`} className="text-signal hover:underline text-xs">Open the whole page</Link>
            </div>
            {m.open && m.reviewReasons[0] && <p className="text-warn text-xs">{explainReason(m.reviewReasons[0])}</p>}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted">Decide this paper alone:</span>
              {[...new Set([max, 0])].map((v) => (
                <Button key={v} size="sm" className={v === max ? CORRECT : WRONG} onClick={() => { setOpen(false); void onPaper(m, v) }}>{v === max ? `Correct (${max})` : 'Wrong (0)'}</Button>
              ))}
              {m.source === 'paper' && <Button size="sm" onClick={() => { setOpen(false); void onPaper(m, null) }}>Undo</Button>}
            </div>
          </div>
        </Lightbox>
      )}
    </div>
  )
}

/** A crop at full width over the page. Escape or a click outside closes it. */
function Lightbox({ src, alt, onClose, children }: { src: string; alt: string; onClose: () => void; children?: React.ReactNode }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <Card className="w-full max-w-4xl p-3 space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-end">
          <button onClick={onClose} className="text-muted hover:text-ink" aria-label="Close"><X size={18} /></button>
        </div>
        <AuthImage src={src} alt={alt} eager className="rounded-sm border border-hairline overflow-hidden bg-white" />
        {children}
      </Card>
    </div>
  )
}

function StructureList({ item, onDecide }: { item: Item; onDecide: (m: Member, points: number | null, features?: boolean[]) => Promise<void> }) {
  const papers = item.groups.flatMap((g) => g.members)
  const open = papers.filter((m) => m.open)
  const [showDone, setShowDone] = useState(false)
  const [recent, setRecent] = useState<Set<string>>(new Set())
  useEffect(() => { setRecent(new Set()); setShowDone(false) }, [item.slotId])
  const here = papers.filter((m) => m.open || recent.has(m.pageId))
  const done = papers.filter((m) => !m.open && !recent.has(m.pageId))
  const decide = async (m: Member, points: number | null, features?: boolean[]) => {
    await onDecide(m, points, features)
    if (points !== null) setRecent((r) => new Set(r).add(m.pageId))
  }
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">Check what the drawing shows. The model&rsquo;s answers are filled in; the points follow from the key&rsquo;s rules.</p>
      {here.map((m) => !m.open && m.source === 'paper'
        ? <DecidedRow key={m.pageId} text={`Page ${m.index + 1}`} points={m.points} max={item.maxPoints} onUndo={() => void onDecide(m, null)} />
        : <StructureCard key={m.pageId} m={m} item={item} onDecide={decide} />)}
      {open.length === 0 && <p className="text-sm text-good">Every drawing in this box is decided.</p>}
      {done.length > 0 && <button className="text-sm text-signal hover:underline" onClick={() => setShowDone((v) => !v)}>{showDone ? 'Hide' : 'Show'} {done.length} decided</button>}
      {showDone && done.map((m) => <StructureCard key={m.pageId} m={m} item={item} onDecide={decide} />)}
    </div>
  )
}

function StructureCard({ m, item, onDecide }: { m: Member; item: Item; onDecide: (m: Member, points: number | null, features?: boolean[]) => Promise<void> }) {
  const features = item.features ?? []
  const initial = m.override?.features ?? features.map((_, i) => !!m.detail.features?.[i]?.present)
  const [checks, setChecks] = useState<boolean[]>(initial)
  const [busy, setBusy] = useState(false)
  const [big, setBig] = useState(false)
  useEffect(() => setChecks(m.override?.features ?? features.map((_, i) => !!m.detail.features?.[i]?.present)), [m.override, m.detail.features, features])
  const save = async (points: number | null, f?: boolean[]) => { setBusy(true); try { await onDecide(m, points, f) } finally { setBusy(false) } }
  return (
    <Card className={cn('p-4 grid sm:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-4', m.open && 'ring-1 ring-warn/40')}>
      <div>
        <button className="block w-full cursor-zoom-in" onClick={() => setBig(true)} title="Click to enlarge">
          <AuthImage src={`/quiz-grader/pages/${m.pageId}/crops/${item.slotId}`} alt={`Page ${m.index + 1}`} className="rounded-sm overflow-hidden border border-hairline bg-white" />
        </button>
        {big && <Lightbox src={`/quiz-grader/pages/${m.pageId}/crops/${item.slotId}`} alt={`Page ${m.index + 1}`} onClose={() => setBig(false)} />}
        <p className="text-xs text-muted mt-1">
          <Link to={`/professor/quiz-grader/pages/${m.pageId}`} className="text-signal hover:underline">Page {m.index + 1}</Link>
          {m.detail.description ? ` · model: ${m.detail.description}` : ''}
        </p>
      </div>
      <div className="space-y-2">
        {m.open && m.reviewReasons.length > 0 && (
          <p className="text-sm text-ink-2 flex gap-1.5">
            <CircleHelp size={15} className="shrink-0 mt-0.5 text-warn" />
            {reasonKind(m.reviewReasons[0]!) === 'unsure'
              ? (m.detail.features ?? []).some((f) => (f.confidence ?? 1) < 0.8)
                ? 'The model was not sure about the checks marked below. The rest it was sure of.'
                : 'The model was not sure what this drawing shows overall.'
              : explainReason(m.reviewReasons[0]!)}
          </p>
        )}
        {m.status !== 'read' ? <p className="text-sm text-muted">{m.status === 'blank' ? 'Left empty' : 'Could not be read'}</p> : features.map((f, i) => (
          <label key={f} className="flex items-start gap-2 text-sm text-ink-2">
            <input type="checkbox" className="mt-1" checked={checks[i] ?? false} onChange={(e) => setChecks((c) => c.map((x, j) => (j === i ? e.target.checked : x)))} />
            <span>
              {f}
              {m.open && (m.detail.features?.[i]?.confidence ?? 1) < 0.8 && <span className="ml-1.5 text-xs text-warn font-semibold">model unsure</span>}
            </span>
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
