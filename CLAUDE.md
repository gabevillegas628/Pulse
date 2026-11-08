# Pulse

Classroom response tool for Biochemistry 395. See `README.md` for setup and
`docs/codebase-map.html` for the layout.

## Quiz grader (`backend/src/quizGrader/`, `docs/quiz-grader/`)

Grades scanned handwritten pathway quizzes. Start at `docs/quiz-grader/README.md`, and
work phase by phase from `docs/quiz-grader/PLAN.md`, stopping at phase boundaries.

- **The model reads; code grades.** The vision model only transcribes text and answers
  yes/no feature questions. All scoring is deterministic code driven by the key. Never
  ask the model "is this answer correct?"
- **Quiz-agnostic.** A new quiz is new data (key + layout + assessment), never new code.
  No glycolysis- or TCA-specific logic in the engine.
- **Keys stay editable** in-app and round-trip to YAML losslessly.
- **Human in the loop.** Structures default to review. Every automated verdict is
  overridable, and overrides are logged.
- **Review by item, not by student.** Group identical normalised answers so one decision
  applies to many papers.
- **Student work stays out of git.** Scans and crops are FERPA material.
