import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useProfessorAuth } from '@/context/ProfessorAuthContext'

const schema = z.object({
  name: z.string().min(1, 'Enter your name'),
  email: z.string().email('Enter a valid email'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  inviteCode: z.string().min(1, 'Enter your invite code'),
})
type FormData = z.infer<typeof schema>

export default function ProfessorRegisterPage() {
  const { register: registerUser } = useProfessorAuth()
  const navigate = useNavigate()
  const [error, setError] = useState('')

  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<FormData>({
    resolver: zodResolver(schema),
  })

  async function onSubmit(data: FormData) {
    setError('')
    try {
      await registerUser(data.name, data.email, data.password, data.inviteCode)
      navigate('/professor', { replace: true })
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error
      setError(msg ?? 'Registration failed')
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-primary-700">Pulse</h1>
          <p className="text-gray-500 text-sm mt-1">Professor portal</p>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
          <h2 className="text-xl font-semibold text-gray-900 mb-6">Create account</h2>

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
              <input
                {...register('name')}
                placeholder="Dr. Jane Smith"
                className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
              {errors.name && <p className="text-red-500 text-xs mt-1">{errors.name.message}</p>}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
              <input
                {...register('email')}
                type="email"
                className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
              {errors.email && <p className="text-red-500 text-xs mt-1">{errors.email.message}</p>}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
              <input
                {...register('password')}
                type="password"
                placeholder="8+ characters"
                className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
              {errors.password && <p className="text-red-500 text-xs mt-1">{errors.password.message}</p>}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Invite code</label>
              <input
                {...register('inviteCode')}
                type="password"
                className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
              {errors.inviteCode && <p className="text-red-500 text-xs mt-1">{errors.inviteCode.message}</p>}
            </div>

            {error && <p className="text-red-500 text-sm bg-red-50 rounded-lg px-3 py-2">{error}</p>}

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full bg-primary-600 text-white rounded-lg py-2.5 text-sm font-medium hover:bg-primary-700 disabled:opacity-50 transition-colors"
            >
              {isSubmitting ? 'Creating account…' : 'Create account'}
            </button>
          </form>

          <p className="text-center text-sm text-gray-500 mt-5">
            Already have an account?{' '}
            <Link to="/professor/login" className="text-primary-600 font-medium">Sign in</Link>
          </p>
        </div>
      </div>
    </div>
  )
}
