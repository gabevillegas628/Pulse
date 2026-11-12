import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ArrowLeft, Check, CircleAlert, Circle, Download, Printer, Trash2 } from 'lucide-react'
import { api } from '@/api/client'
import ProfessorLayout from '@/components/layout/ProfessorLayout'
import Button from '@/components/ui/Button'
import Card from '@/components/ui/Card'
import Tabs from '@/components/ui/Tabs'
import ConfirmDialog, { type DialogRequest } from '@/components/ui/ConfirmDialog'
import BoxEditor, { useBlankForm, type BlankForm } from '@/components/quizGrader/BoxEditor'
import KeyFields from '@/components/quizGrader/KeyFields'
import ScansPanel from '@/components/quizGrader/ScansPanel'
import { ScoringFields, VersionsGrid } from '@/components/quizGrader/QuizSettings'
import { apiError } from '@/lib/errors'
import { cn } from '@/lib/utils'
import {
  downloadPrintable, gradableItems, isGraded, pointsFor, saveText,
  type QuizBundle, type QuizDraft, type RawAssessment, type RawKey, type RawLayout,
} from '@/lib/quizGrader'

/**
 * One paper quiz, set up and run from one place.
 *
 * A quiz is three YAML files underneath (settings, answer key, blank form's boxes),
 * edited here as one draft. Saving sends whichever changed; the server splices each
 * change into its file, so exports stay clean, and re-scores graded papers once.
 */

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'key', label: 'Answer key' },
  { key: 'boxes', label: 'Boxes' },
  { key: 'versions', label: 'Versions' },
  { key: 'scoring', label: 'Scoring' },
  { key: 'files', label: 'Files' },
]

const PARTS = ['quiz', 'key', 'layout'] as const

function draftOf(b: QuizBundle): QuizDraft | null {
  if (!b.key?.data || !b.layout?.data || !b.quiz.data) return null
  if (b.quiz.issues.length || b.key.issues.length || b.layout.issues.length) return null
  return structuredClone({ quiz: b.quiz.data as RawAssessment, key: b.key.data as RawKey, layout: b.layout.data as RawLayout })
}

export default function QuizPage({ id }: { id: string }) {
  const qc = useQueryClient()
  const { data: bundle, isLoading, error } = useQuery<QuizBundle>({
    queryKey: ['quiz-grader', 'quiz', id],
    queryFn: () => api.get(`/quiz-grader/quizzes/${id}`).then((r) => r.data.data),
    staleTime: 0,
  })
  return (
    <ProfessorLayout>
      {/* Back to the class the quiz belongs to; a quiz from before classes goes to the overview. */}
      <Link to={bundle?.class ? `/professor/classes/${bundle.class.id}?tab=papers` : '/professor/quiz-grader'}
        className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink mb-4">
        <ArrowLeft size={14} /> {bundle?.class ? bundle.class.name : 'Paper quizzes'}
      </Link>
      {isLoading ? null : error || !bundle ? (
        <p className="text-sm text-warn">{apiError(error, 'Could not open this quiz')}</p>
      ) : (
        <QuizEditor bundle={bundle} onSaved={(b) => {
          qc.setQueryData(['quiz-grader', 'quiz', id], b)
          void qc.invalidateQueries({ queryKey: ['quiz-grader', 'content'] })
        }} />
      )}
    </ProfessorLayout>
  )
}

