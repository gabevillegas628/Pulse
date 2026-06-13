import axios from 'axios'

export const api = axios.create({ baseURL: '/api' })

api.interceptors.request.use((config) => {
  // Inject whichever token is present (professor takes precedence on shared pages)
  const token = localStorage.getItem('professor_token') ?? localStorage.getItem('student_token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

type AuthExpiredHandler = () => void
let onAuthExpired: AuthExpiredHandler | null = null
export function setAuthExpiredHandler(handler: AuthExpiredHandler) {
  onAuthExpired = handler
}

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      const isLoginRoute = window.location.pathname === '/login'
      if (!isLoginRoute && onAuthExpired) {
        onAuthExpired()
      } else if (!isLoginRoute) {
        localStorage.removeItem('professor_token')
        localStorage.removeItem('student_token')
        window.location.href = '/login'
      }
    }
    return Promise.reject(err)
  }
)

export function setProfessorToken(token: string | null): void {
  if (token) localStorage.setItem('professor_token', token)
  else localStorage.removeItem('professor_token')
}

export function setStudentToken(token: string | null): void {
  if (token) localStorage.setItem('student_token', token)
  else localStorage.removeItem('student_token')
}

export function getProfessorToken(): string | null {
  return localStorage.getItem('professor_token')
}

export function getStudentToken(): string | null {
  return localStorage.getItem('student_token')
}
