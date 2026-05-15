import { Routes, Route, Navigate } from 'react-router-dom'
import { useProfessorAuth } from '@/context/ProfessorAuthContext'
import { useStudentAuth } from '@/context/StudentAuthContext'

// Professor pages
import ProfessorLoginPage from '@/pages/professor/LoginPage'
import ProfessorRegisterPage from '@/pages/professor/RegisterPage'
import DashboardPage from '@/pages/professor/DashboardPage'
import ClassPage from '@/pages/professor/ClassPage'
import SessionPage from '@/pages/professor/SessionPage'

// Student pages
import StudentLoginPage from '@/pages/student/LoginPage'
import StudentRegisterPage from '@/pages/student/RegisterPage'
import CodeEntryPage from '@/pages/student/CodeEntryPage'
import SubmitPage from '@/pages/student/SubmitPage'
import ConfirmationPage from '@/pages/student/ConfirmationPage'
import MyClassesPage from '@/pages/student/MyClassesPage'

function ProfessorProtected({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useProfessorAuth()
  if (isLoading) return null
  if (!isAuthenticated) return <Navigate to="/professor/login" replace />
  return <>{children}</>
}

function StudentProtected({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useStudentAuth()
  if (isLoading) return null
  if (!isAuthenticated) return <Navigate to="/student/login" replace />
  return <>{children}</>
}

export default function App() {
  return (
    <Routes>
      {/* Root redirect */}
      <Route path="/" element={<Navigate to="/student" replace />} />

      {/* Professor routes */}
      <Route path="/professor/login" element={<ProfessorLoginPage />} />
      <Route path="/professor/register" element={<ProfessorRegisterPage />} />
      <Route path="/professor" element={<ProfessorProtected><DashboardPage /></ProfessorProtected>} />
      <Route path="/professor/classes/:classId" element={<ProfessorProtected><ClassPage /></ProfessorProtected>} />
      <Route path="/professor/sessions/:sessionId" element={<ProfessorProtected><SessionPage /></ProfessorProtected>} />

      {/* Student routes */}
      <Route path="/student/login" element={<StudentLoginPage />} />
      <Route path="/student/register" element={<StudentRegisterPage />} />
      <Route path="/student/code" element={<CodeEntryPage />} />
      <Route path="/student" element={<StudentProtected><MyClassesPage /></StudentProtected>} />
      <Route path="/s/:sessionId" element={<SubmitPage />} />
      <Route path="/s/:sessionId/confirmation" element={<ConfirmationPage />} />
    </Routes>
  )
}
