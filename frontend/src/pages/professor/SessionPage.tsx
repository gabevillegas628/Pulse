import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/api/client'
import ProfessorLayout from '@/components/layout/ProfessorLayout'
import { Check, ChevronLeft, Copy, Download, Flag, GraduationCap, PictureInPicture2, Plus, Sparkles, X } from 'lucide-react'
import { io } from 'socket.io-client'
import type { SessionDetail, QuestionWithResponses, ResponseWithStudent, SummaryCategory } from 'shared'
import { SessionStatus } from 'shared'
import ResultsSummary from '@/components/ResultsSummary'
import PipDisplay from '@/components/PipDisplay'
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
    ctx.fillStyle = '#1d4ed8'
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
  const [aqType, setAqType] = useState<'FREE_TEXT' | 'MULTIPLE_CHOICE' | 'RATING' | 'YES_NO'>('FREE_TEXT')
  const [aqOptions, setAqOptions] = useState('')
  const [aqError, setAqError] = useState('')

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
      options: aqType === 'MULTIPLE_CHOICE' ? aqOptions.split('\n').map(s => s.trim()).filter(Boolean) : undefined,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['session', sessionId] })
      setShowAddQuestion(false)
      setAqText(''); setAqType('FREE_TEXT'); setAqOptions(''); setAqError('')
    },
    onError: (e: unknown) => {
            setAqError(apiError(e, 'Failed to add question'))
    },
  })

  const [pipActiveTab, setPipActiveTab] = useState<number | null>(null)
  const [pipContainer, setPipContainer] = useState<HTMLElement | null>(null)
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

  // gradeReasons maps responseId → AI reason string for tooltip
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
    mutationFn: ({ questionId, correctAnswer }: { questionId: string; correctAnswer: string | null }) =>
      api.patch(`/sessions/${sessionId}/questions/${questionId}`, { correctAnswer }),
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

  function cycleScore(current: number | null): number {
    if (current === null || current === 1.0) return 0
    if (current === 0) return 0.5
    return 1.0
  }

  function calcResponseScore(q: { type: string; correctAnswer: string | null }, r: { responseText: string; aiScore: number | null }): number | null {
    if (q.type === 'MULTIPLE_CHOICE' || q.type === 'YES_NO') {
      if (!q.correctAnswer) return null
      return r.responseText === q.correctAnswer ? 1.0 : 0.5
    }
    if (q.type === 'FREE_TEXT') return r.aiScore
    return null // RATING — no per-response score shown
  }

  const statusMutation = useMutation({
    mutationFn: (status: SessionStatus) => api.patch(`/sessions/${sessionId}`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['session', sessionId] }),
  })

  // Opens the session and optionally sets the target section in one request
  const openSessionMutation = useMutation({
    mutationFn: (targetSectionId: string | null) =>
      api.patch(`/sessions/${sessionId}`, { status: SessionStatus.OPEN, targetSectionId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['session', sessionId] })
      setShowSectionModal(false)
    },
  })

  const sectionMutation = useMutation({
    mutationFn: (targetSectionId: string | null) =>
      api.patch(`/sessions/${sessionId}`, { targetSectionId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['session', sessionId] }),
  })

  // Seed seen questions from existing responses when data first loads (e.g. page refresh mid-session)
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
      // Auto-advance PiP on first response for each new question; never go back
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

    socket.on('session_status', ({ status }: { status: SessionStatus }) => {
      qc.setQueryData<SessionDetail>(['session', sessionId], (prev) =>
        prev ? { ...prev, status } : prev
      )
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
      // Copy all stylesheets into the PiP window so Tailwind classes render correctly
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
      setPipContainer(container)
      pip.addEventListener('pagehide', () => setPipContainer(null))
    } catch (err) {
      console.error('PiP failed:', err)
    }
  }

  if (isLoading || !data) return <ProfessorLayout><p className="text-gray-400">Loading…</p></ProfessorLayout>

  const totalResponses = data.questions.reduce((sum, q) => sum + q.responses.length, 0)
  const activeQuestion = data.questions[activeTab] as QuestionWithResponses | undefined

  return (
    <ProfessorLayout>
      {/* Header */}
      <div className="mb-6">
        <Link to={`/professor/classes/${data.class.id}`} className="flex items-center gap-1 text-sm text-gray-400 hover:text-gray-600 mb-3">
          <ChevronLeft size={16} /> {data.class.name}
        </Link>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{data.title}</h1>
            <p className="text-sm text-gray-500 mt-1">{totalResponses} response{totalResponses !== 1 ? 's' : ''}</p>
            {sectionsData && sectionsData.length > 0 && (data.status === SessionStatus.DRAFT || data.status === SessionStatus.CLOSED) && (
              <div className="flex items-center gap-2 mt-2">
                <span className="text-xs text-gray-400">Section:</span>
                <select
                  value={(data as unknown as { targetSection?: { id: string } }).targetSection?.id ?? ''}
                  onChange={(e) => sectionMutation.mutate(e.target.value || null)}
                  disabled={sectionMutation.isPending}
                  className="text-xs border border-gray-200 rounded px-2 py-1 bg-white text-gray-700 focus:outline-none focus:ring-1 focus:ring-primary-500"
                >
                  <option value="">All sections</option>
                  {sectionsData.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={openPip}
              disabled={!!pipContainer}
              className="flex items-center gap-1.5 border border-gray-200 text-gray-600 px-3 py-2 rounded-lg text-sm hover:bg-gray-50 disabled:opacity-40"
              title={pipContainer ? 'Results window is open' : 'Pop out live results'}
            >
              <PictureInPicture2 size={14} /> {pipContainer ? 'Live' : 'Pop out'}
            </button>
            <a
              href={`/api/sessions/${sessionId}/export`}
              className="flex items-center gap-1.5 border border-gray-200 text-gray-600 px-3 py-2 rounded-lg text-sm hover:bg-gray-50"
            >
              <Download size={14} /> Export CSV
            </a>
            {data.status === SessionStatus.DRAFT ? (
              <button
                onClick={() => {
                  if (sectionsData && sectionsData.length > 1) {
                    setShowSectionModal(true)
                  } else {
                    statusMutation.mutate(SessionStatus.OPEN)
                  }
                }}
                disabled={statusMutation.isPending}
                className="bg-primary-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50"
              >
                Open session
              </button>
            ) : data.status === SessionStatus.OPEN ? (
              <button
                onClick={() => statusMutation.mutate(SessionStatus.CLOSED)}
                disabled={statusMutation.isPending}
                className="bg-red-50 text-red-600 border border-red-200 px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-100 disabled:opacity-50"
              >
                Close session
              </button>
            ) : data.status === SessionStatus.CLOSED ? (
              <div className="flex gap-2">
                <button
                  onClick={() => statusMutation.mutate(SessionStatus.OPEN)}
                  disabled={statusMutation.isPending}
                  className="bg-green-50 text-green-700 border border-green-200 px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-100 disabled:opacity-50"
                >
                  Reopen
                </button>
                <button
                  onClick={() => statusMutation.mutate(SessionStatus.ARCHIVED)}
                  disabled={statusMutation.isPending}
                  className="text-gray-400 border border-gray-200 px-4 py-2 rounded-lg text-sm hover:bg-gray-50 disabled:opacity-50"
                >
                  Archive
                </button>
              </div>
            ) : (
              <span className="text-xs text-gray-400 border border-gray-200 px-3 py-2 rounded-lg">Archived</span>
            )}
          </div>
        </div>
      </div>

      {/* Question tabs */}
      <div className="flex items-center gap-1 mb-6 border-b border-gray-200">
        {data.questions.map((q, i) => (
          <div key={q.id} className="group relative flex items-center">
            <button
              onClick={() => setActiveTab(i)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                activeTab === i
                  ? 'border-primary-600 text-primary-700'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              Q{i + 1}
            </button>
            {data.status === SessionStatus.DRAFT && (
              <button
                onClick={() => {
                  if (!confirm(`Delete Q${i + 1}? This cannot be undone.`)) return
                  deleteQuestionMutation.mutate(q.id)
                }}
                disabled={deleteQuestionMutation.isPending}
                className="opacity-0 group-hover:opacity-100 transition-opacity absolute -top-1 -right-1 w-4 h-4 flex items-center justify-center bg-white border border-gray-200 rounded-full text-gray-300 hover:text-red-500 hover:border-red-300 disabled:opacity-30"
                title="Delete question"
              >
                <X size={9} />
              </button>
            )}
          </div>
        ))}
        <button
          onClick={() => setShowAddQuestion(true)}
          className="ml-1 mb-px flex items-center gap-1 text-xs text-gray-400 hover:text-primary-600 px-2 py-1.5"
          title="Add question"
        >
          <Plus size={13} /> Add
        </button>
      </div>

      {activeQuestion && (
        <div>
          {/* Question header with code + QR */}
          <div className="bg-primary-50 border border-primary-100 rounded-xl p-4 mb-5">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <p className="text-xs text-primary-500 font-medium mb-1 uppercase tracking-wide">Question</p>
                <p className="text-gray-800 font-medium">{activeQuestion.text}</p>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                {/* Access code */}
                <div className="text-center">
                  <p className="text-xs text-primary-400 mb-0.5">Code</p>
                  <p className="font-mono text-2xl font-bold text-primary-700 tracking-widest">{activeQuestion.accessCode}</p>
                </div>
                {/* QR toggle + copy */}
                {'qrDataUrl' in activeQuestion && (activeQuestion as QuestionWithResponses & { qrDataUrl: string }).qrDataUrl && (
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => setExpandedQr(expandedQr === activeQuestion.id ? null : activeQuestion.id)}
                      className="border border-primary-200 rounded-lg p-1.5 hover:bg-primary-100 transition-colors"
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
                      className="border border-primary-200 rounded-lg p-1.5 hover:bg-primary-100 transition-colors"
                      title="Copy QR + code as image"
                    >
                      {copiedQrId === activeQuestion.id
                        ? <Check size={16} className="text-green-600" />
                        : <Copy size={16} className="text-primary-500" />
                      }
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Rubric hint — FREE_TEXT, closed sessions only */}
          {(data.status === SessionStatus.CLOSED || data.status === SessionStatus.ARCHIVED) &&
            activeQuestion.type === 'FREE_TEXT' && (
            <div className="mt-3 pt-3 border-t border-primary-100">
              <p className="text-xs text-primary-500 font-medium mb-1.5">What were you looking for? <span className="text-primary-300 font-normal">(optional — helps AI grade more accurately)</span></p>
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
                  className="flex-1 border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>
            </div>
          )}

          {/* Mark correct answer — MCQ / YES_NO, closed sessions only */}
          {(data.status === SessionStatus.CLOSED || data.status === SessionStatus.ARCHIVED) &&
            (activeQuestion.type === 'MULTIPLE_CHOICE' || activeQuestion.type === 'YES_NO') && (
            <div className="mt-3 pt-3 border-t border-primary-100">
              <p className="text-xs text-primary-500 font-medium mb-2">Correct answer</p>
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
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                        isCorrect
                          ? 'bg-green-50 border-green-300 text-green-700 font-medium'
                          : 'bg-white border-gray-200 text-gray-600 hover:border-green-300 hover:text-green-700'
                      }`}
                    >
                      {isCorrect && <Check size={12} />} {opt}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* Responses */}
          <ResultsSummary question={activeQuestion} />

          {/* Score summary line */}
          {activeQuestion.responses.length > 0 && (activeQuestion.type === 'MULTIPLE_CHOICE' || activeQuestion.type === 'YES_NO' || activeQuestion.type === 'FREE_TEXT') && (() => {
            const scores = activeQuestion.responses.map((r) => calcResponseScore(activeQuestion, r)).filter((s): s is number => s !== null)
            if (scores.length === 0) return null
            const avg = scores.reduce((a, b) => a + b, 0) / scores.length
            return (
              <p className="text-xs text-gray-400 mb-4">
                {scores.length} of {activeQuestion.responses.length} scored — avg <span className="font-medium text-gray-600">{avg.toFixed(2)} / 1.0</span>
              </p>
            )
          })()}

          {/* AI summary + grade buttons for free text */}
          {activeQuestion.type === 'FREE_TEXT' && activeQuestion.responses.length > 0 && (
            <div className="mb-5">
              {(data.status === SessionStatus.CLOSED || data.status === SessionStatus.ARCHIVED) && (
                <button
                  onClick={() => {
                    const alreadyGraded = activeQuestion.responses.filter(r => r.aiScore !== null).length
                    if (alreadyGraded > 0 && !window.confirm(
                      `${alreadyGraded} response${alreadyGraded !== 1 ? 's' : ''} already have AI scores (including any manual edits). Re-grading will overwrite them. Continue?`
                    )) return
                    gradeMutation.mutate(activeQuestion.id)
                  }}
                  disabled={gradeMutation.isPending}
                  className="flex items-center gap-1.5 text-sm text-green-700 border border-green-200 px-3 py-2 rounded-lg hover:bg-green-50 disabled:opacity-50 mb-2"
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
                  className="flex items-center gap-1.5 text-sm text-primary-600 border border-primary-200 px-3 py-2 rounded-lg hover:bg-primary-50 disabled:opacity-50"
                >
                  <Sparkles size={14} />
                  {summarizeMutation.isPending ? 'Summarizing…' : 'Summarize responses'}
                </button>
              ) : (
                <div className="bg-white border border-gray-200 rounded-xl p-5">
                  <div className="flex items-center justify-between mb-4">
                    <p className="text-sm font-semibold text-gray-700 flex items-center gap-1.5">
                      <Sparkles size={14} className="text-primary-500" /> AI Theme Summary
                    </p>
                    <button
                      onClick={() => { setSummary(null); setSummaryQuestionId(null) }}
                      className="text-xs text-gray-400 hover:text-gray-600"
                    >
                      Dismiss
                    </button>
                  </div>
                  <div className="space-y-3">
                    {summary.map((cat) => (
                      <div key={cat.label} className="flex items-start gap-3">
                        <span className="shrink-0 bg-primary-100 text-primary-700 text-xs font-semibold px-2 py-0.5 rounded-full mt-0.5">
                          {cat.count}
                        </span>
                        <div>
                          <p className="text-sm font-medium text-gray-800">{cat.label}</p>
                          <p className="text-xs text-gray-500">{cat.description}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                  {summarizeMutation.isError && (
                    <p className="text-xs text-red-500 mt-3">Failed to summarize — try again.</p>
                  )}
                </div>
              )}
              {summarizeMutation.isError && !summary && (
                <p className="text-xs text-red-500 mt-2">Failed to summarize — try again.</p>
              )}
            </div>
          )}
          {gradeMutation.isError && (
            <p className="text-xs text-red-500 mb-3">AI grading failed — try again.</p>
          )}

          {activeQuestion.responses.length === 0 ? (
            <p className="text-gray-400 text-center py-12 text-sm">No responses yet</p>
          ) : (
            <div className="space-y-3">
              {activeQuestion.responses.map((r) => (
                <div
                  key={r.id}
                  className={`bg-white border rounded-xl p-4 ${r.isFlagged ? 'border-yellow-200 bg-yellow-50' : 'border-gray-200'}`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-800">{r.student.netId}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {r.isFlagged && (
                        <span className="flex items-center gap-1 text-xs text-yellow-600 bg-yellow-100 px-2 py-0.5 rounded-full">
                          <Flag size={10} /> Short
                        </span>
                      )}
                      {activeQuestion.type === 'FREE_TEXT' && (
                        <span className="text-xs text-gray-400">{r.wordCount}w</span>
                      )}
                      <span className="text-xs text-gray-300">
                        {new Date(r.submittedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      {/* Score chip */}
                      {(() => {
                        const score = calcResponseScore(activeQuestion, r)
                        const isFreeText = activeQuestion.type === 'FREE_TEXT'
                        if (score === null) return null
                        const label = score === 1.0 ? '1.0' : score === 0.5 ? '0.5' : '0'
                        const color = score === 1.0
                          ? 'bg-green-100 text-green-700 border-green-200'
                          : score === 0.5
                          ? 'bg-yellow-100 text-yellow-700 border-yellow-200'
                          : 'bg-red-100 text-red-600 border-red-200'
                        const title = isFreeText && gradeReasons[r.id] ? gradeReasons[r.id] : undefined
                        return (
                          <button
                            title={title}
                            onClick={isFreeText ? () => overrideScoreMutation.mutate({
                              questionId: activeQuestion.id,
                              responseId: r.id,
                              aiScore: cycleScore(r.aiScore),
                            }) : undefined}
                            className={`text-xs font-medium px-2 py-0.5 rounded-full border ${color} ${isFreeText ? 'cursor-pointer hover:opacity-80' : 'cursor-default'}`}
                          >
                            {label} pt
                          </button>
                        )
                      })()}
                    </div>
                  </div>
                  <p className="text-gray-700 text-sm leading-relaxed">{r.responseText}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Add question modal */}
      {showAddQuestion && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-base font-semibold">Add question</h2>
              <button onClick={() => setShowAddQuestion(false)}><X size={18} className="text-gray-400" /></button>
            </div>
            <div className="space-y-4">
              <input
                autoFocus
                value={aqText}
                onChange={(e) => setAqText(e.target.value)}
                placeholder="Question text…"
                className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
              <select
                value={aqType}
                onChange={(e) => setAqType(e.target.value as typeof aqType)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white"
              >
                <option value="FREE_TEXT">Free text</option>
                <option value="MULTIPLE_CHOICE">Multiple choice</option>
                <option value="RATING">Rating (1–5)</option>
                <option value="YES_NO">Yes / No</option>
              </select>
              {aqType === 'MULTIPLE_CHOICE' && (
                <textarea
                  rows={3}
                  value={aqOptions}
                  onChange={(e) => setAqOptions(e.target.value)}
                  placeholder={"Option A\nOption B\nOption C"}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none"
                />
              )}
              {aqError && <p className="text-red-500 text-xs">{aqError}</p>}
              <div className="flex justify-end gap-3 pt-1">
                <button onClick={() => setShowAddQuestion(false)} className="px-4 py-2 text-sm text-gray-600">Cancel</button>
                <button
                  onClick={() => addQuestionMutation.mutate()}
                  disabled={!aqText.trim() || addQuestionMutation.isPending}
                  className="px-5 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50"
                >
                  {addQuestionMutation.isPending ? 'Adding…' : 'Add question'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* PiP portal — renders live results into the floating window */}
      {pipContainer && data && pipActiveTab !== null &&
        createPortal(
          <PipDisplay
            question={data.questions[pipActiveTab] as QuestionWithResponses}
            questionNumber={pipActiveTab + 1}
            totalQuestions={data.questions.length}
            sessionTitle={data.title}
          />,
          pipContainer
        )
      }

      {/* Section picker modal — shown when opening a session with multiple sections */}
      {showSectionModal && sectionsData && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-base font-semibold text-gray-900">Open for which section?</h2>
              <button onClick={() => setShowSectionModal(false)}>
                <X size={18} className="text-gray-400" />
              </button>
            </div>
            <p className="text-sm text-gray-500 mb-5">
              Only students in the selected section will be able to respond.
            </p>
            <div className="space-y-2">
              {sectionsData.map((s) => (
                <button
                  key={s.id}
                  onClick={() => openSessionMutation.mutate(s.id)}
                  disabled={openSessionMutation.isPending}
                  className="w-full text-left px-4 py-3 rounded-xl border border-gray-200 hover:border-primary-400 hover:bg-primary-50 transition-colors text-sm font-medium text-gray-800 disabled:opacity-50"
                >
                  Section {s.name}
                </button>
              ))}
              <button
                onClick={() => openSessionMutation.mutate(null)}
                disabled={openSessionMutation.isPending}
                className="w-full text-left px-4 py-3 rounded-xl border border-gray-200 hover:border-gray-400 hover:bg-gray-50 transition-colors text-sm text-gray-500 disabled:opacity-50"
              >
                All sections
              </button>
            </div>
          </div>
        </div>
      )}

      {/* QR fullscreen overlay */}
      {expandedQr && activeQuestion && 'qrDataUrl' in activeQuestion && (
        <div
          className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 cursor-pointer"
          onClick={() => setExpandedQr(null)}
        >
          <div className="bg-white rounded-2xl p-8 text-center">
            <img
              src={(activeQuestion as QuestionWithResponses & { qrDataUrl: string }).qrDataUrl}
              alt="QR Code"
              className="w-64 h-64"
            />
            <p className="text-gray-500 text-sm mt-3">Scan to answer this question</p>
            <p className="font-mono text-3xl font-bold text-gray-900 tracking-widest mt-1">{activeQuestion.accessCode}</p>
            <p className="text-xs text-gray-400 mt-4">Click anywhere to close</p>
          </div>
        </div>
      )}
    </ProfessorLayout>
  )
}
