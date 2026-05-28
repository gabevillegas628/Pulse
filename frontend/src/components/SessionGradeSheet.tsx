import { useQuery } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { X } from 'lucide-react'
import { api } from '@/api/client'
import type { GradeSession, GradeSessionDetail, GradeQuestion } from 'shared'

interface Props {
  session: GradeSession
  onClose: () => void
}

function scoreChip(score: number) {
  const color =
    score >= 1.0 ? 'bg-green-100 text-green-700 border-green-200'
    : score >= 0.5 ? 'bg-yellow-100 text-yellow-700 border-yellow-200'
    : 'bg-red-100 text-red-600 border-red-200'
  return (
    <span className={`shrink-0 text-xs font-medium px-2 py-0.5 rounded-full border ${color}`}>
      {score.toFixed(1)}
    </span>
  )
}

function QuestionBlock({ q, index }: { q: GradeQuestion; index: number }) {
  const isWrong =
    q.correctAnswer !== null &&
    (q.type === 'MULTIPLE_CHOICE' || q.type === 'YES_NO') &&
    q.response?.responseText !== q.correctAnswer

  return (
    <div className="space-y-1.5 py-4 border-b border-gray-100 last:border-0">
      <div className="flex items-start gap-2">
        <span className="shrink-0 text-xs font-semibold text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded mt-0.5">
          Q{index + 1}
        </span>
        <p className="text-sm text-gray-700 leading-snug">{q.text}</p>
      </div>

      {q.response ? (
        <div className="ml-7 space-y-1">
          <div className="flex items-start justify-between gap-3">
            <p className="text-sm text-gray-900 leading-relaxed flex-1">{q.response.responseText}</p>
            {scoreChip(q.score)}
          </div>
          {isWrong && (
            <p className="text-xs text-gray-400">
              Correct: <span className="text-gray-600 font-medium">{q.correctAnswer}</span>
            </p>
          )}
        </div>
      ) : (
        <p className="ml-7 text-sm text-gray-300 italic">No response</p>
      )}
    </div>
  )
}


export default function SessionGradeSheet({ session, onClose }: Props) {
  const { data, isLoading } = useQuery<GradeSessionDetail>({
    queryKey: ['student-session-grades', session.id],
    queryFn: () => api.get(`/student/sessions/${session.id}/grades`).then((r) => r.data.data.session),
  })

  const touchStartY = useRef(0)
  const touchStartTime = useRef(0)
  const touchCurrentY = useRef(0)
  const [dragY, setDragY] = useState(0)
  const [isDragging, setIsDragging] = useState(false)

  const dismiss = () => {
    setDragY(window.innerHeight)
    setTimeout(onClose, 280)
  }

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartY.current = e.touches[0].clientY
    touchStartTime.current = Date.now()
    setIsDragging(true)
  }
  const handleTouchMove = (e: React.TouchEvent) => {
    const clientY = e.touches[0].clientY
    touchCurrentY.current = clientY
    const delta = clientY - touchStartY.current
    if (delta > 0) setDragY(delta)
  }
  const handleTouchEnd = () => {
    setIsDragging(false)
    const velocity = dragY / (Date.now() - touchStartTime.current)
    const inBottomZone = touchCurrentY.current > window.innerHeight * 0.9
    if (velocity > 0.6 || inBottomZone) {
      dismiss()
    } else {
      setDragY(0)
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-end md:items-center justify-center px-0 md:px-4"
      onClick={dismiss}
    >
      <div
        className="w-full md:max-w-lg bg-white rounded-t-2xl md:rounded-2xl max-h-[85vh] flex flex-col"
        style={{ transform: `translateY(${dragY}px)`, transition: isDragging ? 'none' : 'transform 0.28s ease' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drag handle — mobile only */}
        <div
          className="md:hidden flex justify-center pt-3 pb-3 shrink-0 cursor-grab active:cursor-grabbing touch-none"
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        >
          <div className="w-10 h-1 rounded-full bg-gray-200" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 shrink-0">
          <div>
            <p className="font-semibold text-gray-900">{session.title}</p>
            <p className="text-xs text-gray-400 mt-0.5">
              {session.earned}/{session.max} pts · {session.type === 'IN_CLASS' ? 'Live session' : 'Homework'}
            </p>
          </div>
          <button onClick={dismiss} className="text-gray-400 hover:text-gray-600">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 px-6">
          {isLoading && <p className="text-sm text-gray-400 text-center py-10">Loading…</p>}
          {!isLoading && !data && (
            <p className="text-sm text-gray-400 text-center py-10">No data available.</p>
          )}
          {data && data.questions.length === 0 && (
            <p className="text-sm text-gray-400 text-center py-10">No questions in this session.</p>
          )}
          {data && data.questions.map((q, i) => (
            <QuestionBlock key={q.id} q={q} index={i} />
          ))}
        </div>
      </div>
    </div>
  )
}
