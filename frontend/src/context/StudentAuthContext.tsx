import { createContext, useContext, useState, useEffect, ReactNode } from 'react'
import { api, setStudentToken, getStudentToken } from '@/api/client'
import type { Student } from 'shared'

interface StudentAuthState {
  student: Student | null
  isAuthenticated: boolean
  isLoading: boolean
  login: (credential: string, password: string) => Promise<void>
  register: (name: string, netId: string, email: string, password: string) => Promise<void>
  logout: () => void
}

const StudentAuthContext = createContext<StudentAuthState | null>(null)

export function StudentAuthProvider({ children }: { children: ReactNode }) {
  const [student, setStudent] = useState<Student | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    const token = getStudentToken()
    if (!token) { setIsLoading(false); return }
    api.get('/auth/student/me')
      .then((r) => setStudent(r.data.data.student))
      .catch(() => setStudentToken(null))
      .finally(() => setIsLoading(false))
  }, [])

  async function login(credential: string, password: string) {
    const r = await api.post('/auth/student/login', { credential, password })
    setStudentToken(r.data.data.token)
    setStudent(r.data.data.student)
  }

  async function register(name: string, netId: string, email: string, password: string) {
    const r = await api.post('/auth/student/register', { name, netId, email, password })
    setStudentToken(r.data.data.token)
    setStudent(r.data.data.student)
  }

  function logout() {
    setStudentToken(null)
    setStudent(null)
  }

  return (
    <StudentAuthContext.Provider value={{ student, isAuthenticated: !!student, isLoading, login, register, logout }}>
      {children}
    </StudentAuthContext.Provider>
  )
}

export function useStudentAuth() {
  const ctx = useContext(StudentAuthContext)
  if (!ctx) throw new Error('useStudentAuth must be used within StudentAuthProvider')
  return ctx
}
