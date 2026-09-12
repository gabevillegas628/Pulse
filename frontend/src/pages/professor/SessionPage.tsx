import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, getProfessorToken } from '@/api/client'
import ProfessorLayout from '@/components/layout/ProfessorLayout'
import Button from '@/components/ui/Button'
import Card from '@/components/ui/Card'
import Empty from '@/components/ui/Empty'
import { Archive, Check, ChevronLeft, Copy, Download, MoreHorizontal, Pencil, PictureInPicture2, X } from 'lucide-react'
import { io } from 'socket.io-client'
import type { SessionDetail, QuestionWithResponses, ResponseWithStudent, ThemeSet } from 'shared'
import { SessionStatus } from 'shared'
import ResultsSummary from '@/components/ResultsSummary'
import LiveMonitorPanel from '@/components/LiveMonitorPanel'
import { apiError } from '@/lib/errors'
import QuestionSettings from '@/components/session/QuestionSettings'
import AnswerKey from '@/components/session/AnswerKey'
import GradingToolbar, { type ResponseFilter } from '@/components/session/GradingToolbar'
import ThemesPanel from '@/components/session/ThemesPanel'
import QuestionDialog from '@/components/session/QuestionDialog'
import QuestionSidebar, { questionLabel } from '@/components/session/QuestionSidebar'
import ResponseTable from '@/components/session/ResponseTable'
import ConfirmDialog, { type DialogRequest } from '@/components/ui/ConfirmDialog'
import Popover from '@/components/ui/Popover'
import { downloadCsv } from '@/lib/downloadCsv'
import { questionTypeLabel } from '@/lib/questionTypes'
import { copyQrCardToClipboard } from 'shared'

type PipWindow = Window & { documentPictureInPicture?: { requestWindow: (opts: { width: number; height: number }) => Promise<Window> } }


