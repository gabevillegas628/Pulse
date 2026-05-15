import axios from 'axios'

export const api = axios.create({ baseURL: '/api' })

api.interceptors.request.use((config) => {
  // Inject whichever token is present (professor takes precedence on shared pages)
  const token = localStorage.getItem('professor_token') ?? localStorage.getItem('student_token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      // Clear both tokens and redirect to appropriate login
      const hasProfToken = !!localStorage.getItem('professor_token')
      localStorage.removeItem('professor_token')
      localStorage.removeItem('student_token')
      const dest = hasProfToken ? '/professor/login' : '/student/login'
      if (!window.location.pathname.includes('/login')) {
        window.location.href = dest
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