function QuizEditor({ bundle, onSaved }: { bundle: QuizBundle; onSaved: (b: QuizBundle) => void }) {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const original = useMemo(() => draftOf(bundle), [bundle])
  const [draft, setDraft] = useState<QuizDraft | null>(original)
  useEffect(() => setDraft(original), [original])
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ tone: 'good' | 'warn'; text: string } | null>(null)
  const [dialog, setDialog] = useState<DialogRequest | null>(null)
  const form = useBlankForm(bundle.layout?.id, bundle.layout?.hasPdf ?? false)

  const broken = !draft || !original
  const tab = broken ? 'files' : (params.get('tab') ?? 'overview')
  const setTab = (t: string) => setParams((p) => { p.set('tab', t); return p }, { replace: true })

  const dirtyParts = useMemo(
    () => (draft && original ? PARTS.filter((k) => JSON.stringify(draft[k]) !== JSON.stringify(original[k])) : []),
    [draft, original],
  )
  const dirty = dirtyParts.length > 0

  useEffect(() => {
    if (!dirty) return
    const h = (e: BeforeUnloadEvent) => { e.preventDefault() }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [dirty])

  const edit = useCallback((fn: (d: QuizDraft) => void) => setDraft((d) => {
    if (!d) return d
    const c = structuredClone(d)
    fn(c)
    return c
  }), [])

  async function save() {
    if (!draft) return
    setSaving(true)
    setMessage(null)
    try {
      const body: Record<string, { data: unknown; updatedAt: string }> = {}
      for (const k of dirtyParts) body[k] = { data: draft[k], updatedAt: bundle[k]!.updatedAt }
      const r = await api.put(`/quiz-grader/quizzes/${bundle.quiz.id}`, body)
      onSaved(r.data.data)
      setMessage({ tone: 'good', text: 'Saved. Papers already graded are re-scored to match.' })
    } catch (e) {
      setMessage({ tone: 'warn', text: apiError(e, 'Could not save') })
    } finally {
      setSaving(false)
    }
  }

  function askDelete() {
    setDialog({
      title: `Delete ${bundle.quiz.title}?`,
      body: `Its answer key and boxes go with it${bundle.sharedKey.length || bundle.sharedLayout.length ? ', except what another quiz still uses' : ''}. Download the files first if you might want it back. This cannot be undone.`,
      confirmLabel: 'Delete quiz',
      destructive: true,
      onConfirm: async () => {
        try {
          await api.delete(`/quiz-grader/quizzes/${bundle.quiz.id}`)
          navigate('/professor/quiz-grader')
        } catch (e) {
          setMessage({ tone: 'warn', text: apiError(e, 'Could not delete') })
        }
      },
    })
  }

  const title = draft?.quiz.title?.trim() || bundle.quiz.title

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-widest text-muted">Paper quiz</p>
          <h1 className="text-2xl font-bold text-ink">{title}</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" onClick={askDelete} title="Delete this quiz"><Trash2 size={13} />Delete</Button>
          <Button size="sm" disabled={!dirty || saving} onClick={() => setDraft(original)}>Discard changes</Button>
          <Button size="sm" variant="primary" disabled={!dirty || saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</Button>
        </div>
      </div>
      {message && <p className={cn('text-sm mb-3', message.tone === 'good' ? 'text-good' : 'text-warn')}>{message.text}</p>}

      <Tabs tabs={broken ? TABS.filter((t) => t.key === 'files') : TABS} active={tab} onChange={setTab} className="mb-5" />

      {draft && tab === 'overview' && <Overview bundle={bundle} draft={draft} edit={edit} form={form} dirty={dirty} go={setTab} />}
      {draft && tab === 'key' && (
        <>
          <Shared names={bundle.sharedKey} what="answer key" />
          <KeyFields draft={draft} edit={edit} />
        </>
      )}
      {draft && tab === 'boxes' && (
        <>
          <Shared names={bundle.sharedLayout} what="blank form and its boxes" />
          <BoxEditor draft={draft} edit={edit} form={form} />
        </>
      )}
      {draft && tab === 'versions' && <VersionsGrid draft={draft} edit={edit} pages={form.pages} />}
      {draft && tab === 'scoring' && <ScoringFields draft={draft} edit={edit} />}
      {tab === 'files' && <Files bundle={bundle} />}

      {dirty && (
        <div className="sticky bottom-4 mt-6 flex justify-end z-10">
          <Card className="px-4 py-2.5 flex items-center gap-3">
            <span className="text-sm text-ink-2">Unsaved changes</span>
            <Button size="sm" disabled={saving} onClick={() => setDraft(original)}>Discard</Button>
            <Button size="sm" variant="primary" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</Button>
          </Card>
        </div>
      )}
      <ConfirmDialog request={dialog} onClose={() => setDialog(null)} />
    </>
  )
}

function Shared({ names, what }: { names: string[]; what: string }) {
  if (!names.length) return null
  return (
    <p className="text-sm text-muted mb-4 flex gap-1.5">
      <AlertTriangle size={15} className="shrink-0 mt-0.5" />
      This {what} is also used by {names.join(', ')}. Changes here change {names.length === 1 ? 'that quiz' : 'those quizzes'} too.
    </p>
  )
}

// ── Overview: what is set up, what is left, and the quiz's scans ─────────────

