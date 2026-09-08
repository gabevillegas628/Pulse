import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '@/api/client'
import { apiError } from '@/lib/errors'

/**
 * Join codes are six characters from an alphabet with no I, O, 0 or 1 — the
 * lookalikes are left out precisely because these get read off a slide or a
 * whiteboard. Uppercasing here rather than only on the server keeps the field
 * showing the student the same code the professor is showing them.
 *
 * Unlike the 4-digit question code, nothing is stripped. A student who types their
 * question code in here should be told what went wrong, and a field that silently
 * ate the characters is how the confusion this form exists to end got started.
 */
const CODE_LENGTH = 6

function normalize(raw: string): string {
  return raw.trim().toUpperCase().slice(0, CODE_LENGTH)
}

interface Props {
  /**
   * `hero` is the whole page for a student with no classes; `compact` is a quiet
   * line for a student who already has some and is adding another.
   */
  variant?: 'hero' | 'compact'
  onJoined?: (className: string) => void
}

export default function JoinClassForm({ variant = 'hero', onJoined }: Props) {
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const qc = useQueryClient()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const joinCode = normalize(code)
    if (joinCode.length !== CODE_LENGTH) {
      setError(`Join codes are ${CODE_LENGTH} characters`)
      return
    }
    setError('')
    setLoading(true)
    try {
      const r = await api.post('/student/enroll', { joinCode })
      const name: string = r.data.data.enrollment.class.name
      // Both the class list and the deadline strip are now wrong on every student
      // page that reads them, not just this one.
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['student-classes'] }),
        qc.invalidateQueries({ queryKey: ['student-upcoming-assignments'] }),
      ])
      setCode('')
      onJoined?.(name)
    } catch (err: unknown) {
      setError(apiError(err, 'Could not join — check the code and try again'))
    } finally {
      setLoading(false)
    }
  }

  const input = (
    <input
      value={code}
      onChange={(e) => { setCode(normalize(e.target.value)); setError('') }}
      placeholder="ABC123"
      autoCapitalize="characters"
      autoCorrect="off"
      spellCheck={false}
      maxLength={CODE_LENGTH}
      className={
        variant === 'hero'
          ? 'w-full text-center text-3xl font-mono tracking-[0.3em] border-2 border-hairline-strong rounded-[14px] px-4 py-5 bg-surface focus:outline-none focus:border-signal transition-colors'
          : 'flex-1 min-w-0 text-center font-mono tracking-widest border border-hairline-strong rounded-sm px-3 py-2 text-sm bg-surface focus:outline-none focus:border-signal transition-colors'
      }
    />
  )

  if (variant === 'compact') {
    return (
      <form onSubmit={handleSubmit} className="space-y-1.5">
        <div className="flex items-center gap-2">
          {input}
          <button
            type="submit"
            disabled={loading || normalize(code).length !== CODE_LENGTH}
            className="shrink-0 bg-surface border border-hairline-strong text-ink-2 rounded-sm px-4 py-2 text-sm font-bold hover:bg-surface-2 disabled:opacity-40 transition-colors"
          >
            {loading ? 'Joining…' : 'Join'}
          </button>
        </div>
        {error && <p className="text-red-500 text-xs">{error}</p>}
      </form>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {input}
      {error && <p className="text-red-500 text-sm">{error}</p>}
      <button
        type="submit"
        disabled={loading || normalize(code).length !== CODE_LENGTH}
        className="w-full bg-signal text-white rounded-[14px] py-4 text-lg font-bold hover:bg-[var(--signal-bright)] disabled:opacity-40 transition-colors"
      >
        {loading ? 'Joining…' : 'Join class'}
      </button>
    </form>
  )
}
