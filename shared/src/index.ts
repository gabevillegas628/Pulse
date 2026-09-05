// Browser-only card renderer. Safe to re-export: nothing runs at import time, and
// the backend never calls it.
export * from './qrCard.js'

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
  isAdmin: boolean
  deactivatedAt: string | null
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
  /** Default for live AI theming of free-text answers; questions may override it. */
  liveThemesDefault: boolean
  /** Default for auto-closing questions once answers stop arriving; questions may override it. */
  autoCloseDefault: boolean
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
  sessionId: string | null
  assignmentId: string | null
  title: string
  text: string | null
  order: number
  createdAt: string
}

export interface Question {
  id: string
  sessionId: string | null
  assignmentId: string | null
  groupId: string | null
  /** Professor-facing short label for navigation; students never see it */
  title: string | null
  text: string
  type: QuestionType
  options: string[] | null
  order: number
  accessCode: string
  correctAnswer: string | null
  tolerance: number | null
  unit: string | null
  /**
   * Live AI theming for this question's free-text answers.
   * null inherits the class default; true/false override it. FREE_TEXT only.
   */
  liveThemes: boolean | null
  /**
   * Auto-close this question once answers stop arriving.
   * null inherits the class default; true/false override it. Applies to every type.
   */
  autoClose: boolean | null
}

/** One class meeting â the event entity for IN_CLASS sessions */
export interface SessionRun {
  id: string
  sessionId: string
  sectionId: string | null
  status: SessionStatus
  openedAt: string
  closedAt: string | null
  createdAt: string
  section?: { id: string; name: string } | null
}

/** IN_CLASS question set â authoring entity */
export interface Session {
  id: string
  classId: string
  title: string
  accessCode: string
  /** DRAFT = being built; OPEN = has been run; ARCHIVED = done */
  status: SessionStatus
  createdAt: string
  updatedAt: string
  runs?: SessionRun[]
  questions?: Question[]
}

/** Homework assignment */
export interface Assignment {
  id: string
  classId: string
  title: string
  status: SessionStatus
  deadline: string | null
  createdAt: string
  updatedAt: string
}

export interface Response {
  id: string
  questionId: string
  studentId: string
  runId: string | null
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
  title?: string
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
  sessionId: string | null
  assignmentId: string | null
  text: string
  type: QuestionType
  options: string[] | null
  order: number
  accessCode: string
  unit: string | null
  /** Set when this is a session question */
  session?: {
    id: string
    title: string
    status: SessionStatus
    class: { name: string }
  }
  /** Set when this is an assignment question */
  assignment?: {
    id: string
    title: string
    status: SessionStatus
    deadline: string | null
    class: { name: string }
  }
  alreadyAnswered: boolean
}

// Dashboard types (enriched)

export interface ResponseWithStudent extends Response {
  student: Pick<Student, 'id' | 'netId'>
}

export interface QuestionWithResponses extends Question {
  responses: ResponseWithStudent[]
}

export interface SessionDetail extends Session {
  questions: QuestionWithResponses[]
  groups: QuestionGroup[]
  class: Pick<Class, 'id' | 'name' | 'liveThemesDefault' | 'autoCloseDefault'>
  runs: SessionRun[]
  enrolledCount: number
}

// Admin system view: every professor with every class and the numbers that make
// a forgotten account visible. Answer counts exclude drafts.
export interface AdminClassSummary {
  id: string
  name: string
  joinCode: string
  createdAt: string
  enrollmentCount: number
  sessionCount: number
  assignmentCount: number
  responseCount: number
  lastResponseAt: string | null
}

export interface AdminProfessorSummary extends Professor {
  classes: AdminClassSummary[]
}

// Admin student management. responseCount is every response row, drafts
// included — it is the number a delete would take with it.
export interface AdminStudentSummary {
  id: string
  netId: string
  email: string
  createdAt: string
  responseCount: number
  enrollments: Array<{ classId: string; className: string }>
}

export interface ClassWithCounts extends Class {
  _count: { sessions: number; enrollments: number }
  sessions: Array<{ id: string; title: string; status: string; createdAt: string }>
  participationRate: number | null
}

export interface UpcomingAssignment {
  id: string
  title: string
  classId: string
  className: string
  deadline: string
  questionCount: number
  submittedCount: number
}

export interface SessionWithCounts extends Session {
  _count: { responses: number }
  questions: Question[]
}

// âââ View model types (used by frontend pages) ââââââââââââââââââââââââââââââââ

/** AI grading / summarize response category */
export interface SummaryCategory {
  label: string
  description: string
  count: number
}

/**
 * A persisted live-theme category. A superset of SummaryCategory, so anything that
 * renders the latter accepts these unchanged. `count` is derived server-side from the
 * per-response assignments and is never stored, so it cannot go stale.
 */
export interface ThemeCategory extends SummaryCategory {
  id: string
  /** The "Still forming" bucket â low-confidence answers, never a real theme. */
  isOther: boolean
}

export type ThemeSetStatus = 'WAITING' | 'BOOTSTRAPPING' | 'ACTIVE' | 'RECLUSTERING' | 'FAILED'

/** Persisted themes for one question in one session run. */
export interface ThemeSet {
  status: ThemeSetStatus
  categories: ThemeCategory[]
  /** Responses with a category assigned. Lags `total` while classification catches up. */
  classified: number
  total: number
  model: string | null
  /** WAITING only: answers needed before categories appear at all. */
  need?: number
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
  correctAnswer: string | null
  response: { responseText: string; wordCount: number; isFlagged: boolean; submittedAt: string; aiScore: number | null } | null
  /** Score computed by gradeSession (null for open/unscored sessions) */
  score: number | null
  /** Whether this question was graded and counts toward earned/max */
  counted: boolean
}

/** A session or assignment as returned by the student activity endpoint */
export interface ActivitySession {
  id: string
  title: string
  type: 'IN_CLASS' | 'HOMEWORK'
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

/** A graded session/assignment entry in a student's grade summary */
export interface GradeSession {
  id: string
  title: string
  type: 'IN_CLASS' | 'HOMEWORK'
  date: string | null
  earned: number
  max: number
}

/** A single question entry in a student's session/assignment grade detail */
export interface GradeQuestion {
  id: string
  text: string
  type: string
  options: string[] | null
  order: number
  correctAnswer: string | null
  response: { responseText: string; aiScore: number | null; submittedAt: string } | null
  score: number
  /** Whether this question was graded and counts toward earned/max */
  counted: boolean
}

/** Full question-level breakdown for one closed session or assignment */
export interface GradeSessionDetail {
  id: string
  title: string
  type: 'IN_CLASS' | 'HOMEWORK'
  questions: GradeQuestion[]
  earned: number
  max: number
}

/** A session/assignment column descriptor for the professor gradebook */
export interface GradebookSession {
  id: string
  title: string
  type: 'IN_CLASS' | 'HOMEWORK'
  questionCount: number
}

/** A student row in the professor gradebook */
export interface GradebookStudentRow {
  studentId: string
  netId: string
  section: string | null
  scores: Array<{ sessionId: string; earned: number; max: number }>
  participationTotal: number
  participationMax: number
  hwTotal: number
  hwMax: number
}
