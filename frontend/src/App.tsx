import { useEffect } from 'react'
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom'
import { useProfessorAuth } from '@/context/ProfessorAuthContext'
import { useStudentAuth } from '@/context/StudentAuthContext'
import { setAuthExpiredHandler, setAuthRecoveredHandler } from '@/api/client'
import SessionExpiredModal from '@/components/SessionExpiredModal'

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
import PresentResultsPage from '@/pages/present/PresentResultsPage'
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
  const professorAuth = useProfessorAuth()
  const studentAuth = useStudentAuth()
  const navigate = useNavigate()

  useEffect(() => {
    setAuthExpiredHandler(() => {
      if (professorAuth.professor) {
        professorAuth.triggerSessionExpired()
      } else if (studentAuth.student) {
        studentAuth.triggerSessionExpired()
      }
    })
    setAuthRecoveredHandler(() => {
      professorAuth.resolveSessionExpired()
      studentAuth.resolveSessionExpired()
    })
  }, [professorAuth, studentAuth])

  /**
   * /present is a projector, and this modal is the wrong shape for one twice over: it is a
   * light-themed dialog over a page built for a dark hall, and it prints the professor's
   * email address on the wall in front of the room — on the one surface whose whole rule is
   * that no identity reaches it. The page has its own dark, in-place sign-in for exactly
   * this case, so the modal stays out of its way.
   */
  const onProjector = useLocation().pathname === '/present'

  const expiredProfessor = professorAuth.sessionExpired && !onProjector ? professorAuth.professor : null
  const expiredStudent = studentAuth.sessionExpired && !onProjector ? studentAuth.student : null

  function handleDismiss() {
    professorAuth.clearSessionExpired()
    studentAuth.clearSessionExpired()
    navigate('/login', { replace: true })
  }

  return (
    <>
      {expiredProfessor && (
        <SessionExpiredModal
          open
          role="professor"
          identifier={expiredProfessor.email}
          onLogin={professorAuth.login}
          onDismiss={handleDismiss}
        />
      )}
      {expiredStudent && (
        <SessionExpiredModal
          open
          role="student"
          identifier={expiredStudent.netId}
          onLogin={studentAuth.login}
          onDismiss={handleDismiss}
        />
      )}
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
        {/* Rendered inside a PowerPoint content add-in on a slide. Aggregate only. */}
        <Route path="/present" element={<PresentResultsPage />} />
        <Route path="/q/code/:code" element={<QuestionRedirectPage />} />
        <Route path="/q/:questionId" element={<QuestionPage />} />
        <Route path="/q/:questionId/confirmation" element={<ConfirmationPage />} />
      </Routes>
    </>
  )
}
