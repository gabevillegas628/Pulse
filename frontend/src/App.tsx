import { Routes, Route, Navigate } from 'react-router-dom'
import { useProfessorAuth } from '@/context/ProfessorAuthContext'
import { useStudentAuth } from '@/context/StudentAuthContext'

import LoginPage from '@/pages/LoginPage'
import RegisterPage from '@/pages/RegisterPage'

// Professor pages
import DashboardPage from '@/pages/professor/DashboardPage'
import ClassPage from '@/pages/professor/ClassPage'
import SessionPage from '@/pages/professor/SessionPage'
import AssignmentDetailPage from '@/pages/professor/AssignmentDetailPage'

// Student pages
import CodeEntryPage from '@/pages/student/CodeEntryPage'
import QuestionPage from '@/pages/student/QuestionPage'
import QuestionRedirectPage from '@/pages/student/QuestionRedirectPage'
import ConfirmationPage from '@/pages/student/ConfirmationPage'
import MyClassesPage from '@/pages/student/MyClassesPage'
import StudentClassPage from '@/pages/student/StudentClassPage'
import AssignmentPage from '@/pages/student/AssignmentPage'
import StudentTextbookPage from '@/pages/student/StudentTextbookPage'

function ProfessorProtected({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useProfessorAuth()
  if (isLoading) return null
  if (!isAuthenticated) return <Navigate to="/login?role=professor" replace />
  return <>{children}</>
}

function StudentProtected({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useStudentAuth()
  if (isLoading) return null
  if (!isAuthenticated) return <Navigate to="/login" replace />
  return <>{children}</>
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/student" replace />} />

      {/* Unified auth */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />

      {/* Legacy redirects */}
      <Route path="/professor/login" element={<Navigate to="/login?role=professor" replace />} />
      <Route path="/professor/register" element={<Navigate to="/register?role=professor" replace />} />
      <Route path="/student/login" element={<Navigate to="/login" replace />} />
      <Route path="/student/register" element={<Navigate to="/register" replace />} />

      {/* Professor routes */}
      <Route path="/professor" element={<ProfessorProtected><DashboardPage /></ProfessorProtected>} />
      <Route path="/professor/classes/:classId" element={<ProfessorProtected><ClassPage /></ProfessorProtected>} />
      <Route path="/professor/classes/:classId/assignments/:assignmentId" element={<ProfessorProtected><AssignmentDetailPage /></ProfessorProtected>} />
      <Route path="/professor/sessions/:sessionId" element={<ProfessorProtected><SessionPage /></ProfessorProtected>} />

      {/* Student routes */}
      <Route path="/student/enter-code" element={<CodeEntryPage />} />
      <Route path="/student" element={<StudentProtected><MyClassesPage /></StudentProtected>} />
      <Route path="/student/classes" element={<StudentProtected><MyClassesPage /></StudentProtected>} />
      <Route path="/student/classes/:classId" element={<StudentProtected><StudentClassPage /></StudentProtected>} />
      <Route path="/student/classes/:classId/textbook" element={<StudentProtected><StudentTextbookPage /></StudentProtected>} />
      <Route path="/student/assignments/:assignmentId" element={<StudentProtected><AssignmentPage /></StudentProtected>} />
      <Route path="/q/code/:code" element={<QuestionRedirectPage />} />
      <Route path="/q/:questionId" element={<QuestionPage />} />
      <Route path="/q/:questionId/confirmation" element={<ConfirmationPage />} />
    </Routes>
  )
}
