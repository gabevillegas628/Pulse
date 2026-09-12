import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, ChevronUp, Lock } from 'lucide-react'
import { api } from '@/api/client'
import { apiError } from '@/lib/errors'
import StructureKeyField from '@/components/StructureKeyField'
import type { QuestionWithResponses } from 'shared'

/**
 * Types the backend lets a professor key while a run is open, because for these the
 * answer is authoring metadata rather than something the room is racing to guess.
 * Mirrors `bypassClosedCheck` in `questions.routes.ts` — keep the two in step.
 */
const EDITABLE_WHILE_LIVE = ['NUMERIC', 'ORDERING', 'STRUCTURE']

interface Props {
  sessionId: string
  question: QuestionWithResponses
  /** A run is open. Most types refuse a key change until it closes. */
  isLive: boolean
  /** Effective effort stance — it changes what the free-text hint asks for. */
  effortOn: boolean
}

function opts(question: QuestionWithResponses): string[] {
  return (question.options as string[] | null) ?? []
}

/** Parse a stored JSON array key, tolerating the malformed and the absent alike. */
function parseArray(stored: string | null): string[] {
  if (!stored) return []
  try {
    const arr = JSON.parse(stored)
    return Array.isArray(arr) ? arr as string[] : []
  } catch {
    return []
  }
}

const inputCls =
  'border border-hairline rounded-sm px-3 py-1.5 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-signal disabled:opacity-50'

/**
 * The one place a question's answer key is set, whatever its type.
 *
 * It used to be three separate blocks in the question header with three different gates:
 * numeric inputs always visible (and duplicated in the edit modal), multiple-choice chips
 * and the free-text rubric hidden until a run had happened, and nothing at all for
 * multi-select or ordering. The gate was also the wrong one — the backend only refuses a
 * key change *while a run is open*, so hiding it until a run had happened prevented the
 * one time you most want to set it, before class.
 *
 * Mount with `key={question.id}` — drafts are plain state seeded from props.
 */
