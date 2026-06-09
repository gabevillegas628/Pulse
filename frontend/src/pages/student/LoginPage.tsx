import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useStudentAuth } from '@/context/StudentAuthContext'
import StudentLayout from '@/components/layout/StudentLayout'
import { apiError } from '@/lib/errors'

const schema = z.object({
  credential: z.string().min(1, 'Enter your NetID or email'),
  password: z.string().min(1, 'Enter your password'),
})
type FormData = z.infer<typeof schema>

export default function StudentLoginPage() {
  const { login } = useStudentAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const next = params.get('next') ?? '/student'
  const [error, setError] = useState('')

  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<FormData>({
    resolver: zodResolver(schema),
  })

  async function onSubmit(data: FormData) {
    setError('')
    try {
      await login(data.credential, data.password)
      navigate(next, { replace: true })
    } catch (e: unknown) {
      setError(apiError(e, 'Login failed'))
    }
  }

  return (
    <StudentLayout>
      <div className="bg-surface rounded-[14px] shadow-card border border-hairline p-8">
        <h1 className="text-2xl font-bold text-ink mb-1">Sign in</h1>
        <p className="text-sm text-muted mb-6">Use your NetID or Rutgers email</p>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-ink-2 mb-1">NetID or Email</label>
            <input
              {...register('credential')}
              placeholder="abc123 or abc123@rutgers.edu"
              className="w-full border border-hairline rounded-[14px] px-3 py-3 text-base bg-surface focus:outline-none focus:ring-2 focus:ring-signal"
              autoCapitalize="none"
              autoCorrect="off"
            />
            {errors.credential && <p className="text-red-500 text-xs mt-1">{errors.credential.message}</p>}
          </div>

          <div>
            <label className="block text-sm font-medium text-ink-2 mb-1">Password</label>
            <input
              {...register('password')}
              type="password"
              className="w-full border border-hairline rounded-[14px] px-3 py-3 text-base bg-surface focus:outline-none focus:ring-2 focus:ring-signal"
            />
            {errors.password && <p className="text-red-500 text-xs mt-1">{errors.password.message}</p>}
          </div>

          {error && <p className="text-red-500 text-sm bg-red-50 rounded-sm px-3 py-2">{error}</p>}

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full bg-signal text-white rounded-sm py-3 text-base font-bold hover:bg-[var(--signal-bright)] disabled:opacity-50 transition-colors"
          >
            {isSubmitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="text-center text-sm text-muted mt-6">
          New here?{' '}
          <Link to={`/student/register${next !== '/student' ? `?next=${next}` : ''}`} className="text-signal font-medium">
            Create account
          </Link>
        </p>
      </div>

      <div className="mt-6 text-center">
        <p className="text-sm text-muted">
          Have a 4-digit class code?{' '}
          <Link to="/student/code" className="text-signal">Enter it here</Link>
        </p>
      </div>
    </StudentLayout>
  )
}
