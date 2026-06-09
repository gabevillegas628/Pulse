import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useProfessorAuth } from '@/context/ProfessorAuthContext'
import PulseMark from '@/components/ui/PulseMark'
import { apiError } from '@/lib/errors'

const schema = z.object({
  email: z.string().email('Enter a valid email'),
  password: z.string().min(1, 'Enter your password'),
})
type FormData = z.infer<typeof schema>

export default function ProfessorLoginPage() {
  const { login } = useProfessorAuth()
  const navigate = useNavigate()
  const [error, setError] = useState('')

  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<FormData>({
    resolver: zodResolver(schema),
  })

  async function onSubmit(data: FormData) {
    setError('')
    try {
      await login(data.email, data.password)
      navigate('/professor', { replace: true })
    } catch (e: unknown) {
      setError(apiError(e, 'Login failed'))
    }
  }

  return (
    <div className="min-h-screen bg-canvas flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center gap-2 mb-8">
          <PulseMark size={32} />
          <h1 className="text-2xl font-extrabold text-ink" style={{ letterSpacing: '-0.02em' }}>Pulse</h1>
          <p className="text-muted text-sm">Professor portal</p>
        </div>

        <div className="bg-surface rounded-[14px] shadow-card border border-hairline p-8">
          <h2 className="text-xl font-semibold text-ink mb-6">Sign in</h2>

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-ink-2 mb-1">Email</label>
              <input
                {...register('email')}
                type="email"
                className="w-full border border-hairline rounded-sm px-3 py-2.5 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-signal"
              />
              {errors.email && <p className="text-red-500 text-xs mt-1">{errors.email.message}</p>}
            </div>

            <div>
              <label className="block text-sm font-medium text-ink-2 mb-1">Password</label>
              <input
                {...register('password')}
                type="password"
                className="w-full border border-hairline rounded-sm px-3 py-2.5 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-signal"
              />
              {errors.password && <p className="text-red-500 text-xs mt-1">{errors.password.message}</p>}
            </div>

            {error && <p className="text-red-500 text-sm bg-red-50 rounded-sm px-3 py-2">{error}</p>}

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full bg-signal text-white rounded-sm py-2.5 text-sm font-bold hover:bg-[var(--signal-bright)] disabled:opacity-50 transition-colors"
            >
              {isSubmitting ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <p className="text-center text-sm text-muted mt-5">
            New?{' '}
            <Link to="/professor/register" className="text-signal font-medium">Create account</Link>
          </p>
        </div>
      </div>
    </div>
  )
}
