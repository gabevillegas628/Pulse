import { createContext, useContext, useState, useEffect, ReactNode } from 'react'
import { api, setProfessorToken, getProfessorToken } from '@/api/client'
import type { Professor } from 'shared'

interface ProfessorAuthState {
  professor: Professor | null
  isAuthenticated: boolean
  isLoading: boolean
  sessionExpired: boolean
  login: (email: string, password: string) => Promise<void>
  register: (name: string, email: string, password: string, inviteCode: string) => Promise<void>
  logout: () => void
  triggerSessionExpired: () => void
  clearSessionExpired: () => void
  resolveSessionExpired: () => void
}

const ProfessorAuthContext = createContext<ProfessorAuthState | null>(null)

export function ProfessorAuthProvider({ children }: { children: ReactNode }) {
  const [professor, setProfessor] = useState<Professor | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [sessionExpired, setSessionExpired] = useState(false)

  useEffect(() => {
    const token = getProfessorToken()
    if (!token) { setIsLoading(false); return }
    api.get('/auth/professor/me')
      .then((r) => setProfessor(r.data.data.professor))
      // Only on a real rejection. This runs at every mount, the projector's included, and
      // a network blip at startup must not throw away a sign-in that is still good.
      .catch((err) => { if (err?.response?.status === 401) setProfessorToken(null) })
      .finally(() => setIsLoading(false))
  }, [])

  async function login(email: string, password: string) {
    const r = await api.post('/auth/professor/login', { email, password })
    setProfessorToken(r.data.data.token)
    setProfessor(r.data.data.professor)
    setSessionExpired(false)
  }

  async function register(name: string, email: string, password: string, inviteCode: string) {
    const r = await api.post('/auth/professor/register', { name, email, password, inviteCode })
    setProfessorToken(r.data.data.token)
    setProfessor(r.data.data.professor)
  }

  function logout() {
    setProfessorToken(null)
    setProfessor(null)
    setSessionExpired(false)
  }

  function triggerSessionExpired() {
    setProfessorToken(null)
    setSessionExpired(true)
  }

  function clearSessionExpired() {
    setProfessor(null)
    setSessionExpired(false)
  }

  /**
   * Auth started working again on its own — a renewed token landed, or another surface
   * sharing this storage signed back in. Distinct from clearSessionExpired, which is the
   * user giving up and being sent to the login page: here they are still signed in, so the
   * prompt comes down and nothing else changes.
   */
  function resolveSessionExpired() {
    setSessionExpired(false)
  }

  return (
    <ProfessorAuthContext.Provider value={{ professor, isAuthenticated: !!professor, isLoading, sessionExpired, login, register, logout, triggerSessionExpired, clearSessionExpired, resolveSessionExpired }}>
      {children}
    </ProfessorAuthContext.Provider>
  )
}

export function useProfessorAuth() {
  const ctx = useContext(ProfessorAuthContext)
  if (!ctx) throw new Error('useProfessorAuth must be used within ProfessorAuthProvider')
  return ctx
}
