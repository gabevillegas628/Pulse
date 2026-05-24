// Enums

export enum SessionStatus {
  DRAFT = 'DRAFT',
  OPEN = 'OPEN',
  CLOSED = 'CLOSED',
  ARCHIVED = 'ARCHIVED',
}

export enum QuestionType {
  FREE_TEXT = 'FREE_TEXT',
  MULTIPLE_CHOICE = 'MULTIPLE_CHOICE',
  RATING = 'RATING',
  YES_NO = 'YES_NO',
  NUMERIC = 'NUMERIC',
  MULTI_SELECT = 'MULTI_SELECT',
  ORDERING = 'ORDERING',
  STRUCTURE = 'STRUCTURE',
}

// Entities

export interface Professor {
  id: string
  email: string
  name: string
  createdAt: string
  updatedAt: string
}

export interface Student {
  id: string
  netId: string
  email: string
  createdAt: string
  updatedAt: string
}

export interface Class {
  id: string
  professorId: string
  name: string
  description: string | null
  joinCode: string
  textbookRepo: string | null
  textbookPath: string | null
  textbookBranch: string | null
  createdAt: string
  updatedAt: string
}

export interface Enrollment {
  studentId: string
  classId: string
  enrolledAt: string
}

export interface QuestionGroup {
  id: string
  sessionId: string
  title: string
  text: string | null
  order: number
  createdAt: string
}

export interface Question {
  id: string
  sessionId: string
  groupId: string | null
  text: string
  type: QuestionType
  options: string[] | null
  order: number
  accessCode: string
  correctAnswer: string | null
  tolerance: number | null
  unit: string | null
}

export interface Session {
  id: string
  classId: string
  title: string
  accessCode: string
  status: SessionStatus
  createdAt: string
  updatedAt: string
  closedAt: string | null
  questions?: Question[]
}

export interface Response {
  id: string
  questionId: string
  studentId: string
  responseText: string
  wordCount: number
  isFlagged: boolean
  aiScore: number | null
  submittedAt: string
}

// API request / response types

export interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: string
}

// Auth

export interface ProfessorLoginRequest {
  email: string
  password: string
}

export interface ProfessorRegisterRequest {
  name: string
  email: string
  password: string
}

export interface ProfessorLoginResponse {
  token: string
  professor: Professor
}

export interface StudentLoginRequest {
  credential: string  // netId or email
  password: string
}

export interface StudentRegisterRequest {
  netId: string
  email: string
  password: string
}

export interface StudentLoginResponse {
  token: string
  student: Student
}

// Classes

export interface CreateClassRequest {
  name: string
  description?: string
}

// Sessions

export interface CreateQuestionInput {
  text: string
  type: QuestionType
  options?: string[]
  order: number
}

export interface CreateSessionRequest {
  title: string
  questions: CreateQuestionInput[]
}

// Responses

export interface SubmitResponseRequest {
  questionId: string
  responseText: string
}

// Student question view (enriched)
export interface StudentQuestion {
  id: string
  sessionId: string
  text: string
  type: QuestionType
  options: string[] | null
  order: number
  accessCode: string
  unit: string | null
  session: {
    id: string
    title: string
    status: SessionStatus
    class: { name: string }
  }
  alreadyAnswered: boolean
}

// Dashboard types (enriched)

export interface SessionWithCounts extends Session {
  _count: { responses: number }
  questions: Question[]
}

export interface ClassWithCounts extends Class {
  _count: { sessions: number; enrollments: number }
}

export interface ResponseWithStudent extends Response {
  student: Pick<Student, 'id' | 'netId'>
}

export interface QuestionWithResponses extends Question {
  responses: ResponseWithStudent[]
}

export interface SessionDetail extends Session {
  questions: QuestionWithResponses[]
  groups: QuestionGroup[]
  class: Pick<Class, 'id' | 'name'>
  qrDataUrl: string
}

// ─── View model types (used by frontend pages) ────────────────────────────────

/** AI grading / summarize response category */
export interface SummaryCategory {
  label: string
  description: string
  count: number
}

/** Aggregate stats shown on a student's class activity tab */
export interface StudentStats {
  totalResponses: number
  sessionsParticipated: number
  totalClosedSessions: number
  averageWordCount: number
}

/** A single question within a student's activity feed */
export interface ActivityQuestion {
  id: string
  text: string
  type: string
  number: number
  response: { responseText: string; wordCount: number; isFlagged: boolean; submittedAt: string } | null
}

/** A session with its questions, as returned by the student activity endpoint */
export interface ActivitySession {
  id: string
  title: string
  status: string
  createdAt: string
  questions: ActivityQuestion[]
}

/** A homework assignment row shown in student assignment lists */
export interface AssignmentRow {
  id: string
  title: string
  status: string
  deadline: string | null
  questionCount: number
  submittedCount: number
  earnedScore: number | null
  maxScore: number | null
}

/** A graded session entry in a student's grade summary */
export interface GradeSession {
  id: string
  title: string
  earned: number
  max: number
}
