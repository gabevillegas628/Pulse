import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Settings2, Sparkles, TimerReset } from 'lucide-react'
import { api } from '@/api/client'
import Pill from '@/components/ui/Pill'
import Popover from '@/components/ui/Popover'
import Switch from '@/components/ui/Switch'
import type { QuestionWithResponses } from 'shared'

/** The three per-question behaviours, each `null` when it follows the class default. */
type Field = 'liveThemes' | 'autoClose' | 'effortGrading'

interface Props {
  sessionId: string
  question: QuestionWithResponses
  classDefaults: {
    liveThemes: boolean
    autoClose: boolean
    effortGrading: boolean
  }
  /**
   * Whether the grading stance can be set yet. It only means anything once there are
   * answers to grade, which is the gate the inline version used.
   */
  canSetGradingStance: boolean
}

interface RowProps {
  icon: React.ReactNode
  label: string
  description: string
  /** The question's own value — `null` means it follows the class default. */
  value: boolean | null
  classDefault: boolean
  onSet: (v: boolean | null) => void
  pending: boolean
}

function SettingRow({ icon, label, description, value, classDefault, onSet, pending }: RowProps) {
  const effective = value ?? classDefault
  const inherited = value === null

  return (
    <div className="flex items-start justify-between gap-3 py-3 border-b border-hairline last:border-b-0">
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink flex items-center gap-1.5 flex-wrap">
          {icon}
          {label}
          {inherited && <Pill variant="muted">Class default</Pill>}
        </p>
        <p className="text-xs text-muted mt-0.5 leading-snug">{description}</p>
        {!inherited && (
          <button
            type="button"
            onClick={() => onSet(null)}
            disabled={pending}
            className="mt-1.5 text-[11px] text-muted hover:text-signal transition-colors disabled:opacity-50"
          >
            Reset to class default
          </button>
        )}
      </div>
      <Switch
        checked={effective}
        onChange={() => onSet(!effective)}
        disabled={pending}
        ariaLabel={label}
        className="mt-0.5"
      />
    </div>
  )
}

/**
 * Per-question behaviour, behind one trigger that states the current stance in a line.
 *
 * These three settings used to sit open in the question header as tri-state segmented
 * controls — roughly 210px of chrome for choices made once per question, on the page a
 * professor watches during class. The tri-state is gone with them: the switch shows the
 * value in force, a `Class default` pill says where it came from, and an explicit
 * override earns a reset link. Same three states, one control.
 */
export default function QuestionSettings({ sessionId, question, classDefaults, canSetGradingStance }: Props) {
  const qc = useQueryClient()

  const patch = useMutation({
    mutationFn: ({ field, value }: { field: Field; value: boolean | null }) =>
      api.patch(`/sessions/${sessionId}/questions/${question.id}`, { [field]: value }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['session', sessionId] }),
  })

  const set = (field: Field) => (value: boolean | null) => patch.mutate({ field, value })

  const isFreeText = question.type === 'FREE_TEXT'
  const showStance = isFreeText && canSetGradingStance

  const autoCloseOn = question.autoClose ?? classDefaults.autoClose
  const liveThemesOn = question.liveThemes ?? classDefaults.liveThemes
  const effortOn = question.effortGrading ?? classDefaults.effortGrading

  // The trigger says what is in force, so the panel stays shut for the common case.
  const summary = [
    isFreeText ? (liveThemesOn ? 'Live themes on' : 'Live themes off') : null,
    autoCloseOn ? 'closes automatically' : 'stays open',
    showStance ? (effortOn ? 'graded on effort' : 'graded on understanding') : null,
  ].filter(Boolean).join(' · ')

  return (
    <Popover
      label="Question settings"
      align="left"
      trigger={<><Settings2 size={12} className="text-signal" /> {summary}</>}
    >
      <p className="text-xs font-medium text-muted uppercase tracking-wide mb-1">
        This question
      </p>

      {isFreeText && (
        <SettingRow
          icon={<Sparkles size={13} className="text-signal" />}
          label="Live AI themes"
          description="Group answers into themes as they arrive, without pressing anything."
          value={question.liveThemes}
          classDefault={classDefaults.liveThemes}
          onSet={set('liveThemes')}
          pending={patch.isPending}
        />
      )}

      <SettingRow
        icon={<TimerReset size={13} className="text-signal" />}
        label="Close automatically"
        description="A countdown that restarts with every answer. When it runs out the question stops accepting answers and the correct one is revealed."
        value={question.autoClose}
        classDefault={classDefaults.autoClose}
        onSet={set('autoClose')}
        pending={patch.isPending}
      />

      {showStance && (
        <SettingRow
          icon={<Sparkles size={13} className="text-signal" />}
          label="Grade on effort"
          description={
            effortOn
              ? 'A real attempt earns full credit however wrong it is. Only non-answers lose marks.'
              : 'Off, answers are judged against what you were looking for.'
          }
          value={question.effortGrading}
          classDefault={classDefaults.effortGrading}
          onSet={set('effortGrading')}
          pending={patch.isPending}
        />
      )}

      {patch.isError && (
        <p className="text-xs text-red-500 mt-2">Could not change that — try again.</p>
      )}
    </Popover>
  )
}
