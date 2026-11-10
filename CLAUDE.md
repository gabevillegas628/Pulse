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
- **Names and NetIDs never reach the model.** Only single answer-blank crops are sent;
  identity is matched by a person (or a QR sheet). Guards in `reader.ts` and
  `slotsForVersion` enforce this; keep them.
- **Student work stays out of git.** Scans and crops are FERPA material.
- **Printed pages are permanent.** `PRINT_SCALE` and the marker geometry in
  `backend/src/quizGrader/print.ts` are read back from every quiz already printed; changing
  them breaks those pages. Add a new layout version instead.
- **Edits splice, never re-render.** Stored YAML is changed only through `patchYaml`
  (`backend/src/quizGrader/yamlPatch.ts`), which rewrites just the changed text. Saving
  `stringify(parsed)` would silently reformat the whole file and break clean exports.
