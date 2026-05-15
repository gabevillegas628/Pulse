import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useProfessorAuth } from '@/context/ProfessorAuthContext'
import { useStudentAuth } from '@/context/StudentAuthContext'

type Role = 'student' | 'professor'

const studentSchema = z.object({
  name: z.string().min(1, 'Enter your name'),
  netId: z.string().min(1, 'Enter your NetID'),
  email: z.string().email('Enter a valid email'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
})
const professorSchema = z.object({
  name: z.string().min(1, 'Enter your name'),
  email: z.string().email('Enter a valid email'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
})

type StudentForm = z.infer<typeof studentSchema>
type ProfessorForm = z.infer<typeof professorSchema>

export default function RegisterPage() {
  const [params] = useSearchParams()
  const initialRole: Role = params.get('role') === 'professor' ? 'professor' : 'student'
  const [role, setRole] = useState<Role>(initialRole)
  const [error, setError] = useState('')
  const { register: professorRegister } = useProfessorAuth()
  const { register: studentRegister } = useStudentAuth()
  const navigate = useNavigate()
  const next = params.get('next')

  const studentForm = useForm<StudentForm>({ resolver: zodResolver(studentSchema) })
  const professorForm = useForm<ProfessorForm>({ resolver: zodResolver(professorSchema) })

  function switchRole(r: Role) {
    setRole(r)
    setError('')
  }

  async function onStudentSubmit(data: StudentForm) {
    setError('')
    try {
      await studentRegister(data.name, data.netId, data.email, data.password)
      navigate(next ?? '/student', { replace: true })
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error
      setError(msg ?? 'Registration failed')
    }
  }

  async function onProfessorSubmit(data: ProfessorForm) {
    setError('')
    try {
      await professorRegister(data.name, data.email, data.password)
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
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
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
                  <label className="block text-sm font-medium text-gray-700 mb-1">Full name</label>
                  <input
                    {...studentForm.register('name')}
                    placeholder="Jane Smith"
                    className="w-full border border-gray-300 rounded-lg px-3 py-3 text-base focus:outline-none focus:ring-2 focus:ring-primary-500"
                  />
                  {studentForm.formState.errors.name && (
                    <p className="text-red-500 text-xs mt-1">{studentForm.formState.errors.name.message}</p>
                  )}
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">NetID</label>
                  <input
                    {...studentForm.register('netId')}
                    placeholder="abc123"
                    autoCapitalize="none"
                    autoCorrect="off"
                    className="w-full border border-gray-300 rounded-lg px-3 py-3 text-base focus:outline-none focus:ring-2 focus:ring-primary-500"
                  />
                  {studentForm.formState.errors.netId && (
                    <p className="text-red-500 text-xs mt-1">{studentForm.formState.errors.netId.message}</p>
                  )}
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                  <input
                    {...studentForm.register('email')}
                    type="email"
                    placeholder="abc123@rutgers.edu"
                    autoCapitalize="none"
                    className="w-full border border-gray-300 rounded-lg px-3 py-3 text-base focus:outline-none focus:ring-2 focus:ring-primary-500"
                  />
                  {studentForm.formState.errors.email && (
                    <p className="text-red-500 text-xs mt-1">{studentForm.formState.errors.email.message}</p>
                  )}
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
                  <input
                    {...studentForm.register('password')}
                    type="password"
                    placeholder="8+ characters"
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
                  {studentForm.formState.isSubmitting ? 'Creating account…' : 'Create account'}
                </button>
                <p className="text-center text-sm text-gray-500">
                  Already have an account?{' '}
                  <Link to={`/login${next ? `?next=${next}` : ''}`} className="text-primary-600 font-medium">Sign in</Link>
                </p>
              </form>
            ) : (
              <form onSubmit={professorForm.handleSubmit(onProfessorSubmit)} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                  <input
                    {...professorForm.register('name')}
                    placeholder="Dr. Jane Smith"
                    className="w-full border border-gray-300 rounded-lg px-3 py-3 text-base focus:outline-none focus:ring-2 focus:ring-primary-500"
                  />
                  {professorForm.formState.errors.name && (
                    <p className="text-red-500 text-xs mt-1">{professorForm.formState.errors.name.message}</p>
                  )}
                </div>
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
                    placeholder="8+ characters"
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
                  {professorForm.formState.isSubmitting ? 'Creating account…' : 'Create account'}
                </button>
                <p className="text-center text-sm text-gray-500">
                  Already have an account?{' '}
                  <Link to="/login?role=professor" className="text-primary-600 font-medium">Sign in</Link>
                </p>
              </form>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
