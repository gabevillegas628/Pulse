import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, X } from 'lucide-react'
import { api } from '@/api/client'
import { apiError } from '@/lib/errors'
import { deleteUpload } from '@/lib/uploadImage'
import Button from '@/components/ui/Button'
import Card from '@/components/ui/Card'
import QuestionImageField from '@/components/QuestionImageField'
import {
  QUESTION_TYPES, hasOptions, questionTypeLabel, questionTypeChoiceLabel,
  type QuestionTypeValue,
} from '@/lib/questionTypes'
import type { QuestionWithResponses } from 'shared'

const inputCls =
  'w-full border border-hairline rounded-sm px-3 py-2.5 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-signal'

interface Props {
  sessionId: string
  /** The question to edit, or null to create one. */
  question: QuestionWithResponses | null
  onClose: () => void
}

/**
 * Add or edit a question.
 *
 * These were two dialogs that had drifted apart: add offered a type picker and took its
 * choices as newline-separated text, edit offered per-option rows with add and remove but
 * no way to change type. Same job, two shapes, and between them sixteen pieces of state on
 * the page.
 *
 * The differences that remain are real rather than accidental. Type is fixed after
 * creation, because changing it would orphan the options and re-interpret every answer
 * already given — so it shows as a chip rather than a picker. And a numeric key is offered
 * at creation only, because until the question exists there is no `AnswerKey` on the page
 * to set it from; once it does, that is the one place it lives.
 */
