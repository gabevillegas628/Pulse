import { createContext, useContext, useState, useEffect, ReactNode } from 'react'
import { api, setStudentToken, getStudentToken } from '@/api/client'
import type { Student } from 'shared'

interface StudentAuthState {
  student: Student | null
  isAuthenticated: boolean
  isLoading: boolean
  sessionExpired: boolean
  login: (credential: string, password: string) => Promise<void>
  register: (netId: string, email: string, password: string) => Promise<void>
  logout: () => void
  triggerSessionExpired: () => void
  clearSessionExpired: () => void
  resolveSessionExpired: () => void
}

const StudentAuthContext = createContext<StudentAuthState | null>(null)

export function StudentAuthProvider({ children }: { children: ReactNode }) {
  const [student, setStudent] = useState<Student | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [sessionExpired, setSessionExpired] = useState(false)

  useEffect(() => {
    const token = getStudentToken()
    if (!token) { setIsLoading(false); return }
    api.get('/auth/student/me')
      .then((r) => setStudent(r.data.data.student))
      // Only on a real rejection, so a network blip at startup does not discard a sign-in
      // that is still good.
      .catch((err) => { if (err?.response?.status === 401) setStudentToken(null) })
      .finally(() => setIsLoading(false))
  }, [])

  async function login(credential: string, password: string) {
    const r = await api.post('/auth/student/login', { credential, password })
    setStudentToken(r.data.data.token)
    setStudent(r.data.data.student)
    setSessionExpired(false)
  }

  async function register(netId: string, email: string, password: string) {
    const r = await api.post('/auth/student/register', { netId, email, password })
    setStudentToken(r.data.data.token)
    setStudent(r.data.data.student)
  }

  function logout() {
    setStudentToken(null)
    setStudent(null)
    setSessionExpired(false)
  }

  function triggerSessionExpired() {
    setStudentToken(null)
    setSessionExpired(true)
  }

  function clearSessionExpired() {
    setStudent(null)
    setSessionExpired(false)
  }

  /** Auth is working again on its own; take the prompt down and leave the sign-in alone. */
  function resolveSessionExpired() {
    setSessionExpired(false)
  }

  return (
    <StudentAuthContext.Provider value={{ student, isAuthenticated: !!student, isLoading, sessionExpired, login, register, logout, triggerSessionExpired, clearSessionExpired, resolveSessionExpired }}>
      {children}
    </StudentAuthContext.Provider>
  )
}

export function useStudentAuth() {
  const ctx = useContext(StudentAuthContext)
  if (!ctx) throw new Error('useStudentAuth must be used within StudentAuthProvider')
  return ctx
}
