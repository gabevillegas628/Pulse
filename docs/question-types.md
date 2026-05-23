# Question Types Reference

Each question type maps to the `QuestionType` enum in `shared/src/index.ts` and the `Question` model in `backend/prisma/schema.prisma`.

---

## Shared DB Fields (all types)

| Field | Type | Notes |
|-------|------|-------|
| `id` | `String` | cuid |
| `sessionId` | `String` | parent session/assignment |
| `groupId` | `String?` | null = standalone question |
| `text` | `String` | rich text JSON (Tiptap) |
| `type` | `QuestionType` | enum below |
| `options` | `Json?` | used by MULTIPLE_CHOICE only |
| `correctAnswer` | `String?` | meaning varies by type — see below |
| `tolerance` | `Float?` | NUMERIC only |
| `unit` | `String?` | NUMERIC only, display label |
| `order` | `Int` | sort order within session |
| `accessCode` | `String` | unique 4-digit code for live sessions |

---

## Type Definitions

### `FREE_TEXT`
Students enter arbitrary text.

- **`options`** — unused
- **`correctAnswer`** — optional reference answer, shown to the AI grader as a rubric hint; not shown to students
- **`tolerance` / `unit`** — unused
- **Grading** — AI grades and returns a score in `[0, 1]` stored as `aiScore` on the `Response`. Score of 1.0 is assumed if AI hasn't run yet.
- **Student input** — `<textarea>`

---

### `MULTIPLE_CHOICE`
Students pick one option from a predefined list.

- **`options`** — `string[]` JSON array, the list of choices (≥2 required)
- **`correctAnswer`** — must be one of the `options` values; can only be set once the session is CLOSED
- **`tolerance` / `unit`** — unused
- **Grading** — exact string match: 1.0 if correct, 0.5 if answered but wrong, 0.0 if no response. If `correctAnswer` is null, full credit awarded to all responses.
- **Student input** — radio button list

---

### `YES_NO`
Binary choice.

- **`options`** — unused (choices are hardcoded `["Yes", "No"]`)
- **`correctAnswer`** — must be `"Yes"` or `"No"`; can only be set once CLOSED
- **`tolerance` / `unit`** — unused
- **Grading** — same logic as MULTIPLE_CHOICE (exact match → 1.0, wrong → 0.5, missing → 0.0)
- **Student input** — two styled radio buttons

---

### `RATING`
Students pick a number 1–5. Participation only; no concept of a correct answer.

- **`options`** — unused
- **`correctAnswer`** — unused (always null); setting it throws a 400
- **`tolerance` / `unit`** — unused
- **Grading** — always 1.0 for any response (participation credit)
- **Student input** — row of 5 toggle buttons

---

### `NUMERIC`
Students enter a number. Graded against a professor-set answer ± tolerance.

- **`options`** — unused
- **`correctAnswer`** — the correct numeric value stored as a **string** (e.g. `"6.02e23"`, `"-273.15"`). Parsed with `parseFloat()` at grading time — both standard and scientific notation are supported.
- **`tolerance`** — acceptable deviation from `correctAnswer`. A student answer `s` is correct if `|s - correct| ≤ tolerance`. Defaults to `0` if null (exact match required).
- **`unit`** — optional display-only label shown as a suffix next to the student's input field (e.g. `"mol/L"`, `"kJ/mol"`). Not validated; purely cosmetic.
- **Grading** — 1.0 if within tolerance, 0.0 otherwise. No partial credit.
- **`correctAnswer` restriction** — can be set at question creation time and patched at any session status (unlike MC/YES_NO which require CLOSED). This is intentional: the answer is authoring metadata for NUMERIC, not a grading secret.
- **Student input** — `<input type="text">` (not `type="number"` — preserves scientific notation display and avoids browser-specific formatting quirks), followed by unit label if set.

---

## Grading Score Values

Scores are stored as `Float` on `Response.aiScore` (for FREE_TEXT) or computed at read time for the other types. The `calcScore()` function in both `sessions.routes.ts` and `responses.routes.ts` implements this logic.

| Score | Meaning |
|-------|---------|
| `1.0` | Full credit |
| `0.5` | Partial credit (MC/YES_NO wrong answer) |
| `0.0` | No credit |
| `null` | Not yet graded (FREE_TEXT before AI run) |

---

---

### `MULTI_SELECT`
Students check all options that apply (zero or more).

- **`options`** — `string[]` JSON array, the list of choices (≥2 required)
- **`correctAnswer`** — JSON string of a `string[]` subset of options, e.g. `'["Option A","Option C"]'`; can only be set once the session is CLOSED
- **`tolerance` / `unit`** — unused
- **Grading** — exact set match (order-independent): 1.0 if correct set, 0.5 if answered but wrong set, 0.0 if no response or empty selection. If `correctAnswer` is null, full credit.
- **Student input** — checkbox list

---

### `ORDERING`
Students drag items into the correct sequence.

- **`options`** — `string[]` JSON array, the items to order (≥2 required); presented shuffled to students
- **`correctAnswer`** — JSON string of a `string[]` with the same items in the correct order, e.g. `'["Step 1","Step 2","Step 3"]'`. **Auto-set at creation** to `JSON.stringify(options)` — the order professor enters items is the correct order. Can be patched at any session status (bypass CLOSED like NUMERIC).
- **`tolerance` / `unit`** — unused
- **Grading** — exact sequence match: 1.0 if correct order, 0.5 if answered but wrong order, 0.0 if no response.
- **Student input** — dnd-kit drag-and-drop list (items shown shuffled)

---

---

### `STRUCTURE`
Students draw a chemical structure using the JSME molecule editor. Stored as a SMILES string.

- **`options`** — unused
- **`correctAnswer`** — unused; no automated equivalence checking
- **`tolerance` / `unit`** — unused
- **Grading** — manual override only (same pattern as FREE_TEXT): default 1.0, professor clicks score badge to set 0.5 or 0.0. Submitted structures are rendered back to the professor via `smiles-drawer` in the response list.
- **`correctAnswer` restriction** — N/A
- **Student input** — JSME editor (`@loschmidt/jsme-react`); `disabled` after submission shows the drawn structure read-only. SMILES string stored in `responseText`.
- **Implementation note** — JSME loads its JS from CDN on first render (lazy-loaded in React via `Suspense`). Structural equivalence checking is not implemented — requires a cheminformatics backend (RDKit/Indigo) and is out of scope.

---

## Planned / Backlog Types

- **Structure drawing** — ~~tabled~~ **implemented** as `STRUCTURE` above. `@ketcher-software/ketcher-react` is not on npm. Best current options: JSME via `@loschmidt/jsme-react` (works now, dated UI) or Ketcher built from source (best UX, manual build). Rendering of submitted SMILES: `smiles-drawer` (already installed). Grading: professor manual override, default 1.0.
- **Balanced chemical reaction** — tabled; grading semantics unresolved (see project backlog)
