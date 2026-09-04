import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { api } from '@/api/client'
import PulseMark from '@/components/ui/PulseMark'
import { apiError } from '@/lib/errors'

const schema = z.object({
  credential: z.string().min(1, 'Enter your NetID or Rutgers email'),
})
type FormData = z.infer<typeof schema>

export default function ForgotPasswordPage() {
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<FormData>({
    resolver: zodResolver(schema),
  })

  async function onSubmit(data: FormData) {
    setError('')
    try {
      await api.post('/auth/student/forgot-password', { credential: data.credential })
      setSent(true)
    } catch (e: unknown) {
      // Only a throttle or an outage reaches here — the server answers the same way
      // for an account that exists and one that does not, and so does this page.
      setError(apiError(e, 'Could not send the reset email. Try again in a moment.'))
    }
  }

  return (
    <div className="min-h-screen bg-canvas flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center gap-2 mb-8">
          <PulseMark size={32} />
          <h1 className="text-2xl font-extrabold text-ink" style={{ letterSpacing: '-0.02em' }}>Pulse</h1>
        </div>

        <div className="bg-surface rounded-[14px] shadow-card border border-hairline p-8">
          {sent ? (
            <div className="text-center">
              <h2 className="text-base font-semibold text-ink mb-2">Check your email</h2>
              <p className="text-sm text-muted mb-1">
                If that account exists, a reset link is on its way to its Rutgers email.
              </p>
              <p className="text-sm text-muted">
                The link expires in an hour. If nothing arrives, check your spam folder — or ask
                your professor to reset it from the class roster.
              </p>
              <Link to="/login" className="text-sm text-signal font-medium mt-6 inline-block">
                Back to sign in
              </Link>
            </div>
          ) : (
            <>
              <h2 className="text-base font-semibold text-ink mb-1">Forgot your password?</h2>
              <p className="text-sm text-muted mb-6">
                We'll email a reset link to the Rutgers address on your account.
              </p>

              <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-ink-2 mb-1">NetID or Email</label>
                  <input
                    {...register('credential')}
                    placeholder="abc123"
                    autoCapitalize="none"
                    autoCorrect="off"
                    autoFocus
                    className="w-full border border-hairline rounded-sm px-3 py-3 text-base bg-surface focus:outline-none focus:ring-2 focus:ring-signal"
                  />
                  {errors.credential && (
                    <p className="text-red-500 text-xs mt-1">{errors.credential.message}</p>
                  )}
                </div>

                {error && <p className="text-red-500 text-sm bg-red-50 rounded-sm px-3 py-2">{error}</p>}

                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="w-full bg-signal text-white rounded-sm py-3 text-base font-bold hover:bg-[var(--signal-bright)] disabled:opacity-50 transition-colors"
                >
                  {isSubmitting ? 'Sending…' : 'Send reset link'}
                </button>

                <p className="text-center text-sm text-muted">
                  <Link to="/login" className="text-signal font-medium">Back to sign in</Link>
                </p>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
