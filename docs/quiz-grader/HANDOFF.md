# Quiz Grader — handoff for Claude Code

A phone/web tool that grades photographed or scanned **handwritten pathway quizzes**
(glycolysis, TCA, and future ones) for a ~250-student biochemistry course. It reads
enzyme names, cofactors, and hand-drawn structures; the instructor reviews uncertain items
and exports grades.

## Read in this order
1. `docs/SPEC.md` — what it does, user flows, grading engine (the core)
2. `docs/SCHEMA.md` — formats for pathway keys, layouts, assessments, results
3. `docs/ARCHITECTURE.md` — stack, services, Railway deployment
4. `docs/PLAN.md` — phased build with acceptance criteria. **Work phase by phase.**
5. `docs/OPEN_QUESTIONS.md` — decisions the instructor must make; ask, don't assume
6. `seed/` — real answer keys and assessments (YAML). `samples/` — the actual blank quizzes.

## Non-negotiable design principles
- **The model reads; code grades.** The vision model only transcribes text and answers
  yes/no feature questions. All scoring is deterministic code driven by the key. Never
  ask the model "is this answer correct?"
- **Quiz-agnostic.** A new quiz = new data (key + layout + assessment), never new code.
  No glycolysis- or TCA-specific logic anywhere in the engine.
- **Keys stay editable** in-app and round-trip to YAML (import/export) losslessly.
- **Human in the loop.** Structures default to review. Every automated verdict is
  overridable, and overrides are logged.
- **Review by item, not by student.** Group identical normalized answers so one decision
  applies to many papers.

## Integrating into an existing project
The instructor intends this to live inside one of his existing projects (likely a
Railway-hosted Node app). Before writing code: inspect the host repo, match its stack,
ORM, auth, and conventions, and propose where this module lives. Put these docs under
`docs/quiz-grader/` and merge this file's principles into the host's CLAUDE.md.