export default function AnswerKey({ sessionId, question, isLive, effortOn }: Props) {
  const qc = useQueryClient()

  const [rubric, setRubric] = useState(question.correctAnswer ?? '')
  const [numAnswer, setNumAnswer] = useState(question.correctAnswer ?? '')
  const [numTolerance, setNumTolerance] = useState(
    question.tolerance != null ? String(question.tolerance) : '',
  )
  const [numUnit, setNumUnit] = useState(question.unit ?? '')

  const save = useMutation({
    mutationFn: (payload: { correctAnswer?: string | null; tolerance?: number | null; unit?: string | null }) =>
      api.patch(`/sessions/${sessionId}/questions/${question.id}`, payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['session', sessionId] }),
  })

  const locked = isLive && !EDITABLE_WHILE_LIVE.includes(question.type as string)

  // Rating is participation credit by design, and the backend 400s on a key for it.
  if (question.type === 'RATING') return null

  const setKey = (correctAnswer: string | null) => save.mutate({ correctAnswer })

  const isFreeText = question.type === 'FREE_TEXT'
  const hasKey = question.correctAnswer !== null && question.correctAnswer !== ''

  return (
    <div className="mt-3 pt-3 border-t border-hairline">
      <div className="flex items-center justify-between gap-3 mb-2 flex-wrap">
        <p className="text-xs text-muted font-medium">
          {isFreeText
            ? (effortOn
              ? <>What is this question about? <span className="font-normal">(optional — context only, students are not scored against it)</span></>
              : <>What were you looking for? <span className="font-normal">(optional — helps the AI grade more accurately)</span></>)
            : <>Answer key {!hasKey && <span className="font-normal">— not set, so every response earns full credit</span>}</>}
        </p>
        {locked && (
          <span className="inline-flex items-center gap-1 text-[11px] text-muted shrink-0">
            <Lock size={10} /> Close the session to change this
          </span>
        )}
      </div>

      {isFreeText && (
        <input
          value={rubric}
          disabled={locked}
          onChange={(e) => setRubric(e.target.value)}
          onBlur={() => {
            const val = rubric.trim()
            if (val === (question.correctAnswer ?? '')) return
            setKey(val || null)
          }}
          placeholder="e.g. dissipates the proton motive force, increases ETC flux"
          className={`w-full ${inputCls}`}
        />
      )}

      {(question.type === 'MULTIPLE_CHOICE' || question.type === 'YES_NO') && (
        <div className="flex flex-wrap gap-2">
          {(question.type === 'YES_NO' ? ['Yes', 'No'] : opts(question)).map((opt) => {
            const isCorrect = question.correctAnswer === opt
            return (
              <button
                key={opt}
                onClick={() => setKey(isCorrect ? null : opt)}
                disabled={save.isPending || locked}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-sm text-sm border transition-colors disabled:opacity-50 ${
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
      )}

      {question.type === 'MULTI_SELECT' && (() => {
        const selected = parseArray(question.correctAnswer)
        return (
          <div className="flex flex-col gap-1.5">
            <p className="text-[11px] text-muted">Check every option that should count as correct.</p>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {opts(question).map((opt) => {
                const isChecked = selected.includes(opt)
                return (
                  <label
                    key={opt}
                    className={`flex items-center gap-1.5 text-sm ${locked ? 'opacity-50' : 'cursor-pointer'}`}
                  >
                    <input
                      type="checkbox"
                      checked={isChecked}
                      disabled={save.isPending || locked}
                      onChange={() => {
                        const next = isChecked ? selected.filter((v) => v !== opt) : [...selected, opt]
                        setKey(next.length ? JSON.stringify(next) : null)
                      }}
                      className="accent-[var(--signal)]"
                    />
                    {opt}
                  </label>
                )
              })}
            </div>
          </div>
        )
      })()}

      {question.type === 'ORDERING' && (() => {
        // The stored key is the answer; the options order is only what students get
        // shuffled. An unkeyed question falls back to the order they were written in.
        const stored = parseArray(question.correctAnswer)
        const all = opts(question)
        const order = stored.length === all.length ? stored : all

        const move = (i: number, delta: number) => {
          const next = [...order]
          const j = i + delta
          if (j < 0 || j >= next.length) return
          ;[next[i], next[j]] = [next[j], next[i]]
          setKey(JSON.stringify(next))
        }

        return (
          <div className="flex flex-col gap-1.5">
            <p className="text-[11px] text-muted">
              Top to bottom is the correct sequence. Students see these shuffled.
            </p>
            <ol className="flex flex-col gap-1">
              {order.map((opt, i) => (
                <li key={opt} className="flex items-center gap-2">
                  <span className="text-xs font-mono text-hairline-strong w-4 shrink-0">{i + 1}</span>
                  <span className="text-sm text-ink-2 flex-1 min-w-0 truncate">{opt}</span>
                  <button
                    onClick={() => move(i, -1)}
                    disabled={i === 0 || save.isPending || locked}
                    aria-label={`Move "${opt}" earlier`}
                    className="p-0.5 text-muted hover:text-signal disabled:opacity-30 transition-colors"
                  >
                    <ChevronUp size={14} />
                  </button>
                  <button
                    onClick={() => move(i, 1)}
                    disabled={i === order.length - 1 || save.isPending || locked}
                    aria-label={`Move "${opt}" later`}
                    className="p-0.5 text-muted hover:text-signal disabled:opacity-30 transition-colors"
                  >
                    <ChevronDown size={14} />
                  </button>
                </li>
              ))}
            </ol>
          </div>
        )
      })()}

      {question.type === 'NUMERIC' && (
        <div className="flex gap-2 flex-wrap">
          <input
            value={numAnswer}
            disabled={locked}
            onChange={(e) => setNumAnswer(e.target.value)}
            onBlur={() => {
              const val = numAnswer.trim()
              if (val === (question.correctAnswer ?? '')) return
              setKey(val || null)
            }}
            placeholder="Correct value"
            className={`w-36 ${inputCls}`}
          />
          <input
            value={numTolerance}
            disabled={locked}
            onChange={(e) => setNumTolerance(e.target.value)}
            onBlur={() => {
              const raw = numTolerance.trim()
              const next = raw ? parseFloat(raw) : null
              if (next === question.tolerance) return
              save.mutate({ tolerance: Number.isNaN(next as number) ? null : next })
            }}
            placeholder="± tolerance"
            className={`w-28 ${inputCls}`}
          />
          <input
            value={numUnit}
            disabled={locked}
            onChange={(e) => setNumUnit(e.target.value)}
            onBlur={() => {
              const val = numUnit.trim()
              if (val === (question.unit ?? '')) return
              save.mutate({ unit: val || null })
            }}
            placeholder="Unit (optional)"
            className={`w-32 ${inputCls}`}
          />
        </div>
      )}

      {question.type === 'STRUCTURE' && (
        <StructureKeyField
          value={question.correctAnswer}
          onSave={(molfile) => setKey(molfile)}
          pending={save.isPending}
          disabled={locked}
        />
      )}

      {save.isError && (
        <p className="text-xs text-red-500 mt-2">{apiError(save.error, 'Could not save the answer key.')}</p>
      )}
    </div>
  )
}