function Overview({ bundle, draft, edit, form, dirty, go }: {
  bundle: QuizBundle
  draft: QuizDraft
  edit: (fn: (d: QuizDraft) => void) => void
  form: BlankForm
  dirty: boolean
  go: (tab: string) => void
}) {
  const [printError, setPrintError] = useState('')
  const items = gradableItems(draft.key)
  const boxOf = (ref: string) => draft.layout.slots.find((s) => s.ref === ref && s.box)
  const steps = Object.keys(draft.key.steps).length
  const intermediates = Object.keys(draft.key.intermediates).length
  const versions = Object.entries(draft.quiz.versions)
  const pageOf = (k: string, i: number) => draft.quiz.versions[k]?.page ?? i + 1

  // Points per version: every graded box, plus that version's structures.
  const totals = versions.map(([k]) => {
    let pts = 0, boxes = 0
    for (const it of items) {
      if (it.kind === 'identity' || !boxOf(it.ref)) continue
      const g = isGraded(draft.quiz, it)
      if (g === true || (Array.isArray(g) && g.includes(k))) { pts += pointsFor(draft.quiz, it.kind); boxes++ }
    }
    return { version: k, pts, boxes }
  })
  const answerBoxes = items.filter((it) => it.kind !== 'identity' && boxOf(it.ref)).length
  const noArrow = draft.layout.slots.filter((s) => s.type === 'cofactor_set' && s.box && !s.in_end).length
  const identity = ['student.name', 'student.netid'].filter((r) => boxOf(r)).length
  const pagesOk = form.state === 'ready' && versions.every(([k], i) => pageOf(k, i) <= form.pages)

  const checks: { done: boolean; title: string; detail: string; tab: string; warn?: string }[] = [
    {
      done: steps > 0, tab: 'key', title: 'Answer key',
      detail: steps ? `${steps} step${steps > 1 ? 's' : ''}, ${intermediates} intermediate${intermediates === 1 ? '' : 's'}` : 'Add the pathway’s intermediates and steps.',
    },
    {
      done: form.state === 'ready', tab: 'boxes', title: 'Blank form',
      detail: form.state === 'ready' ? `${form.pages} page${form.pages > 1 ? 's' : ''}` : form.state === 'loading' ? 'Loading…' : 'Upload the blank quiz as a PDF, one page per version.',
    },
    {
      done: answerBoxes > 0 && identity === 2, tab: 'boxes', title: 'Boxes',
      detail: answerBoxes ? `${answerBoxes} answer box${answerBoxes > 1 ? 'es' : ''}${identity === 2 ? ', plus name and NetID' : ''}` : 'Draw a box for each answer you want graded.',
      warn: [
        identity < 2 ? 'Draw the student name and NetID boxes, so papers can be matched to students.' : '',
        noArrow ? `${noArrow} cofactor box${noArrow > 1 ? 'es need' : ' needs'} the arrow direction.` : '',
      ].filter(Boolean).join(' '),
    },
    {
      done: pagesOk, tab: 'versions', title: 'Versions',
      detail: totals.map((t) => `${t.version}: ${t.boxes} boxes, ${t.pts} pts`).join(' · '),
      warn: form.state === 'ready' && !pagesOk ? 'A version is printed from a page the blank form does not have.' : '',
    },
  ]

  const print = (v?: string) => downloadPrintable(api, bundle.quiz.id, bundle.quiz.slug, v).catch((e) => setPrintError(apiError(e, 'Could not print')))
  const canPrint = form.state === 'ready' && pagesOk && !dirty

  return (
    <>
      <Card className="p-4 mb-5">
        <label className="text-xs font-semibold text-muted">Quiz name</label>
        <input className="w-full border border-hairline rounded-sm px-2.5 py-1.5 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-signal"
          value={draft.quiz.title ?? ''} placeholder={bundle.quiz.title}
          onChange={(e) => edit((d) => {
            // Kept right under the file's name line, where a person would write it.
            const { assessment, title: _old, ...rest } = d.quiz
            d.quiz = e.target.value ? { assessment, title: e.target.value, ...rest } : { assessment, ...rest }
          })} />
      </Card>
      <ClassCard bundle={bundle} />

      <h2 className="text-lg font-semibold text-ink mb-2">Setup</h2>
      <Card className="divide-y divide-hairline mb-5">
        {checks.map((c) => (
          <button key={c.title} onClick={() => go(c.tab)} className="w-full text-left px-4 py-3 flex gap-3 items-start hover:bg-surface-2">
            {c.done ? <Check size={18} className="text-good shrink-0 mt-0.5" /> : <Circle size={18} className="text-muted shrink-0 mt-0.5" />}
            <span className="min-w-0">
              <span className="block font-semibold text-ink">{c.title}</span>
              <span className="block text-sm text-muted">{c.detail}</span>
              {c.warn && <span className="block text-sm text-warn mt-0.5">{c.warn}</span>}
            </span>
          </button>
        ))}
      </Card>
      {bundle.quiz.warnings.length > 0 && (
        <Card flat className="p-4 mb-5 space-y-1">
          {bundle.quiz.warnings.map((w) => <p key={w} className="text-sm text-muted flex gap-1.5"><AlertTriangle size={15} className="shrink-0 mt-0.5" />{w}</p>)}
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-2 mb-8">
        <span className="text-sm font-semibold text-ink mr-1">Print</span>
        {versions.length > 1 && <Button size="sm" disabled={!canPrint} onClick={() => void print()}><Printer size={13} />All versions</Button>}
        {versions.map(([v]) => <Button key={v} size="sm" disabled={!canPrint} onClick={() => void print(v)}><Printer size={13} />Version {v}</Button>)}
        <span className="text-xs text-muted">{dirty ? 'Save first.' : 'With corner markers, so scans and phone photos line up.'}</span>
        {printError && <p className="w-full text-sm text-warn">{printError}</p>}
      </div>

      <ScansPanel assessmentId={bundle.quiz.id} />
    </>
  )
}

// ── Files: the YAML underneath, for export and backup ─────────────────────────

function Files({ bundle }: { bundle: QuizBundle }) {
  const files = [
    { what: 'Settings', blurb: 'Points, review rules, versions.', item: bundle.quiz },
    { what: 'Answer key', blurb: 'Steps, intermediates, accepted answers.', item: bundle.key },
    { what: 'Boxes', blurb: 'Where each answer sits on the blank form.', item: bundle.layout },
  ]
  return (
    <>
      <p className="text-sm text-muted mb-4 max-w-2xl">
        Underneath, a quiz is kept as three YAML files. You never need them to set up or grade a quiz; they are here to back up, share, or edit by hand and import again from the Paper quizzes page.
      </p>
      <div className="space-y-3">
        {files.map(({ what, blurb, item }) => (
          <Card key={what} className="p-4">
            {!item ? (
              <p className="text-sm text-warn">{what}: missing. The settings file names one that does not exist.</p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-ink">{what} <span className="text-xs font-mono text-muted font-normal">{item.slug}.yaml</span></p>
                    <p className="text-xs text-muted">{blurb}</p>
                  </div>
                  <Button size="sm" onClick={() => saveText(`${item.slug}.yaml`, item.source)}><Download size={13} />Download</Button>
                </div>
                {item.issues.map((i) => <p key={i} className="text-sm text-warn flex gap-1.5 mt-2"><CircleAlert size={15} className="shrink-0 mt-0.5" />{i}</p>)}
                <details className="mt-2">
                  <summary className="text-xs text-muted cursor-pointer">Show YAML</summary>
                  <pre className="text-xs font-mono text-ink-2 whitespace-pre overflow-x-auto mt-2">{item.source}</pre>
                </details>
              </>
            )}
          </Card>
        ))}
      </div>
    </>
  )
}

// ── Which class the quiz belongs to: move it, or copy its setup to another ─────

function ClassCard({ bundle }: { bundle: QuizBundle }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [target, setTarget] = useState('')
  const [message, setMessage] = useState<{ tone: 'good' | 'warn'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const { data: classes } = useQuery<{ id: string; name: string }[]>({
    queryKey: ['quiz-grader', 'match', bundle.quiz.id, 'classes'],
    queryFn: () => api.get(`/quiz-grader/content/${bundle.quiz.id}/match`).then((r) => r.data.data.classes),
  })
  const others = (classes ?? []).filter((c) => c.id !== bundle.class?.id)

  async function act(kind: 'move' | 'copy') {
    if (!target) return
    setBusy(true)
    setMessage(null)
    try {
      if (kind === 'move') {
        await api.put(`/quiz-grader/content/${bundle.quiz.id}/class`, { classId: target })
        void qc.invalidateQueries({ queryKey: ['quiz-grader'] })
        setMessage({ tone: 'good', text: 'Moved, with its scans and grades. Papers already matched keep their NetIDs.' })
      } else {
        const r = await api.post(`/quiz-grader/quizzes/${bundle.quiz.id}/copy`, { classId: target })
        void qc.invalidateQueries({ queryKey: ['quiz-grader'] })
        navigate(`/professor/quiz-grader/${r.data.data.id}`)
      }
      setTarget('')
    } catch (e) {
      setMessage({ tone: 'warn', text: apiError(e, kind === 'move' ? 'Could not move' : 'Could not copy') })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="p-4 mb-5">
      <p className="text-xs font-semibold text-muted">Class</p>
      <p className="text-sm text-ink mb-2">
        {bundle.class
          ? <><span className="font-semibold">{bundle.class.name}</span> <span className="text-muted">· papers are matched against its roster</span></>
          : <span className="text-warn">Not in a class yet. Move it into the class that took it.</span>}
      </p>
      {others.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <select className="border border-hairline rounded-sm px-2 py-1.5 text-sm bg-surface" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Another class">
            <option value="">Another class…</option>
            {others.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <Button size="sm" disabled={!target || busy} onClick={() => void act('move')} title="This quiz, with its scans and grades, moves to that class">Move there</Button>
          <Button size="sm" disabled={!target || busy} onClick={() => void act('copy')} title="A fresh copy of the setup (answer key, boxes, blank form, settings) for that class; no scans or grades">Copy setup there</Button>
        </div>
      )}
      {message && <p className={cn('text-sm mt-2', message.tone === 'good' ? 'text-good' : 'text-warn')}>{message.text}</p>}
    </Card>
  )
}
