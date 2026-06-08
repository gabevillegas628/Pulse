import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useStudentAuth } from '@/context/StudentAuthContext'
import StudentLayout from '@/components/layout/StudentLayout'
import { apiError } from '@/lib/errors'

const schema = z.object({
  netId: z.string().min(1, 'Enter your NetID'),
  email: z.string().email('Enter a valid email'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
})
type FormData = z.infer<typeof schema>

export default function StudentRegisterPage() {
  const { register: registerUser } = useStudentAuth()
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
      await registerUser(data.netId, data.email, data.password)
      navigate(next, { replace: true })
    } catch (e: unknown) {
      setError(apiError(e, 'Registration failed'))
    }
  }

  return (
    <StudentLayout>
      <div className="bg-surface rounded-[14px] shadow-card border border-hairline p-8">
        <h1 className="text-2xl font-bold text-ink mb-1">Create account</h1>
        <p className="text-sm text-muted mb-6">One account for all your classes</p>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-ink-2 mb-1">NetID</label>
            <input
              {...register('netId')}
              placeholder="abc123"
              className="w-full border border-hairline rounded-[14px] px-3 py-3 text-base bg-surface focus:outline-none focus:ring-2 focus:ring-signal"
              autoCapitalize="none"
              autoCorrect="off"
            />
            {errors.netId && <p className="text-red-500 text-xs mt-1">{errors.netId.message}</p>}
          </div>

          <div>
            <label className="block text-sm font-medium text-ink-2 mb-1">Email</label>
            <input
              {...register('email')}
              type="email"
              placeholder="abc123@rutgers.edu"
              className="w-full border border-hairline rounded-[14px] px-3 py-3 text-base bg-surface focus:outline-none focus:ring-2 focus:ring-signal"
              autoCapitalize="none"
            />
            {errors.email && <p className="text-red-500 text-xs mt-1">{errors.email.message}</p>}
          </div>

          <div>
            <label className="block text-sm font-medium text-ink-2 mb-1">Password</label>
            <input
              {...register('password')}
              type="password"
              placeholder="8+ characters"
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
            {isSubmitting ? 'Creating account…' : 'Create account'}
          </button>
        </form>

        <p className="text-center text-sm text-muted mt-6">
          Already have an account?{' '}
          <Link to={`/student/login${next !== '/student' ? `?next=${next}` : ''}`} className="text-signal font-medium">
            Sign in
          </Link>
        </p>
      </div>
    </StudentLayout>
  )
}
