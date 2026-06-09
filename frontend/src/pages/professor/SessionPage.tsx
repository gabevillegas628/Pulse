import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/api/client'
import ProfessorLayout from '@/components/layout/ProfessorLayout'
import Button from '@/components/ui/Button'
import Card from '@/components/ui/Card'
import Empty from '@/components/ui/Empty'
import { Check, ChevronLeft, Copy, Download, Flag, GraduationCap, Pencil, PictureInPicture2, Plus, Sparkles, X } from 'lucide-react'
import { io } from 'socket.io-client'
import type { SessionDetail, QuestionWithResponses, ResponseWithStudent, SummaryCategory } from 'shared'
import { SessionStatus } from 'shared'
import ResultsSummary from '@/components/ResultsSummary'
import LiveMonitorPanel from '@/components/LiveMonitorPanel'
import { apiError } from '@/lib/errors'

type PipWindow = Window & { documentPictureInPicture?: { requestWindow: (opts: { width: number; height: number }) => Promise<Window> } }


export default function SessionPage() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const qc = useQueryClient()
  const [activeTab, setActiveTab] = useState(0)
  const [expandedQr, setExpandedQr] = useState<string | null>(null)

  const [summary, setSummary] = useState<SummaryCategory[] | null>(null)
  const [summaryQuestionId, setSummaryQuestionId] = useState<string | null>(null)

  const [copiedQrId, setCopiedQrId] = useState<string | null>(null)
  const [rubricDraft, setRubricDraft] = useState<Record<string, string>>({})

  async function copyQrWithCode(qrDataUrl: string, accessCode: string) {
    const qrSize = 400
    const padding = 24
    const textAreaHeight = 80
    const canvas = document.createElement('canvas')
    canvas.width = qrSize + padding * 2
    canvas.height = qrSize + padding * 2 + textAreaHeight
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    const img = new Image()
    img.src = qrDataUrl
    await new Promise((resolve) => { img.onload = resolve })
    ctx.drawImage(img, padding, padding, qrSize, qrSize)
    ctx.fillStyle = '#ee4d2e'
    ctx.font = 'bold 52px monospace'
    ctx.textAlign = 'center'
    ctx.fillText(accessCode, canvas.width / 2, qrSize + padding + 60)
    canvas.toBlob(async (blob) => {
      if (!blob) return
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    })
  }

  const [showSectionModal, setShowSectionModal] = useState(false)

  const [showAddQuestion, setShowAddQuestion] = useState(false)
  const [aqText, setAqText] = useState('')
  const [aqType, setAqType] = useState<'FREE_TEXT' | 'MULTIPLE_CHOICE' | 'RATING' | 'YES_NO' | 'NUMERIC' | 'MULTI_SELECT' | 'ORDERING' | 'STRUCTURE'>('FREE_TEXT')
  const [aqOptions, setAqOptions] = useState('')
  const [aqNumericAnswer, setAqNumericAnswer] = useState('')
  const [aqTolerance, setAqTolerance] = useState('')
  const [aqUnit, setAqUnit] = useState('')
  const [aqError, setAqError] = useState('')

  const [showEditQuestion, setShowEditQuestion] = useState(false)
  const [eqId, setEqId] = useState<string | null>(null)
  const [eqText, setEqText] = useState('')
  const [eqOptions, setEqOptions] = useState<string[]>([])
  const [eqCorrectAnswer, setEqCorrectAnswer] = useState('')
  const [eqTolerance, setEqTolerance] = useState('')
  const [eqUnit, setEqUnit] = useState('')
  const [eqError, setEqError] = useState('')

  const [numericDraftAnswer, setNumericDraftAnswer] = useState<Record<string, string>>({})
  const [numericDraftTolerance, setNumericDraftTolerance] = useState<Record<string, string>>({})
  const [numericDraftUnit, setNumericDraftUnit] = useState<Record<string, string>>({})

  function openEditQuestion(q: QuestionWithResponses) {
    setEqId(q.id)
    setEqText(q.text)
    setEqOptions((q.options as string[] | null) ?? [])
    setEqCorrectAnswer(q.correctAnswer ?? '')
    setEqTolerance(q.tolerance != null ? String(q.tolerance) : '')
    setEqUnit(q.unit ?? '')
    setEqError('')
    setShowEditQuestion(true)
  }

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
  })

  const addQuestionMutation = useMutation({
    mutationFn: () => api.post(`/sessions/${sessionId}/questions`, {
      text: aqText,
      type: aqType,
      options: ['MULTIPLE_CHOICE', 'MULTI_SELECT', 'ORDERING'].includes(aqType)
        ? aqOptions.split('\n').map(s => s.trim()).filter(Boolean) : undefined,
      correctAnswer: aqType === 'NUMERIC' && aqNumericAnswer ? aqNumericAnswer : undefined,
      tolerance: aqType === 'NUMERIC' && aqTolerance ? parseFloat(aqTolerance) : undefined,
      unit: aqType === 'NUMERIC' && aqUnit ? aqUnit : undefined,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['session', sessionId] })
      setShowAddQuestion(false)
      setAqText(''); setAqType('FREE_TEXT'); setAqOptions('')
      setAqNumericAnswer(''); setAqTolerance(''); setAqUnit(''); setAqError('')
    },
    onError: (e: unknown) => {
      setAqError(apiError(e, 'Failed to add question'))
    },
  })

  const editQuestionMutation = useMutation({
    mutationFn: () => {
      if (!eqId) throw new Error('No question selected')
      const question = data?.questions.find(q => q.id === eqId)
      if (!question) throw new Error('Question not found')

      const payload: Record<string, unknown> = {}
      if (eqText.trim() !== question.text) payload.text = eqText.trim()

      const hasOptions = ['MULTIPLE_CHOICE', 'MULTI_SELECT', 'ORDERING'].includes(question.type)
      if (hasOptions) {
        const originalOpts = (question.options as string[] | null) ?? []
        const changed = eqOptions.length !== originalOpts.length || eqOptions.some((o, i) => o !== originalOpts[i])
        if (changed) payload.options = eqOptions.filter(o => o.trim()).map(o => o.trim())
      }

      if (question.type === 'NUMERIC') {
        const newCA = eqCorrectAnswer.trim() || null
        if (newCA !== question.correctAnswer) payload.correctAnswer = newCA
        const newTol = eqTolerance.trim() ? parseFloat(eqTolerance) : null
        if (newTol !== question.tolerance) payload.tolerance = newTol
        const newUnit = eqUnit.trim() || null
        if (newUnit !== question.unit) payload.unit = newUnit
      }

      return api.patch(`/sessions/${sessionId}/questions/${eqId}`, payload)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['session', sessionId] })
      setShowEditQuestion(false)
      setEqId(null); setEqText(''); setEqOptions([]); setEqCorrectAnswer(''); setEqTolerance(''); setEqUnit(''); setEqError('')
    },
    onError: (e: unknown) => setEqError(apiError(e, 'Failed to save question')),
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
      api.post(`/sessions/${sessionId}/questions/${questionId}/summarize`).then((r) => r.data.data.categories),
    onSuccess: (categories: SummaryCategory[], questionId: string) => {
      setSummary(categories)
      setSummaryQuestionId(questionId)
    },
  })

  const [gradeReasons, setGradeReasons] = useState<Record<string, string>>({})

  const gradeMutation = useMutation({
    mutationFn: (questionId: string) =>
      api.post(`/sessions/${sessionId}/questions/${questionId}/grade`).then((r) => r.data.data.grades as { id: string; studentId: string; aiScore: number; reason: string }[]),
    onSuccess: (grades, questionId) => {
      const reasons: Record<string, string> = {}
      grades.forEach((g) => { reasons[g.id] = g.reason })
      setGradeReasons((prev) => ({ ...prev, ...reasons }))
      qc.setQueryData<SessionDetail>(['session', sessionId], (prev) => {
        if (!prev) return prev
        return {
          ...prev,
          questions: prev.questions.map((q) => {
            if (q.id !== questionId) return q
            return {
              ...q,
              responses: q.responses.map((r) => {
                const g = grades.find((g) => g.id === r.id)
                return g ? { ...r, aiScore: g.aiScore } : r
              }),
            }
          }),
        }
      })
    },
  })

  const setCorrectAnswerMutation = useMutation({
    mutationFn: ({ questionId, correctAnswer, tolerance, unit }: { questionId: string; correctAnswer?: string | null; tolerance?: number | null; unit?: string | null }) =>
      api.patch(`/sessions/${sessionId}/questions/${questionId}`, {
        ...(correctAnswer !== undefined && { correctAnswer }),
        ...(tolerance !== undefined && { tolerance }),
        ...(unit !== undefined && { unit }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['session', sessionId] }),
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
            return { ...q, responses: q.responses.map((r) => r.id === responseId ? { ...r, aiScore } : r) }
          }),
        }
      })
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
            return { ...q, responses: q.responses.map(r => ({ ...r, aiScore: 1.0 })) }
          }),
        }
      })
    },
  })

  function questionTypeLabel(type: string): string {
    const labels: Record<string, string> = {
      FREE_TEXT: 'Free text', MULTIPLE_CHOICE: 'Multiple choice', MULTI_SELECT: 'Multi-select',
      ORDERING: 'Ordering', NUMERIC: 'Numeric', RATING: 'Rating', YES_NO: 'Yes / No', STRUCTURE: 'Structure',
    }
    return labels[type] ?? type
  }

  function cycleScore(current: number | null): number {
    if (current === null || current === 1.0) return 0
    if (current === 0) return 0.5
    return 1.0
  }

  function calcResponseScore(q: { type: string; correctAnswer: string | null; tolerance?: number | null }, r: { responseText: string; aiScore: number | null }): number | null {
    // aiScore is always the override — takes priority over computed scores
    if (r.aiScore !== null) return r.aiScore
    if (q.type === 'MULTIPLE_CHOICE' || q.type === 'YES_NO') {
      if (!q.correctAnswer) return null
      return r.responseText === q.correctAnswer ? 1.0 : 0.5
    }
    if (q.type === 'FREE_TEXT') return null
    if (q.type === 'NUMERIC') {
      if (!q.correctAnswer) return null
      const correct = parseFloat(q.correctAnswer)
      const answer = parseFloat(r.responseText)
      if (isNaN(correct) || isNaN(answer)) return null
      return Math.abs(answer - correct) <= (q.tolerance ?? 0) ? 1.0 : 0
    }
    return null
  }

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
    const socket = io({ path: '/socket.io' })
    socket.emit('join_session', sessionId)

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
      alert('Picture-in-Picture requires Chrome or Edge. Firefox is not supported yet.')
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
            <p className="text-sm text-muted mt-1 font-mono">{totalResponses} response{totalResponses !== 1 ? 's' : ''}</p>
            {openRun?.section && (
              <div className="flex items-center gap-2 mt-2">
                <span className="text-xs text-muted">Live for:</span>
                <span className="text-xs font-medium text-ink-2">Section {openRun.section.name}</span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="ghost"
              onClick={openPip}
              disabled={!!pipContainer}
              title={pipContainer ? 'Results window is open' : 'Pop out live results'}
            >
              <PictureInPicture2 size={14} /> {pipContainer ? 'Live' : 'Pop out'}
            </Button>
            <a
              href={`/api/sessions/${sessionId}/export`}
              className="inline-flex items-center gap-1.5 bg-surface border border-hairline-strong text-ink-2 rounded-sm px-4 py-2 text-sm font-bold hover:bg-surface-2 transition-colors"
            >
              <Download size={14} /> Export CSV
            </a>
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
            ) : hasBeenRun ? (
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    if (sectionsData && sectionsData.length > 1) {
                      setShowSectionModal(true)
                    } else {
                      openRunMutation.mutate(null)
                    }
                  }}
                  disabled={openRunMutation.isPending}
                  className="bg-good-soft text-good border border-good/20 px-4 py-2 rounded-sm text-sm font-bold hover:opacity-80 disabled:opacity-50 transition-colors"
                >
                  Reopen
                </button>
                <button
                  onClick={() => statusMutation.mutate(SessionStatus.ARCHIVED)}
                  disabled={statusMutation.isPending}
                  className="text-muted border border-hairline px-4 py-2 rounded-sm text-sm hover:bg-surface-2 disabled:opacity-50 transition-colors"
                >
                  Archive
                </button>
              </div>
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
                Open session
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Question tabs */}
      <div className="flex items-center gap-1 mb-6 border-b border-hairline">
        {data.questions.map((q, i) => {
          const scorableTypes = ['FREE_TEXT', 'MULTIPLE_CHOICE', 'YES_NO', 'NUMERIC']
          const isScorable = scorableTypes.includes(q.type)
          const n = q.responses.length
          const scoredCount = isScorable && n > 0
            ? q.responses.filter(r => calcResponseScore(q, r) !== null).length
            : 0

          let countColor = ''
          if (n > 0) {
            if (!isScorable) countColor = 'text-ink-2/40'
            else if (scoredCount === 0) countColor = 'text-warn'
            else if (scoredCount < n) countColor = 'text-yellow-500'
            else countColor = 'text-good'
          }

          const gradingLabel = !isScorable
            ? `${n} response${n !== 1 ? 's' : ''}`
            : scoredCount === 0 ? `${n} response${n !== 1 ? 's' : ''} — not graded`
            : scoredCount < n ? `${scoredCount} / ${n} graded`
            : `All ${n} graded`

          return (
          <div key={q.id} className="group relative flex items-center">
            <button
              onClick={() => setActiveTab(i)}
              title={n > 0 ? gradingLabel : undefined}
              className={`flex flex-col items-center px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === i
                  ? 'border-signal text-ink'
                  : 'border-transparent text-muted hover:text-ink'
              }`}
            >
              Q{i + 1}
              {n > 0 && (
                <span className={`text-[10px] font-mono leading-none mt-0.5 ${countColor}`}>{n}</span>
              )}
            </button>
            {!hasBeenRun && data.status !== SessionStatus.ARCHIVED && (
              <button
                onClick={() => {
                  if (!confirm(`Delete Q${i + 1}? This cannot be undone.`)) return
                  deleteQuestionMutation.mutate(q.id)
                }}
                disabled={deleteQuestionMutation.isPending}
                className="opacity-0 group-hover:opacity-100 transition-opacity absolute -top-1 -right-1 w-4 h-4 flex items-center justify-center bg-surface border border-hairline rounded-full text-hairline-strong hover:text-red-500 hover:border-red-300 disabled:opacity-30"
                title="Delete question"
              >
                <X size={9} />
              </button>
            )}
          </div>
        )
        })}
        <button
          onClick={() => setShowAddQuestion(true)}
          className="ml-1 mb-px flex items-center gap-1 text-xs text-muted hover:text-signal px-2 py-1.5 transition-colors"
          title="Add question"
        >
          <Plus size={13} /> Add
        </button>
      </div>

      {activeQuestion && (
        <div>
          {/* Question header */}
          <div className="bg-surface-2 border border-hairline rounded-[14px] p-4 mb-5">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <p className="text-xs text-muted font-medium uppercase tracking-wide">Question</p>
                  <span className="text-xs bg-surface text-ink-2 border border-hairline font-medium px-1.5 py-0.5 rounded">
                    {questionTypeLabel(activeQuestion.type)}
                  </span>
                </div>
                <p className="text-ink font-medium">{activeQuestion.text}</p>
                {data.status !== SessionStatus.ARCHIVED && (
                  <button
                    onClick={() => openEditQuestion(activeQuestion)}
                    className="mt-1.5 flex items-center gap-1 text-xs text-muted hover:text-signal transition-colors"
                    title="Edit question"
                  >
                    <Pencil size={11} /> Edit
                  </button>
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
                    <button
                      onClick={async () => {
                        await copyQrWithCode(
                          (activeQuestion as QuestionWithResponses & { qrDataUrl: string }).qrDataUrl,
                          activeQuestion.accessCode
                        )
                        setCopiedQrId(activeQuestion.id)
                        setTimeout(() => setCopiedQrId(null), 2000)
                      }}
                      className="border border-hairline rounded-sm p-1.5 hover:bg-surface transition-colors"
                      title="Copy QR + code as image"
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

            {/* Rubric hint — FREE_TEXT, after at least one run */}
            {(hasBeenRun || data.status === SessionStatus.ARCHIVED) &&
              activeQuestion.type === 'FREE_TEXT' && (
              <div className="mt-3 pt-3 border-t border-hairline">
                <p className="text-xs text-muted font-medium mb-1.5">What were you looking for? <span className="font-normal">(optional — helps AI grade more accurately)</span></p>
                <div className="flex gap-2">
                  <input
                    value={rubricDraft[activeQuestion.id] ?? activeQuestion.correctAnswer ?? ''}
                    onChange={(e) => setRubricDraft((d) => ({ ...d, [activeQuestion.id]: e.target.value }))}
                    onBlur={() => {
                      const val = (rubricDraft[activeQuestion.id] ?? activeQuestion.correctAnswer ?? '').trim()
                      if (val === (activeQuestion.correctAnswer ?? '')) return
                      setCorrectAnswerMutation.mutate({ questionId: activeQuestion.id, correctAnswer: val || null })
                    }}
                    placeholder="e.g. dissipates the proton motive force, increases ETC flux"
                    className="flex-1 border border-hairline rounded-sm px-3 py-1.5 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-signal"
                  />
                </div>
              </div>
            )}

            {/* Mark correct answer — MCQ / YES_NO, after at least one run */}
            {(hasBeenRun || data.status === SessionStatus.ARCHIVED) &&
              (activeQuestion.type === 'MULTIPLE_CHOICE' || activeQuestion.type === 'YES_NO') && (
              <div className="mt-3 pt-3 border-t border-hairline">
                <p className="text-xs text-muted font-medium mb-2">Correct answer</p>
                <div className="flex flex-wrap gap-2">
                  {(activeQuestion.type === 'YES_NO' ? ['Yes', 'No'] : (activeQuestion.options ?? [])).map((opt) => {
                    const isCorrect = activeQuestion.correctAnswer === opt
                    return (
                      <button
                        key={opt}
                        onClick={() => setCorrectAnswerMutation.mutate({
                          questionId: activeQuestion.id,
                          correctAnswer: isCorrect ? null : opt,
                        })}
                        disabled={setCorrectAnswerMutation.isPending}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-sm text-sm border transition-colors ${
                          isCorrect
                            ? 'bg-good-soft border-good/30 text-good font-medium'
                            : 'bg-surface border-hairline text-ink-2 hover:border-good/30 hover:text-good'
                        }`}
                      >
                        {isCorrect && <Check size={12} />} {opt}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Correct answer / tolerance — NUMERIC, all statuses */}
            {activeQuestion.type === 'NUMERIC' && (
              <div className="mt-3 pt-3 border-t border-hairline">
                <p className="text-xs text-muted font-medium mb-1.5">Correct answer <span className="font-normal">(used for automatic scoring)</span></p>
                <div className="flex gap-2 flex-wrap">
                  <input
                    value={numericDraftAnswer[activeQuestion.id] ?? activeQuestion.correctAnswer ?? ''}
                    onChange={(e) => setNumericDraftAnswer((d) => ({ ...d, [activeQuestion.id]: e.target.value }))}
                    onBlur={() => {
                      const val = (numericDraftAnswer[activeQuestion.id] ?? activeQuestion.correctAnswer ?? '').trim()
                      if (val === (activeQuestion.correctAnswer ?? '')) return
                      setCorrectAnswerMutation.mutate({ questionId: activeQuestion.id, correctAnswer: val || null })
                    }}
                    placeholder="Correct value"
                    className="w-36 border border-hairline rounded-sm px-3 py-1.5 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-signal"
                  />
                  <input
                    value={numericDraftTolerance[activeQuestion.id] ?? (activeQuestion.tolerance != null ? String(activeQuestion.tolerance) : '')}
                    onChange={(e) => setNumericDraftTolerance((d) => ({ ...d, [activeQuestion.id]: e.target.value }))}
                    onBlur={() => {
                      const raw = (numericDraftTolerance[activeQuestion.id] ?? (activeQuestion.tolerance != null ? String(activeQuestion.tolerance) : '')).trim()
                      const newTol = raw ? parseFloat(raw) : null
                      if (newTol === activeQuestion.tolerance) return
                      setCorrectAnswerMutation.mutate({ questionId: activeQuestion.id, tolerance: newTol })
                    }}
                    placeholder="± tolerance"
                    className="w-28 border border-hairline rounded-sm px-3 py-1.5 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-signal"
                  />
                  <input
                    value={numericDraftUnit[activeQuestion.id] ?? activeQuestion.unit ?? ''}
                    onChange={(e) => setNumericDraftUnit((d) => ({ ...d, [activeQuestion.id]: e.target.value }))}
                    onBlur={() => {
                      const val = (numericDraftUnit[activeQuestion.id] ?? activeQuestion.unit ?? '').trim()
                      if (val === (activeQuestion.unit ?? '')) return
                      setCorrectAnswerMutation.mutate({ questionId: activeQuestion.id, unit: val || null })
                    }}
                    placeholder="Unit (optional)"
                    className="w-32 border border-hairline rounded-sm px-3 py-1.5 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-signal"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Responses summary chart */}
          <ResultsSummary question={activeQuestion} />

          {/* Score summary line */}
          {activeQuestion.responses.length > 0 && (() => {
            const scores = activeQuestion.responses.map((r) => calcResponseScore(activeQuestion, r)).filter((s): s is number => s !== null)
            const avg = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null
            return (
              <div className="flex items-center justify-between mb-4">
                <p className="text-xs text-muted font-mono">
                  {avg !== null
                    ? <>{scores.length} of {activeQuestion.responses.length} scored — avg <span className="font-medium text-ink-2">{avg.toFixed(2)} / 1.0</span></>
                    : <span className="text-hairline-strong">{activeQuestion.responses.length} response{activeQuestion.responses.length !== 1 ? 's' : ''}</span>
                  }
                </p>
                <button
                  onClick={() => {
                    const alreadyFull = activeQuestion.responses.every(r => r.aiScore === 1.0)
                    if (alreadyFull || window.confirm(`Give all ${activeQuestion.responses.length} responses full credit?`))
                      fullCreditMutation.mutate(activeQuestion.id)
                  }}
                  disabled={fullCreditMutation.isPending}
                  className="flex items-center gap-1 text-xs text-muted hover:text-good border border-hairline hover:border-good/30 px-2.5 py-1 rounded-sm transition-colors disabled:opacity-50"
                >
                  <Check size={11} /> Give all full credit
                </button>
              </div>
            )
          })()}

          {/* AI summary + grade buttons for free text */}
          {activeQuestion.type === 'FREE_TEXT' && activeQuestion.responses.length > 0 && (
            <div className="mb-5">
              {(hasBeenRun || data.status === SessionStatus.ARCHIVED) && (
                <button
                  onClick={() => {
                    const alreadyGraded = activeQuestion.responses.filter(r => r.aiScore !== null).length
                    if (alreadyGraded > 0 && !window.confirm(
                      `${alreadyGraded} response${alreadyGraded !== 1 ? 's' : ''} already have AI scores (including any manual edits). Re-grading will overwrite them. Continue?`
                    )) return
                    gradeMutation.mutate(activeQuestion.id)
                  }}
                  disabled={gradeMutation.isPending}
                  className="flex items-center gap-1.5 text-sm text-good border border-good/20 px-3 py-2 rounded-sm hover:bg-good-soft disabled:opacity-50 mb-2 transition-colors"
                >
                  <GraduationCap size={14} />
                  {gradeMutation.isPending ? 'Grading…' : 'Grade with AI'}
                </button>
              )}
              {summaryQuestionId !== activeQuestion.id || !summary ? (
                <button
                  onClick={() => {
                    setSummary(null)
                    setSummaryQuestionId(null)
                    summarizeMutation.mutate(activeQuestion.id)
                  }}
                  disabled={summarizeMutation.isPending}
                  className="flex items-center gap-1.5 text-sm text-signal border border-signal/20 px-3 py-2 rounded-sm hover:bg-signal-soft disabled:opacity-50 transition-colors"
                >
                  <Sparkles size={14} />
                  {summarizeMutation.isPending ? 'Summarizing…' : 'Summarize responses'}
                </button>
              ) : (
                <Card className="p-5">
                  <div className="flex items-center justify-between mb-4">
                    <p className="text-sm font-semibold text-ink-2 flex items-center gap-1.5">
                      <Sparkles size={14} className="text-signal" /> AI Theme Summary
                    </p>
                    <button
                      onClick={() => { setSummary(null); setSummaryQuestionId(null) }}
                      className="text-xs text-muted hover:text-ink transition-colors"
                    >
                      Dismiss
                    </button>
                  </div>
                  <div className="space-y-3">
                    {summary.map((cat) => (
                      <div key={cat.label} className="flex items-start gap-3">
                        <span className="shrink-0 bg-signal-soft text-signal text-xs font-semibold px-2 py-0.5 rounded-full mt-0.5 font-mono">
                          {cat.count}
                        </span>
                        <div>
                          <p className="text-sm font-medium text-ink">{cat.label}</p>
                          <p className="text-xs text-muted">{cat.description}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                  {summarizeMutation.isError && (
                    <p className="text-xs text-red-500 mt-3">Failed to summarize — try again.</p>
                  )}
                </Card>
              )}
              {summarizeMutation.isError && !summary && (
                <p className="text-xs text-red-500 mt-2">Failed to summarize — try again.</p>
              )}
            </div>
          )}
          {gradeMutation.isError && (
            <p className="text-xs text-red-500 mb-3">AI grading failed — try again.</p>
          )}

          {/* Response list */}
          {activeQuestion.responses.length === 0 ? (
            <Empty message="No responses yet" />
          ) : (
            <div className="space-y-3">
              {activeQuestion.responses.map((r) => (
                <div
                  key={r.id}
                  className={`border rounded-[14px] p-4 ${r.isFlagged ? 'border-warn/20 bg-warn-soft' : 'bg-surface border-hairline'}`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-medium text-ink">{r.student.netId}</span>
                    <div className="flex items-center gap-2">
                      {r.isFlagged && (
                        <span className="flex items-center gap-1 text-xs text-warn bg-warn-soft px-2 py-0.5 rounded-full border border-warn/20">
                          <Flag size={10} /> Short
                        </span>
                      )}
                      {activeQuestion.type === 'FREE_TEXT' && (
                        <span className="text-xs text-muted font-mono">{r.wordCount}w</span>
                      )}
                      <span className="text-xs text-hairline-strong font-mono">
                        {new Date(r.submittedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      {(() => {
                        const score = calcResponseScore(activeQuestion, r)
                        if (score === null) return null
                        const label = score === 1.0 ? '1.0' : score === 0.5 ? '0.5' : '0'
                        const color = score === 1.0
                          ? 'bg-good-soft text-good border-good/20'
                          : score === 0.5
                          ? 'bg-warn-soft text-warn border-warn/20'
                          : 'bg-red-100 text-red-600 border-red-200'
                        const title = gradeReasons[r.id] || 'Click to cycle score'
                        return (
                          <button
                            title={title}
                            onClick={() => overrideScoreMutation.mutate({
                              questionId: activeQuestion.id,
                              responseId: r.id,
                              aiScore: cycleScore(score),
                            })}
                            className={`text-xs font-mono font-medium px-2 py-0.5 rounded-full border ${color} cursor-pointer hover:opacity-80`}
                          >
                            {label} pt
                          </button>
                        )
                      })()}
                    </div>
                  </div>
                  <p className="text-ink-2 text-sm leading-relaxed">{r.responseText}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Add question modal */}
      {showAddQuestion && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
          <Card flat className="w-full max-w-md p-6 shadow-pop">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-base font-semibold text-ink">Add question</h2>
              <button onClick={() => setShowAddQuestion(false)} className="text-muted hover:text-ink-2 transition-colors"><X size={18} /></button>
            </div>
            <div className="space-y-4">
              <input
                autoFocus
                value={aqText}
                onChange={(e) => setAqText(e.target.value)}
                placeholder="Question text…"
                className="w-full border border-hairline rounded-sm px-3 py-2.5 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-signal"
              />
              <select
                value={aqType}
                onChange={(e) => setAqType(e.target.value as typeof aqType)}
                className="w-full border border-hairline rounded-sm px-3 py-2.5 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-signal"
              >
                <option value="FREE_TEXT">Free text</option>
                <option value="MULTIPLE_CHOICE">Multiple choice</option>
                <option value="MULTI_SELECT">Multi-select</option>
                <option value="ORDERING">Ordering</option>
                <option value="NUMERIC">Numeric</option>
                <option value="STRUCTURE">Structure drawing</option>
                <option value="RATING">Rating (1–5)</option>
                <option value="YES_NO">Yes / No</option>
              </select>
              {(aqType === 'MULTIPLE_CHOICE' || aqType === 'MULTI_SELECT') && (
                <textarea
                  rows={3}
                  value={aqOptions}
                  onChange={(e) => setAqOptions(e.target.value)}
                  placeholder={"Option A\nOption B\nOption C"}
                  className="w-full border border-hairline rounded-sm px-3 py-2 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-signal resize-none"
                />
              )}
              {aqType === 'ORDERING' && (
                <textarea
                  rows={3}
                  value={aqOptions}
                  onChange={(e) => setAqOptions(e.target.value)}
                  placeholder={"Step 1\nStep 2\nStep 3"}
                  className="w-full border border-hairline rounded-sm px-3 py-2 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-signal resize-none"
                />
              )}
              {aqType === 'NUMERIC' && (
                <div className="flex gap-2 flex-wrap">
                  <input value={aqNumericAnswer} onChange={(e) => setAqNumericAnswer(e.target.value)}
                    placeholder="Correct answer (optional)"
                    className="flex-1 min-w-0 border border-hairline rounded-sm px-3 py-2 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-signal" />
                  <input value={aqTolerance} onChange={(e) => setAqTolerance(e.target.value)}
                    placeholder="± tolerance"
                    className="w-28 border border-hairline rounded-sm px-3 py-2 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-signal" />
                  <input value={aqUnit} onChange={(e) => setAqUnit(e.target.value)}
                    placeholder="Unit (optional)"
                    className="w-32 border border-hairline rounded-sm px-3 py-2 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-signal" />
                </div>
              )}
              {aqError && <p className="text-red-500 text-xs">{aqError}</p>}
              <div className="flex justify-end gap-3 pt-1">
                <button onClick={() => setShowAddQuestion(false)} className="px-4 py-2 text-sm text-muted hover:text-ink transition-colors">Cancel</button>
                <Button
                  variant="primary"
                  onClick={() => addQuestionMutation.mutate()}
                  disabled={!aqText.trim() || addQuestionMutation.isPending}
                >
                  {addQuestionMutation.isPending ? 'Adding…' : 'Add question'}
                </Button>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* Edit question modal */}
      {showEditQuestion && eqId && (() => {
        const question = data.questions.find(q => q.id === eqId)
        if (!question) return null
        const hasOptions = ['MULTIPLE_CHOICE', 'MULTI_SELECT', 'ORDERING'].includes(question.type)
        return (
          <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
            <Card flat className="w-full max-w-md p-6 shadow-pop">
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-base font-semibold text-ink">Edit question</h2>
                <button onClick={() => setShowEditQuestion(false)} className="text-muted hover:text-ink-2 transition-colors"><X size={18} /></button>
              </div>
              <div className="space-y-4">
                <input
                  autoFocus
                  value={eqText}
                  onChange={(e) => setEqText(e.target.value)}
                  placeholder="Question text…"
                  className="w-full border border-hairline rounded-sm px-3 py-2.5 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-signal"
                />
                {hasOptions && (
                  <div className="space-y-2">
                    <p className="text-xs text-muted font-medium">Options</p>
                    {eqOptions.map((opt, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <input
                          value={opt}
                          onChange={(e) => { const next = [...eqOptions]; next[i] = e.target.value; setEqOptions(next) }}
                          className="flex-1 border border-hairline rounded-sm px-3 py-2 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-signal"
                          placeholder={`Option ${i + 1}`}
                        />
                        <button
                          onClick={() => setEqOptions(eqOptions.filter((_, j) => j !== i))}
                          className="text-hairline-strong hover:text-red-400 transition-colors"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    ))}
                    <button
                      onClick={() => setEqOptions([...eqOptions, ''])}
                      className="flex items-center gap-1 text-xs text-signal hover:text-[var(--signal-bright)] mt-1 transition-colors"
                    >
                      <Plus size={12} /> Add option
                    </button>
                  </div>
                )}
                {question.type === 'NUMERIC' && (
                  <div className="flex gap-2 flex-wrap">
                    <input
                      value={eqCorrectAnswer}
                      onChange={(e) => setEqCorrectAnswer(e.target.value)}
                      placeholder="Correct answer (optional)"
                      className="flex-1 min-w-0 border border-hairline rounded-sm px-3 py-2 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-signal"
                    />
                    <input
                      value={eqTolerance}
                      onChange={(e) => setEqTolerance(e.target.value)}
                      placeholder="± tolerance"
                      className="w-28 border border-hairline rounded-sm px-3 py-2 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-signal"
                    />
                    <input
                      value={eqUnit}
                      onChange={(e) => setEqUnit(e.target.value)}
                      placeholder="Unit (optional)"
                      className="w-32 border border-hairline rounded-sm px-3 py-2 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-signal"
                    />
                  </div>
                )}
                {eqError && <p className="text-red-500 text-xs">{eqError}</p>}
                <div className="flex justify-end gap-3 pt-1">
                  <button onClick={() => setShowEditQuestion(false)} className="px-4 py-2 text-sm text-muted hover:text-ink transition-colors">Cancel</button>
                  <Button
                    variant="primary"
                    onClick={() => editQuestionMutation.mutate()}
                    disabled={!eqText.trim() || (hasOptions && eqOptions.filter(o => o.trim()).length < 2) || editQuestionMutation.isPending}
                  >
                    {editQuestionMutation.isPending ? 'Saving…' : 'Save changes'}
                  </Button>
                </div>
              </div>
            </Card>
          </div>
        )
      })()}

      {/* PiP portal */}
      {pipContainer && data && pipActiveTab !== null &&
        createPortal(
          <LiveMonitorPanel
            question={data.questions[pipActiveTab] as QuestionWithResponses}
            questionNumber={pipActiveTab + 1}
            totalQuestions={data.questions.length}
            sessionTitle={data.title}
            enrolledCount={data.enrolledCount ?? 0}
            summary={summary}
            summaryQuestionId={summaryQuestionId}
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
