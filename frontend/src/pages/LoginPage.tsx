import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useProfessorAuth } from '@/context/ProfessorAuthContext'
import { useStudentAuth } from '@/context/StudentAuthContext'
import { apiError } from '@/lib/errors'

type Role = 'student' | 'professor'

const studentSchema = z.object({
  credential: z.string().min(1, 'Enter your NetID or email'),
  password: z.string().min(1, 'Enter your password'),
})
const professorSchema = z.object({
  email: z.string().email('Enter a valid email'),
  password: z.string().min(1, 'Enter your password'),
})

type StudentForm = z.infer<typeof studentSchema>
type ProfessorForm = z.infer<typeof professorSchema>

export default function LoginPage() {
  const [role, setRole] = useState<Role>(() => {
    const saved = localStorage.getItem('login-role')
    return saved === 'professor' ? 'professor' : 'student'
  })
  const [error, setError] = useState('')
  const { login: professorLogin } = useProfessorAuth()
  const { login: studentLogin } = useStudentAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const next = params.get('next')

  const studentForm = useForm<StudentForm>({ resolver: zodResolver(studentSchema) })
  const professorForm = useForm<ProfessorForm>({ resolver: zodResolver(professorSchema) })

  function switchRole(r: Role) {
    setRole(r)
    localStorage.setItem('login-role', r)
    setError('')
    studentForm.clearErrors()
    professorForm.clearErrors()
  }

  async function onStudentSubmit(data: StudentForm) {
    setError('')
    try {
      await studentLogin(data.credential, data.password)
      navigate(next ?? '/student', { replace: true })
    } catch (e: unknown) {
            setError(apiError(e, 'Invalid credentials'))
    }
  }

  async function onProfessorSubmit(data: ProfessorForm) {
    setError('')
    try {
      await professorLogin(data.email, data.password)
      navigate(next ?? '/professor', { replace: true })
    } catch (e: unknown) {
            setError(apiError(e, 'Invalid credentials'))
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-primary-700">Pulse</h1>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
          {/* Role toggle */}
          <div className="flex border-b border-gray-200">
            {(['student', 'professor'] as Role[]).map((r) => (
              <button
                key={r}
                onClick={() => switchRole(r)}
                className={`flex-1 py-3 text-sm font-medium transition-colors ${
                  role === r
                    ? 'bg-white text-primary-700 border-b-2 border-primary-600'
                    : 'bg-gray-50 text-gray-400 hover:text-gray-600'
                }`}
              >
                {r.charAt(0).toUpperCase() + r.slice(1)}
              </button>
            ))}
          </div>

          <div className="p-8">
            {role === 'student' ? (
              <form onSubmit={studentForm.handleSubmit(onStudentSubmit)} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">NetID or Email</label>
                  <input
                    {...studentForm.register('credential')}
                    placeholder="abc123"
                    autoCapitalize="none"
                    autoCorrect="off"
                    className="w-full border border-gray-300 rounded-lg px-3 py-3 text-base focus:outline-none focus:ring-2 focus:ring-primary-500"
                  />
                  {studentForm.formState.errors.credential && (
                    <p className="text-red-500 text-xs mt-1">{studentForm.formState.errors.credential.message}</p>
                  )}
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
                  <input
                    {...studentForm.register('password')}
                    type="password"
                    className="w-full border border-gray-300 rounded-lg px-3 py-3 text-base focus:outline-none focus:ring-2 focus:ring-primary-500"
                  />
                  {studentForm.formState.errors.password && (
                    <p className="text-red-500 text-xs mt-1">{studentForm.formState.errors.password.message}</p>
                  )}
                </div>
                {error && <p className="text-red-500 text-sm bg-red-50 rounded-lg px-3 py-2">{error}</p>}
                <button
                  type="submit"
                  disabled={studentForm.formState.isSubmitting}
                  className="w-full bg-primary-600 text-white rounded-lg py-3 text-base font-medium hover:bg-primary-700 disabled:opacity-50 transition-colors"
                >
                  {studentForm.formState.isSubmitting ? 'Signing in…' : 'Sign in'}
                </button>
                <p className="text-center text-sm text-gray-500">
                  New?{' '}
                  <Link to={`/register${next ? `?next=${next}` : ''}`} className="text-primary-600 font-medium">
                    Create account
                  </Link>
                </p>
              </form>
            ) : (
              <form onSubmit={professorForm.handleSubmit(onProfessorSubmit)} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                  <input
                    {...professorForm.register('email')}
                    type="email"
                    autoCapitalize="none"
                    className="w-full border border-gray-300 rounded-lg px-3 py-3 text-base focus:outline-none focus:ring-2 focus:ring-primary-500"
                  />
                  {professorForm.formState.errors.email && (
                    <p className="text-red-500 text-xs mt-1">{professorForm.formState.errors.email.message}</p>
                  )}
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
                  <input
                    {...professorForm.register('password')}
                    type="password"
                    className="w-full border border-gray-300 rounded-lg px-3 py-3 text-base focus:outline-none focus:ring-2 focus:ring-primary-500"
                  />
                  {professorForm.formState.errors.password && (
                    <p className="text-red-500 text-xs mt-1">{professorForm.formState.errors.password.message}</p>
                  )}
                </div>
                {error && <p className="text-red-500 text-sm bg-red-50 rounded-lg px-3 py-2">{error}</p>}
                <button
                  type="submit"
                  disabled={professorForm.formState.isSubmitting}
                  className="w-full bg-primary-600 text-white rounded-lg py-3 text-base font-medium hover:bg-primary-700 disabled:opacity-50 transition-colors"
                >
                  {professorForm.formState.isSubmitting ? 'Signing in…' : 'Sign in'}
                </button>
                <p className="text-center text-sm text-gray-500">
                  New?{' '}
                  <Link to="/register?role=professor" className="text-primary-600 font-medium">
                    Create account
                  </Link>
                </p>
              </form>
            )}
          </div>
        </div>

        {role === 'student' && (
          <div className="mt-5 text-center">
            <p className="text-sm text-gray-400">
              Have a 4-digit class code?{' '}
              <Link to="/student/code" className="text-primary-600">Enter it here</Link>
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
