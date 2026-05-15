import { createContext, useContext, useState, useEffect, ReactNode } from 'react'
import { api, setProfessorToken, getProfessorToken } from '@/api/client'
import type { Professor } from 'shared'

interface ProfessorAuthState {
  professor: Professor | null
  isAuthenticated: boolean
  isLoading: boolean
  login: (email: string, password: string) => Promise<void>
  register: (name: string, email: string, password: string) => Promise<void>
  logout: () => void
}

const ProfessorAuthContext = createContext<ProfessorAuthState | null>(null)

export function ProfessorAuthProvider({ children }: { children: ReactNode }) {
  const [professor, setProfessor] = useState<Professor | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    const token = getProfessorToken()
    if (!token) { setIsLoading(false); return }
    api.get('/auth/professor/me')
      .then((r) => setProfessor(r.data.data.professor))
      .catch(() => setProfessorToken(null))
      .finally(() => setIsLoading(false))
  }, [])

  async function login(email: string, password: string) {
    const r = await api.post('/auth/professor/login', { email, password })
    setProfessorToken(r.data.data.token)
    setProfessor(r.data.data.professor)
  }

  async function register(name: string, email: string, password: string) {
    const r = await api.post('/auth/professor/register', { name, email, password })
    setProfessorToken(r.data.data.token)
    setProfessor(r.data.data.professor)
  }

  function logout() {
    setProfessorToken(null)
    setProfessor(null)
  }

  return (
    <ProfessorAuthContext.Provider value={{ professor, isAuthenticated: !!professor, isLoading, login, register, logout }}>
      {children}
    </ProfessorAuthContext.Provider>
  )
}

export function useProfessorAuth() {
  const ctx = useContext(ProfessorAuthContext)
  if (!ctx) throw new Error('useProfessorAuth must be used within ProfessorAuthProvider')
  return ctx
}