export default function SessionPage() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const qc = useQueryClient()
  const [activeTab, setActiveTab] = useState(0)
  const [expandedQr, setExpandedQr] = useState<string | null>(null)
  const [expandedImage, setExpandedImage] = useState<string | null>(null)

  const [copiedQrId, setCopiedQrId] = useState<string | null>(null)
  const [showSectionModal, setShowSectionModal] = useState(false)

  /** A confirm or a notice, whichever the last action asked for. */
  const [ask, setAsk] = useState<DialogRequest | null>(null)

  /** The question dialog: absent, adding, or editing a particular question. */
  const [dialog, setDialog] = useState<{ mode: 'add' } | { mode: 'edit'; question: QuestionWithResponses } | null>(null)

  const deleteQuestionMutation = useMutation({
    mutationFn: (questionId: string) => api.delete(`/sessions/${sessionId}/questions/${questionId}`),
    onSuccess: (_data, questionId) => {
      qc.setQueryData<SessionDetail>(['session', sessionId], (prev) => {
        if (!prev) return prev
        const remaining = prev.questions.filter((q) => q.id !== questionId)
        return { ...prev, questions: remaining }
      })
      setActiveTab((t) => Math.max(0, t - 1))
    },
    onError: (e: unknown) => {
      setAsk({ title: 'Could not delete that question', body: apiError(e, 'Failed to delete question') })
    },
  })

  const [pipActiveTab, setPipActiveTab] = useState<number | null>(null)
  const [pipContainer, setPipContainer] = useState<HTMLElement | null>(null)
  const pipWindowRef = useRef<Window | null>(null)
  const seenQuestionIdsRef = useRef<Set<string>>(new Set())
  const pipInitializedRef = useRef(false)

  const { data, isLoading } = useQuery<SessionDetail>({
    queryKey: ['session', sessionId],
    queryFn: () => api.get(`/sessions/${sessionId}`).then((r) => r.data.data.session),
  })

  const { data: sectionsData } = useQuery<{ id: string; name: string }[]>({
    queryKey: ['sections', data?.class.id],
    queryFn: () => api.get(`/classes/${data!.class.id}/sections`).then((r) => r.data.data.sections),
    enabled: !!data?.class.id,
  })

  const summarizeMutation = useMutation({
    mutationFn: (questionId: string) =>
      api.post(`/sessions/${sessionId}/questions/${questionId}/summarize`).then((r) => r.data.data.themes),
    onSuccess: (themes: ThemeSet, questionId: string) => {
      qc.setQueryData<ThemeSet | null>(['themes', sessionId, questionId], themes)
      // A large class comes back only partly classified; the worker finishes it and
      // pushes the rest over the socket, so keep the cached copy honest either way.
      qc.invalidateQueries({ queryKey: ['themes', sessionId, questionId] })
    },
  })

  // Themes persisted for the question in view. This is what makes a summary survive a
  // page reload — it used to live only in component state and vanished on refresh.
  const themesQuestion = data?.questions[activeTab]
  const themesQuestionId = themesQuestion?.id ?? null
  const { data: persistedThemes } = useQuery<ThemeSet | null>({
    queryKey: ['themes', sessionId, themesQuestionId],
    queryFn: () =>
      api.get(`/sessions/${sessionId}/questions/${themesQuestionId}/themes`).then((r) => r.data.data.themes),
    enabled: !!themesQuestionId && themesQuestion?.type === 'FREE_TEXT',
  })

  const [gradeReasons, setGradeReasons] = useState<Record<string, string>>({})
  /**
   * Which question's response list is narrowed, and how. Keyed by question so moving
   * between questions clears the filter rather than silently carrying it across.
   */
  const [responseFilter, setResponseFilter] = useState<{ questionId: string; mode: Exclude<ResponseFilter, 'all'> } | null>(null)
  const [gradingState, setGradingState] = useState<Record<string, { graded: number; total: number }>>({})
  const [gradeResult, setGradeResult] = useState<Record<string, { failedCount: number }>>({})

  const gradeMutation = useMutation({
    mutationFn: ({ questionId, mode }: { questionId: string; mode: 'all' | 'ungraded' }) =>
      api.post(`/sessions/${sessionId}/questions/${questionId}/grade`, { mode }),
    onMutate: ({ questionId }) => {
      setGradeResult((prev) => { const next = { ...prev }; delete next[questionId]; return next })
    },
  })

  const reopenMutation = useMutation({
    mutationFn: (questionId: string) =>
      api.post(`/sessions/${sessionId}/questions/${questionId}/reopen`),
  })

  const overrideScoreMutation = useMutation({
    mutationFn: ({ questionId, responseId, aiScore }: { questionId: string; responseId: string; aiScore: number }) =>
      api.patch(`/sessions/${sessionId}/questions/${questionId}/responses/${responseId}`, { aiScore }),
    onSuccess: (_data, { questionId, responseId, aiScore }) => {
      qc.setQueryData<SessionDetail>(['session', sessionId], (prev) => {
        if (!prev) return prev
        return {
          ...prev,
          questions: prev.questions.map((q) => {
            if (q.id !== questionId) return q
            // aiReason described the AI's score, not this one — the server clears it too.
            return { ...q, responses: q.responses.map((r) => r.id === responseId ? { ...r, aiScore, aiReason: null } : r) }
          }),
        }
      })
      setGradeReasons((prev) => { const next = { ...prev }; delete next[responseId]; return next })
    },
  })

  const fullCreditMutation = useMutation({
    mutationFn: (questionId: string) => {
      const question = qc.getQueryData<SessionDetail>(['session', sessionId])?.questions.find(q => q.id === questionId)
      if (!question) throw new Error('Question not found')
      return Promise.all(
        question.responses.map(r =>
          api.patch(`/sessions/${sessionId}/questions/${questionId}/responses/${r.id}`, { aiScore: 1.0 })
        )
      )
    },
    onSuccess: (_data, questionId) => {
      qc.setQueryData<SessionDetail>(['session', sessionId], (prev) => {
        if (!prev) return prev
        return {
          ...prev,
          questions: prev.questions.map((q) => {
            if (q.id !== questionId) return q
            return { ...q, responses: q.responses.map(r => ({ ...r, aiScore: 1.0, aiReason: null })) }
          }),
        }
      })
      setGradeReasons({})
    },
  })

  // Archive-only status mutation (PATCH /sessions/:id { status: 'ARCHIVED' })
  const statusMutation = useMutation({
    mutationFn: (status: SessionStatus) => api.patch(`/sessions/${sessionId}`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['session', sessionId] }),
  })

  // Open a new run (POST /sessions/:id/runs { sectionId? })
  const openRunMutation = useMutation({
    mutationFn: (sectionId: string | null) =>
      api.post(`/sessions/${sessionId}/runs`, sectionId ? { sectionId } : {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['session', sessionId] })
      setShowSectionModal(false)
    },
  })

  // Close the current OPEN run (PATCH /sessions/:id/runs/:runId { status: 'CLOSED' })
  const closeRunMutation = useMutation({
    mutationFn: (runId: string) =>
      api.patch(`/sessions/${sessionId}/runs/${runId}`, { status: 'CLOSED' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['session', sessionId] }),
  })

  useEffect(() => {
    if (!data || pipInitializedRef.current) return
    pipInitializedRef.current = true
    let lastIdx = -1
    data.questions.forEach((q, i) => {
      if (q.responses.length > 0) {
        seenQuestionIdsRef.current.add(q.id)
        lastIdx = i
      }
    })
    if (lastIdx !== -1) setPipActiveTab(lastIdx)
  }, [data])

  useEffect(() => {
    if (!sessionId) return
    const socket = io({ path: '/socket.io', auth: { token: getProfessorToken() } })
    socket.on('connect', () => socket.emit('join_session', sessionId))

    socket.on('new_response', (payload: { student: ResponseWithStudent['student']; response: ResponseWithStudent; questionId: string; sessionId: string }) => {
      if (!seenQuestionIdsRef.current.has(payload.questionId)) {
        seenQuestionIdsRef.current.add(payload.questionId)
        const current = qc.getQueryData<SessionDetail>(['session', sessionId])
        const idx = current?.questions.findIndex((q) => q.id === payload.questionId) ?? -1
        if (idx !== -1) setPipActiveTab(idx)
      }

      qc.setQueryData<SessionDetail>(['session', sessionId], (prev) => {
        if (!prev) return prev
        return {
          ...prev,
          questions: prev.questions.map((q) => {
            if (q.id !== payload.questionId) return q
            return {
              ...q,
              responses: [{ ...payload.response, student: payload.student }, ...q.responses],
            }
          }),
        }
      })
    })

    socket.on('grade_progress', ({ questionId, graded, total, batchGrades }: { questionId: string; graded: number; total: number; batchGrades: { id: string; studentId: string; aiScore: number; reason: string }[] }) => {
      setGradingState((prev) => ({ ...prev, [questionId]: { graded, total } }))
      if (batchGrades.length > 0) {
        setGradeReasons((prev) => {
          const updates: Record<string, string> = {}
          batchGrades.forEach((g) => { updates[g.id] = g.reason })
          return { ...prev, ...updates }
        })
        qc.setQueryData<SessionDetail>(['session', sessionId], (prev) => {
          if (!prev) return prev
          return {
            ...prev,
            questions: prev.questions.map((q) => {
              if (q.id !== questionId) return q
              return {
                ...q,
                responses: q.responses.map((r) => {
                  const g = batchGrades.find((g) => g.id === r.id)
                  return g ? { ...r, aiScore: g.aiScore, aiReason: g.reason } : r
                }),
              }
            }),
          }
        })
      }
    })

    socket.on('grade_complete', ({ questionId, failedCount }: { questionId: string; failedCount: number }) => {
      setGradingState((prev) => { const next = { ...prev }; delete next[questionId]; return next })
      setGradeResult((prev) => ({ ...prev, [questionId]: { failedCount } }))
    })

    // Live themes: the worker pushes a fresh aggregate as each batch is classified.
    // Writing straight into the query cache keeps this the same shape a reload produces.
    socket.on('themes_updated', (payload: ThemeSet & { questionId: string; runId: string }) => {
      const { questionId, runId, ...themes } = payload
      void runId
      qc.setQueryData<ThemeSet | null>(['themes', sessionId, questionId], themes)
    })

    socket.on('run_status', ({ runId, status, sectionId }: { runId: string; status: SessionStatus; sectionId: string | null }) => {
      qc.setQueryData<SessionDetail>(['session', sessionId], (prev) => {
        if (!prev) return prev
        const runs = prev.runs.map((r) =>
          r.id === runId ? { ...r, status, sectionId } : r
        )
        // If no matching run exists yet, append it
        const updated = runs.some((r) => r.id === runId)
          ? runs
          : [...runs, { id: runId, sessionId: sessionId!, sectionId, status, openedAt: new Date().toISOString(), closedAt: null, createdAt: new Date().toISOString() }]
        // Derive top-level session status: OPEN if any run is OPEN
        const isLive = updated.some((r) => r.status === SessionStatus.OPEN)
        const newSessionStatus = isLive ? SessionStatus.OPEN : prev.status
        return { ...prev, runs: updated, status: newSessionStatus }
      })
    })

    return () => { socket.disconnect() }
  }, [sessionId, qc])

  async function openPip() {
    const pipApi = (window as PipWindow).documentPictureInPicture
    if (!pipApi) {
      // Names the capability rather than a browser list, which goes stale as support
      // lands. The check above is a feature test, so support arriving needs no edit here.
      setAsk({
        title: 'This browser cannot pop out results',
        body: 'Popping out needs Document Picture-in-Picture, which this browser does not support. Results still appear on this page and in the PowerPoint add-in.',
      })
      return
    }
    try {
      const pip = await pipApi.requestWindow({ width: 420, height: 520 })
      ;[...document.styleSheets].forEach((sheet) => {
        try {
          const rules = [...sheet.cssRules].map((r) => r.cssText).join('')
          const style = pip.document.createElement('style')
          style.textContent = rules
          pip.document.head.appendChild(style)
        } catch {
          if (sheet.href) {
            const link = pip.document.createElement('link')
            link.rel = 'stylesheet'
            link.href = sheet.href
            pip.document.head.appendChild(link)
          }
        }
      })
      pip.document.body.style.margin = '0'
      const container = pip.document.createElement('div')
      pip.document.body.appendChild(container)
      pipWindowRef.current = pip
      setPipContainer(container)
      pip.addEventListener('pagehide', () => {
        setPipContainer(null)
        pipWindowRef.current = null
      })
    } catch (err) {
      console.error('PiP failed:', err)
    }
  }

  if (isLoading || !data) return <ProfessorLayout><Empty message="Loading session…" /></ProfessorLayout>

  const totalResponses = data.questions.reduce((sum, q) => sum + q.responses.length, 0)
  const activeQuestion = data.questions[activeTab] as QuestionWithResponses | undefined
  // Themes belong to a question and a run, so only show a set that matches the question
  // in view. Whether the panel is open is the panel's business, not the page's.
  const themesForQuestion =
    persistedThemes && themesQuestionId === activeQuestion?.id ? persistedThemes : null

  const activeFilter: ResponseFilter =
    responseFilter && responseFilter.questionId === activeQuestion?.id ? responseFilter.mode : 'all'

  // Derive live state from runs
  const openRun = data.runs.find((r) => r.status === SessionStatus.OPEN) ?? null
  const isLive = openRun !== null
  const hasBeenRun = data.runs.length > 0

  return (
    <ProfessorLayout>
      {/* Header */}
      <div className="mb-6">
        <Link to={`/professor/classes/${data.class.id}`} className="flex items-center gap-1 text-sm text-muted hover:text-ink mb-3 transition-colors">
          <ChevronLeft size={16} /> {data.class.name}
        </Link>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-ink">{data.title}</h1>
            {/* The roster size was fetched for the PiP panel and never shown here, so the
                page could tell you 34 answers without the 42 that makes it a number. */}
            <p className="text-sm text-muted mt-1 font-mono">
              {totalResponses} response{totalResponses !== 1 ? 's' : ''}
              {(data.enrolledCount ?? 0) > 0 && <> · {data.enrolledCount} enrolled</>}
            </p>
            {openRun?.section && (
              <div className="flex items-center gap-2 mt-2">
                <span className="text-xs text-muted">Live for:</span>
                <span className="text-xs font-medium text-ink-2">Section {openRun.section.name}</span>
              </div>
            )}
          </div>

          {/* Pop out and the session's own state are the two that matter: one is the only
              live view that does not need PowerPoint, the other is the only place in the
              app a run can be opened or closed. Export and Archive are occasional, and
              Archive is one-way — it does not belong beside Reopen. */}
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="ghost"
              onClick={openPip}
              disabled={!!pipContainer}
              title={pipContainer ? 'Results window is open' : 'Pop out live results'}
            >
              <PictureInPicture2 size={14} /> {pipContainer ? 'Live' : 'Pop out'}
            </Button>

            {data.status === SessionStatus.ARCHIVED ? (
              <span className="text-xs text-muted border border-hairline px-3 py-2 rounded-sm">Archived</span>
            ) : isLive ? (
              <button
                onClick={() => openRun && closeRunMutation.mutate(openRun.id)}
                disabled={closeRunMutation.isPending}
                className="bg-red-50 text-red-600 border border-red-200 px-4 py-2 rounded-sm text-sm font-bold hover:bg-red-100 disabled:opacity-50 transition-colors"
              >
                Close session
              </button>
            ) : (
              <Button
                variant="primary"
                onClick={() => {
                  if (sectionsData && sectionsData.length > 1) {
                    setShowSectionModal(true)
                  } else {
                    openRunMutation.mutate(null)
                  }
                }}
                disabled={openRunMutation.isPending}
              >
                {hasBeenRun ? 'Reopen' : 'Open session'}
              </Button>
            )}

            <Popover
              label="More session actions"
              chevron={false}
              trigger={<MoreHorizontal size={16} />}
              className="w-52 p-1.5"
            >
              {(close) => (
                <>
                  <button
                    onClick={() => {
                      downloadCsv(`/sessions/${sessionId}/export`, `session-${sessionId}.csv`)
                      close()
                    }}
                    className="w-full flex items-center gap-2 text-left text-sm text-ink-2 hover:bg-surface-2 rounded-sm px-2.5 py-2 transition-colors"
                  >
                    <Download size={14} className="text-muted" /> Export CSV
                  </button>
                  {!isLive && hasBeenRun && data.status !== SessionStatus.ARCHIVED && (
                    <button
                      onClick={() => setAsk({
                        title: 'Archive this session?',
                        body: 'It moves out of the active list. Responses and grades are kept, and it can still be reopened.',
                        confirmLabel: 'Archive',
                        onConfirm: () => statusMutation.mutate(SessionStatus.ARCHIVED),
                      })}
                      disabled={statusMutation.isPending}
                      className="w-full flex items-center gap-2 text-left text-sm text-ink-2 hover:bg-surface-2 rounded-sm px-2.5 py-2 transition-colors disabled:opacity-50"
                    >
                      <Archive size={14} className="text-muted" /> Archive session
                    </button>
                  )}
                </>
              )}
            </Popover>
          </div>
        </div>
      </div>

      <div className="flex gap-6 items-start">
        <QuestionSidebar
          sessionId={sessionId!}
          questions={data.questions as QuestionWithResponses[]}
          activeIndex={activeTab}
          onSelect={setActiveTab}
          isLive={isLive}
          isArchived={data.status === SessionStatus.ARCHIVED}
          isDeleting={deleteQuestionMutation.isPending}
          onAdd={() => setDialog({ mode: 'add' })}
          onDelete={(q, i) => setAsk({
            title: `Delete Q${i + 1}?`,
            body: [
              questionLabel(q),
              q.responses.length > 0 ? `Its ${q.responses.length} response${q.responses.length !== 1 ? 's' : ''} will be deleted too.` : null,
              'This cannot be undone.',
            ].filter(Boolean).join('\n\n'),
            confirmLabel: 'Delete',
            destructive: true,
            onConfirm: () => deleteQuestionMutation.mutate(q.id),
          })}
        />

        {/* Main content */}
        <div className="flex-1 min-w-0">
          {!activeQuestion ? (
            <Empty message="No questions yet — add one from the sidebar." />
          ) : (
        <div>
          {/* Question header */}
          <div className="bg-surface-2 border border-hairline rounded-[14px] p-4 mb-5">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <p className="text-xs text-muted font-medium uppercase tracking-wide">Question {activeTab + 1}</p>
                  <span className="text-xs bg-surface text-ink-2 border border-hairline font-medium px-1.5 py-0.5 rounded">
                    {questionTypeLabel(activeQuestion.type)}
                  </span>
                </div>
                {activeQuestion.title && (
                  <p className="text-sm font-semibold text-ink mb-1">{activeQuestion.title}</p>
                )}
                <p className="text-ink font-medium">{activeQuestion.text}</p>
                {activeQuestion.imageUrl && (
                  <img
                    src={activeQuestion.imageUrl}
                    alt="Attached to this question"
                    onClick={() => setExpandedImage(activeQuestion.imageUrl)}
                    className="mt-2 max-h-48 rounded-[14px] border border-hairline object-contain bg-surface cursor-zoom-in"
                  />
                )}
                {/* One row of controls for the question above: change what it asks, change
                    how it behaves, and the single live action that acts on it. */}
                <div className="mt-2.5 flex items-center gap-2 flex-wrap">
                  {data.status !== SessionStatus.ARCHIVED && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setDialog({ mode: 'edit', question: activeQuestion })}
                      title="Edit question"
                    >
                      <Pencil size={12} /> Edit
                    </Button>
                  )}
                  <QuestionSettings
                    sessionId={sessionId!}
                    question={activeQuestion}
                    classDefaults={{
                      liveThemes: data.class.liveThemesDefault,
                      autoClose: data.class.autoCloseDefault,
                      effortGrading: data.class.effortGradingDefault,
                    }}
                    canSetGradingStance={hasBeenRun || data.status === SessionStatus.ARCHIVED}
                  />
                  {isLive && (activeQuestion.autoClose ?? data.class.autoCloseDefault) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => reopenMutation.mutate(activeQuestion.id)}
                      disabled={reopenMutation.isPending}
                    >
                      {reopenMutation.isSuccess && !reopenMutation.isPending ? 'Clock restarted' : 'Give them more time'}
                    </Button>
                  )}
                </div>
                {reopenMutation.isError && (
                  <p className="text-xs text-red-500 mt-2">Could not change that — try again.</p>
                )}
              </div>
              <div className="flex items-center gap-3 shrink-0">
                {/* Access code */}
                <div className="text-center">
                  <p className="text-xs text-muted mb-0.5">Code</p>
                  <p className="font-mono text-2xl font-bold text-signal tracking-widest">{activeQuestion.accessCode}</p>
                </div>
                {/* QR toggle + copy */}
                {'qrDataUrl' in activeQuestion && (activeQuestion as QuestionWithResponses & { qrDataUrl: string }).qrDataUrl && (
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => setExpandedQr(expandedQr === activeQuestion.id ? null : activeQuestion.id)}
                      className="border border-hairline rounded-sm p-1.5 hover:bg-surface transition-colors"
                      title="Show QR code"
                    >
                      <img
                        src={(activeQuestion as QuestionWithResponses & { qrDataUrl: string }).qrDataUrl}
                        alt="QR"
                        className="w-10 h-10"
                      />
                    </button>
                    {/*
                      A pasted card is pixel-identical to one the add-in inserts but carries no
                      shape tags, so Verify / Fix all / Re-bind cannot see it. The tooltip says
                      so at the moment someone would otherwise create an untracked card.
                    */}
                    <button
                      onClick={async () => {
                        await copyQrCardToClipboard({
                          qrDataUrl: (activeQuestion as QuestionWithResponses & { qrDataUrl: string }).qrDataUrl,
                          accessCode: activeQuestion.accessCode,
                          questionText: activeQuestion.text,
                        })
                        setCopiedQrId(activeQuestion.id)
                        setTimeout(() => setCopiedQrId(null), 2000)
                      }}
                      className="border border-hairline rounded-sm p-1.5 hover:bg-surface transition-colors"
                      title="Copy card image — for handouts or non-PowerPoint slides. Pasted cards are not tracked by the Pulse add-in; insert from the add-in to keep them checked."
                    >
                      {copiedQrId === activeQuestion.id
                        ? <Check size={16} className="text-good" />
                        : <Copy size={16} className="text-muted" />
                      }
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* The answer key for whatever type this question is: one component, one
                place, and the gate the backend actually applies rather than a stricter
                invented one. */}
            <AnswerKey
              key={activeQuestion.id}
              sessionId={sessionId!}
              question={activeQuestion}
              isLive={isLive}
              effortOn={activeQuestion.effortGrading ?? data.class.effortGradingDefault}
            />
          </div>

          {/* Distribution, for the types where it is the result. Free text is excluded
              here on purpose: its summary was a response count duplicated from three
              other places, an average word count nothing acts on, and a flagged count
              that is now a filter in the toolbar. `ResultsSummary` keeps that branch —
              the projector falls back to it when themes fail. */}
          {activeQuestion.type !== 'FREE_TEXT' && <ResultsSummary question={activeQuestion} />}

          {/* Aggregate views first, then the bar that acts on the list below it. */}
          {activeQuestion.type === 'FREE_TEXT' && activeQuestion.responses.length > 0 && (
            <ThemesPanel
              key={activeQuestion.id}
              themes={themesForQuestion}
              isSummarizing={summarizeMutation.isPending}
              isError={summarizeMutation.isError}
              onSummarize={() => summarizeMutation.mutate(activeQuestion.id)}
            />
          )}

          {/* Everything for grading this question, in a bar that stays put while the
              responses it acts on scroll underneath. */}
          <GradingToolbar
            question={activeQuestion}
            progress={gradingState[activeQuestion.id] ?? null}
            result={gradeResult[activeQuestion.id] ?? null}
            gradeError={gradeMutation.isError
              ? ((gradeMutation.error as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Failed to start grading.')
              : null}
            isGradePending={gradeMutation.isPending}
            canGradeWithAi={hasBeenRun || data.status === SessionStatus.ARCHIVED}
            onGrade={(mode) => {
              const alreadyGraded = activeQuestion.responses.filter((r) => r.aiScore !== null).length
              if (mode === 'all' && alreadyGraded > 0) {
                setAsk({
                  title: 'Re-grade everything?',
                  body: `${alreadyGraded} response${alreadyGraded !== 1 ? 's' : ''} already ${alreadyGraded !== 1 ? 'have' : 'has'} a score, including any you set by hand. Re-grading overwrites all of them.`,
                  confirmLabel: 'Re-grade',
                  destructive: true,
                  onConfirm: () => gradeMutation.mutate({ questionId: activeQuestion.id, mode }),
                })
                return
              }
              gradeMutation.mutate({ questionId: activeQuestion.id, mode })
            }}
            onFullCredit={() => {
              // Already unanimous: nothing changes, so nothing to warn about.
              if (activeQuestion.responses.every((r) => r.aiScore === 1.0)) {
                fullCreditMutation.mutate(activeQuestion.id)
                return
              }
              setAsk({
                title: 'Give everyone full credit?',
                body: `All ${activeQuestion.responses.length} responses on this question get 1.0, replacing any score already set.`,
                confirmLabel: 'Give full credit',
                onConfirm: () => fullCreditMutation.mutate(activeQuestion.id),
              })
            }}
            isFullCreditPending={fullCreditMutation.isPending}
            filter={activeFilter}
            onFilter={(mode) => setResponseFilter(
              mode === 'all' ? null : { questionId: activeQuestion.id, mode },
            )}
          />


          {/* The responses, as a table. Sorted worst-score-first, because those are the
              ones a person has to look at. */}
          {activeQuestion.responses.length === 0 ? (
            <Empty message="No responses yet" />
          ) : (
            <ResponseTable
              key={activeQuestion.id}
              question={activeQuestion}
              gradeReasons={gradeReasons}
              filter={activeFilter}
              isScorePending={overrideScoreMutation.isPending}
              onScoreChange={(responseId, aiScore) => overrideScoreMutation.mutate({
                questionId: activeQuestion.id,
                responseId,
                aiScore,
              })}
            />
          )}
        </div>
          )}
        </div>
      </div>

      <ConfirmDialog request={ask} onClose={() => setAsk(null)} />

      {dialog && (
        <QuestionDialog
          sessionId={sessionId!}
          question={dialog.mode === 'edit' ? dialog.question : null}
          onClose={() => setDialog(null)}
        />
      )}

      {/* PiP portal */}
      {pipContainer && data && pipActiveTab !== null &&
        createPortal(
          <LiveMonitorPanel
            question={data.questions[pipActiveTab] as QuestionWithResponses}
            questionNumber={pipActiveTab + 1}
            totalQuestions={data.questions.length}
            sessionTitle={data.title}
            enrolledCount={data.enrolledCount ?? 0}
            themes={themesForQuestion}
            themesQuestionId={themesQuestionId}
            isSummarizing={summarizeMutation.isPending}
            onSummarize={() => {
              const q = data.questions[pipActiveTab]
              if (q) summarizeMutation.mutate(q.id)
            }}
            onClose={() => pipWindowRef.current?.close()}
          />,
          pipContainer
        )
      }

      {/* Section picker modal */}
      {showSectionModal && sectionsData && (() => {
        return (
          <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
            <Card flat className="w-full max-w-sm p-6 shadow-pop">
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-base font-semibold text-ink">Open for which section?</h2>
                <button onClick={() => setShowSectionModal(false)} className="text-muted hover:text-ink-2 transition-colors">
                  <X size={18} />
                </button>
              </div>
              <p className="text-sm text-muted mb-5">
                Only students in the selected section will be able to respond.
              </p>
              <div className="space-y-2">
                {sectionsData.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => openRunMutation.mutate(s.id)}
                    disabled={openRunMutation.isPending}
                    className="w-full text-left px-4 py-3 rounded-[14px] border border-hairline hover:border-signal hover:bg-signal-soft text-ink transition-colors text-sm font-medium disabled:opacity-50"
                  >
                    Section {s.name}
                  </button>
                ))}
                <button
                  onClick={() => openRunMutation.mutate(null)}
                  disabled={openRunMutation.isPending}
                  className="w-full text-left px-4 py-3 rounded-[14px] border border-hairline hover:border-hairline-strong hover:bg-surface-2 text-muted transition-colors text-sm disabled:opacity-50"
                >
                  All sections
                </button>
              </div>
            </Card>
          </div>
        )
      })()}

      {/* Question image fullscreen overlay */}
      {expandedImage && (
        <div
          className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 cursor-zoom-out p-8"
          onClick={() => setExpandedImage(null)}
        >
          <img src={expandedImage} alt="" className="max-w-full max-h-full object-contain rounded-[14px]" />
        </div>
      )}

      {/* QR fullscreen overlay */}
      {expandedQr && activeQuestion && 'qrDataUrl' in activeQuestion && (
        <div
          className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 cursor-pointer"
          onClick={() => setExpandedQr(null)}
        >
          <div className="bg-surface rounded-[14px] p-8 text-center border border-hairline">
            <img
              src={(activeQuestion as QuestionWithResponses & { qrDataUrl: string }).qrDataUrl}
              alt="QR Code"
              className="w-64 h-64"
            />
            <p className="text-muted text-sm mt-3">Scan to answer this question</p>
            <p className="font-mono text-3xl font-bold text-signal tracking-widest mt-1">{activeQuestion.accessCode}</p>
            <p className="text-xs text-muted mt-4">Click anywhere to close</p>
          </div>
        </div>
      )}
    </ProfessorLayout>
  )
}
