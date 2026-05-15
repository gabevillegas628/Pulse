import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/api/client'
import ProfessorLayout from '@/components/layout/ProfessorLayout'
import { ChevronLeft, Download, Maximize2, Flag } from 'lucide-react'
import { io } from 'socket.io-client'
import type { SessionDetail, QuestionWithResponses, ResponseWithStudent } from 'shared'
import { SessionStatus } from 'shared'

export default function SessionPage() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const qc = useQueryClient()
  const [activeTab, setActiveTab] = useState(0)
  const [showQr, setShowQr] = useState(false)

  const { data, isLoading } = useQuery<SessionDetail>({
    queryKey: ['session', sessionId],
    queryFn: () => api.get(`/sessions/${sessionId}`).then((r) => r.data.data.session),
  })

  const statusMutation = useMutation({
    mutationFn: (status: SessionStatus) => api.patch(`/sessions/${sessionId}`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['session', sessionId] }),
  })

  // Live updates via Socket.io
  useEffect(() => {
    if (!sessionId) return
    const socket = io({ path: '/socket.io' })
    socket.emit('join_session', sessionId)

    socket.on('new_response', (payload: { student: ResponseWithStudent['student']; responses: ResponseWithStudent[]; sessionId: string }) => {
      qc.setQueryData<SessionDetail>(['session', sessionId], (prev) => {
        if (!prev) return prev
        const updated = { ...prev }
        updated.questions = prev.questions.map((q) => {
          const newResp = payload.responses.find((r) => r.questionId === q.id)
          if (!newResp) return q
          return {
            ...q,
            responses: [{ ...newResp, student: payload.student }, ...q.responses],
          }
        })
        return updated
      })
    })

    socket.on('session_status', ({ status }: { status: SessionStatus }) => {
      qc.setQueryData<SessionDetail>(['session', sessionId], (prev) =>
        prev ? { ...prev, status } : prev
      )
    })

    return () => { socket.disconnect() }
  }, [sessionId, qc])

  if (isLoading || !data) return <ProfessorLayout><p className="text-gray-400">Loading…</p></ProfessorLayout>

  const totalResponses = data.questions[0]?.responses.length ?? 0
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
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => setShowQr(true)}
              className="flex items-center gap-1.5 border border-gray-200 text-gray-600 px-3 py-2 rounded-lg text-sm hover:bg-gray-50"
            >
              <Maximize2 size={14} /> QR
            </button>
            <a
              href={`/api/sessions/${sessionId}/export`}
              className="flex items-center gap-1.5 border border-gray-200 text-gray-600 px-3 py-2 rounded-lg text-sm hover:bg-gray-50"
            >
              <Download size={14} /> Export CSV
            </a>
            {data.status === SessionStatus.OPEN ? (
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
      {data.questions.length > 1 && (
        <div className="flex gap-1 mb-6 border-b border-gray-200">
          {data.questions.map((q, i) => (
            <button
              key={q.id}
              onClick={() => setActiveTab(i)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                activeTab === i
                  ? 'border-primary-600 text-primary-700'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              Q{i + 1}
            </button>
          ))}
        </div>
      )}

      {activeQuestion && (
        <div>
          <div className="bg-primary-50 border border-primary-100 rounded-xl p-4 mb-5">
            <p className="text-xs text-primary-500 font-medium mb-1 uppercase tracking-wide">Question</p>
            <p className="text-gray-800 font-medium">{activeQuestion.text}</p>
          </div>

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
                      <span className="text-xs text-gray-400">{r.student.name}</span>
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
                    </div>
                  </div>
                  <p className="text-gray-700 text-sm leading-relaxed">{r.responseText}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* QR fullscreen overlay */}
      {showQr && (
        <div
          className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 cursor-pointer"
          onClick={() => setShowQr(false)}
        >
          <div className="bg-white rounded-2xl p-8 text-center">
            <img src={data.qrDataUrl} alt="QR Code" className="w-64 h-64" />
            <p className="text-gray-500 text-sm mt-3">Scan to submit</p>
            <p className="font-mono text-2xl font-bold text-gray-900 tracking-widest mt-1">{data.accessCode}</p>
            <p className="text-xs text-gray-400 mt-4">Click anywhere to close</p>
          </div>
        </div>
      )}
    </ProfessorLayout>
  )
}