export default function QuestionDialog({ sessionId, question, onClose }: Props) {
  const qc = useQueryClient()
  const isEdit = question !== null

  const [title, setTitle] = useState(question?.title ?? '')
  const [text, setText] = useState(question?.text ?? '')
  const [type, setType] = useState<QuestionTypeValue>(
    (question?.type as QuestionTypeValue | undefined) ?? 'FREE_TEXT',
  )
  // Two empty rows on a new question, so the first option is typed rather than clicked
  // for. The old dialog took a textarea, which was quicker but had to be parsed.
  const [options, setOptions] = useState<string[]>(
    (question?.options as string[] | null) ?? ['', ''],
  )
  const [imageUrl, setImageUrl] = useState<string | null>(question?.imageUrl ?? null)
  const [numAnswer, setNumAnswer] = useState('')
  const [numTolerance, setNumTolerance] = useState('')
  const [numUnit, setNumUnit] = useState('')
  const [error, setError] = useState('')

  const originalImage = question?.imageUrl ?? null
  const typeHasOptions = hasOptions(type)

  /**
   * Leave without saving, taking any upload that was never attached with us.
   *
   * The upload happens the moment a file is picked, so backing out is the one path that
   * can strand a file with nothing pointing at it. The same rule covers both modes: delete
   * the draft image unless it is the one already saved on the question.
   */
  function cancel() {
    if (imageUrl && imageUrl !== originalImage) deleteUpload(imageUrl)
    onClose()
  }

  const save = useMutation({
    mutationFn: () => {
      const cleanOptions = options.map((o) => o.trim()).filter(Boolean)

      if (!isEdit) {
        return api.post(`/sessions/${sessionId}/questions`, {
          title: title.trim() || undefined,
          text: text.trim(),
          type,
          options: typeHasOptions ? cleanOptions : undefined,
          correctAnswer: type === 'NUMERIC' && numAnswer.trim() ? numAnswer.trim() : undefined,
          tolerance: type === 'NUMERIC' && numTolerance.trim() ? parseFloat(numTolerance) : undefined,
          unit: type === 'NUMERIC' && numUnit.trim() ? numUnit.trim() : undefined,
          imageUrl: imageUrl ?? undefined,
        })
      }

      // Send only what changed: the route gates text, options and image on there being no
      // open run, so an unchanged field must not be in the payload at all.
      const payload: Record<string, unknown> = {}
      const newTitle = title.trim() || null
      if (newTitle !== (question.title ?? null)) payload.title = newTitle
      if (text.trim() !== question.text) payload.text = text.trim()
      if (imageUrl !== originalImage) payload.imageUrl = imageUrl
      if (typeHasOptions) {
        const original = (question.options as string[] | null) ?? []
        const changed =
          cleanOptions.length !== original.length || cleanOptions.some((o, i) => o !== original[i])
        if (changed) payload.options = cleanOptions
      }
      return api.patch(`/sessions/${sessionId}/questions/${question.id}`, payload)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['session', sessionId] })
      onClose()
    },
    onError: (e: unknown) =>
      setError(apiError(e, isEdit ? 'Failed to save question' : 'Failed to add question')),
  })

  const optionsValid = !typeHasOptions || options.filter((o) => o.trim()).length >= 2
  const canSave = text.trim().length > 0 && optionsValid && !save.isPending

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
      <Card flat className="w-full max-w-md p-6 shadow-pop max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-base font-semibold text-ink">
            {isEdit ? 'Edit question' : 'Add question'}
          </h2>
          <button onClick={cancel} aria-label="Close" className="text-muted hover:text-ink-2 transition-colors">
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4">
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Short title (optional) — shown in the sidebar"
            maxLength={120}
            className={inputCls}
          />
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Question text…"
            className={inputCls}
          />

          <QuestionImageField
            value={imageUrl}
            onChange={setImageUrl}
            cleanupOnReplace={!isEdit}
          />

          {isEdit ? (
            <p className="text-xs text-muted">
              Type:{' '}
              <span className="text-ink-2 font-medium">{questionTypeLabel(question.type)}</span>
              <span className="block mt-0.5">
                Fixed after creation — changing it would re-interpret the answers already given.
              </span>
            </p>
          ) : (
            <select
              value={type}
              onChange={(e) => {
                const next = e.target.value as QuestionTypeValue
                setType(next)
                // Starting fresh: options from a previous type mean nothing to this one.
                if (hasOptions(next)) setOptions(['', ''])
              }}
              className={inputCls}
            >
              {/* No structure questions in a live session: Ketcher only understands a mouse,
                  and students answer these on phones. Assignments still offer it. */}
              {QUESTION_TYPES.filter((t) => t.value !== 'STRUCTURE').map((t) => (
                <option key={t.value} value={t.value}>{questionTypeChoiceLabel(t)}</option>
              ))}
            </select>
          )}

          {typeHasOptions && (
            <div className="space-y-2">
              <p className="text-xs text-muted font-medium">
                {type === 'ORDERING' ? 'Steps, in the correct order' : 'Options'}
              </p>
              {options.map((opt, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    value={opt}
                    onChange={(e) => {
                      const next = [...options]
                      next[i] = e.target.value
                      setOptions(next)
                    }}
                    placeholder={type === 'ORDERING' ? `Step ${i + 1}` : `Option ${i + 1}`}
                    className="flex-1 border border-hairline rounded-sm px-3 py-2 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-signal"
                  />
                  <button
                    onClick={() => setOptions(options.filter((_, j) => j !== i))}
                    disabled={options.length <= 2}
                    aria-label={`Remove option ${i + 1}`}
                    className="text-hairline-strong hover:text-red-400 disabled:opacity-30 transition-colors"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
              <button
                onClick={() => setOptions([...options, ''])}
                className="flex items-center gap-1 text-xs text-signal hover:text-[var(--signal-bright)] mt-1 transition-colors"
              >
                <Plus size={12} /> Add option
              </button>
            </div>
          )}

          {type === 'NUMERIC' && (isEdit ? (
            <p className="text-xs text-muted leading-snug">
              The answer, tolerance and unit are set from the answer key on the page behind
              this dialog, so there is only one place to look for them.
            </p>
          ) : (
            <div className="flex gap-2 flex-wrap">
              <input
                value={numAnswer}
                onChange={(e) => setNumAnswer(e.target.value)}
                placeholder="Correct answer (optional)"
                className="flex-1 min-w-0 border border-hairline rounded-sm px-3 py-2 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-signal"
              />
              <input
                value={numTolerance}
                onChange={(e) => setNumTolerance(e.target.value)}
                placeholder="± tolerance"
                className="w-28 border border-hairline rounded-sm px-3 py-2 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-signal"
              />
              <input
                value={numUnit}
                onChange={(e) => setNumUnit(e.target.value)}
                placeholder="Unit (optional)"
                className="w-32 border border-hairline rounded-sm px-3 py-2 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-signal"
              />
            </div>
          ))}

          {error && <p className="text-red-500 text-xs">{error}</p>}

          <div className="flex justify-end gap-3 pt-1">
            <button
              onClick={cancel}
              className="px-4 py-2 text-sm text-muted hover:text-ink transition-colors"
            >
              Cancel
            </button>
            <Button variant="primary" onClick={() => save.mutate()} disabled={!canSave}>
              {save.isPending
                ? (isEdit ? 'Saving…' : 'Adding…')
                : (isEdit ? 'Save changes' : 'Add question')}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  )
}
