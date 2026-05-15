import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useStudentAuth } from '@/context/StudentAuthContext'
import StudentLayout from '@/components/layout/StudentLayout'

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
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error
      setError(msg ?? 'Login failed')
    }
  }

  return (
    <StudentLayout>
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">Sign in</h1>
        <p className="text-sm text-gray-500 mb-6">Use your NetID or Rutgers email</p>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">NetID or Email</label>
            <input
              {...register('credential')}
              placeholder="abc123 or abc123@rutgers.edu"
              className="w-full border border-gray-300 rounded-lg px-3 py-3 text-base focus:outline-none focus:ring-2 focus:ring-primary-500"
              autoCapitalize="none"
              autoCorrect="off"
            />
            {errors.credential && <p className="text-red-500 text-xs mt-1">{errors.credential.message}</p>}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
            <input
              {...register('password')}
              type="password"
              className="w-full border border-gray-300 rounded-lg px-3 py-3 text-base focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
            {errors.password && <p className="text-red-500 text-xs mt-1">{errors.password.message}</p>}
          </div>

          {error && <p className="text-red-500 text-sm bg-red-50 rounded-lg px-3 py-2">{error}</p>}

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full bg-primary-600 text-white rounded-lg py-3 text-base font-medium hover:bg-primary-700 disabled:opacity-50 transition-colors"
          >
            {isSubmitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="text-center text-sm text-gray-500 mt-6">
          New here?{' '}
          <Link to={`/student/register${next !== '/student' ? `?next=${next}` : ''}`} className="text-primary-600 font-medium">
            Create account
          </Link>
        </p>
      </div>

      <div className="mt-6 text-center">
        <p className="text-sm text-gray-400">
          Have a 4-digit class code?{' '}
          <Link to="/student/code" className="text-primary-600">Enter it here</Link>
        </p>
      </div>
    </StudentLayout>
  )
}
