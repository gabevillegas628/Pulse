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
- **`correctAnswer`** — must be one of the `options` values; cannot be changed while a run is open (see the gate note at the end)
- **`tolerance` / `unit`** — unused
- **Grading** — exact string match: 1.0 if correct, 0.5 if answered but wrong, 0.0 if no response. If `correctAnswer` is null, full credit awarded to all responses.
- **Student input** — radio button list

---

### `YES_NO`
Binary choice.

- **`options`** — unused (choices are hardcoded `["Yes", "No"]`)
- **`correctAnswer`** — must be `"Yes"` or `"No"`; cannot be changed while a run is open (see the gate note at the end)
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
- **`unit`** — optional label shown as a suffix next to the student's input field (e.g. `"mol/L"`, `"kJ/mol"`). Also the grading unit when `correctAnswer` carries none: student answers are converted into it with mathjs. Validated on save by `numericKeyProblem` — a unit mathjs cannot parse (`%`, `ppm`) would mark every answer wrong, so it is refused. For a percent, leave the unit blank and say "as a percent (0–100)" in the question.
- **Grading** — 1.0 if within tolerance, 0.0 otherwise. No partial credit.
- **`correctAnswer` restriction** — can be set at question creation time and patched at any session status (unlike MC/YES_NO which require CLOSED). This is intentional: the answer is authoring metadata for NUMERIC, not a grading secret.
- **Student input** — `<input type="text">` (not `type="number"` — preserves scientific notation display and avoids browser-specific formatting quirks), followed by unit label if set.

---

## When the answer key can be changed

`PATCH /sessions/:id/questions/:qid` refuses a `correctAnswer` change **while a run is
open**, except for `NUMERIC`, `ORDERING`, `STRUCTURE` and `BLANKS`, which are exempt because their
key is authoring metadata rather than something the room is racing to guess
(`bypassClosedCheck` in `questions.routes.ts`).

Note this is *not* "only once CLOSED" — an earlier version of this document said so, and it
misled a UI that hid the key until a run had happened. Before any run exists, every type
can be keyed freely, which is when you would normally do it. `FREE_TEXT` is **not** exempt,
and its rubric hint is stored in `correctAnswer`, so that field is read-only mid-run too.

Changing `options` nulls a `correctAnswer` that no longer matches them, so a key never
outlives the choices it referred to.

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
- **`correctAnswer`** — JSON string of a `string[]` subset of options, e.g. `'["Option A","Option C"]'`; cannot be changed while a run is open (see the gate note at the end)
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
- **`correctAnswer`** — an InChI string. Set it by drawing the molecule: `StructureKeyField`
  puts a Ketcher editor in front of the professor, hands the molfile to the PATCH route, and
  the backend converts it with `toInchi()`. Submitted structures go through the same
  conversion on the way in, so the comparison is InChI against InChI and **structure
  questions grade automatically**.
- **`tolerance` / `unit`** — unused
- **Grading** — 1.0 on an InChI match, 0.5 for a wrong structure, 1.0 for everyone if no key is set. A manual `aiScore` override still wins, as it does for every type. Submitted structures are rendered back to the professor via `smiles-drawer` in the response list.
- **`correctAnswer` restriction** — exempt from the open-run gate, like NUMERIC and ORDERING
- **Student input** — JSME editor (`@loschmidt/jsme-react`); `disabled` after submission shows the drawn structure read-only. SMILES string stored in `responseText`.
- **Implementation note** — JSME loads its JS from CDN on first render (lazy-loaded in React via `Suspense`). Equivalence checking **is** implemented, against the Indigo service that runs as its own container and is reached through the app's authenticated `/api/indigo` proxy. An earlier version of this document called it out of scope; that has not been true for some time.

---

### `BLANKS`
Fill in the blanks: several short prompts answered in one go. In-class sessions only for
now; the assignment routes and pickers do not offer it.

- **`options`** — `string[]`, the prompts, one per blank (1–10). Each is shown with its own
  input. Editing them carries each blank's key entry along by matching wording, so a
  reorder keeps the key and a new prompt starts unkeyed.
- **`correctAnswer`** — JSON string of a `string[]`, one entry per prompt, accepted
  alternatives separated by `/` (e.g. `'["capitulum / capitellum","olecranon fossa"]'`).
  An empty entry leaves that blank unkeyed; all empty is stored as null. Exempt from the
  open-run gate, like NUMERIC: the key never reaches a student, and adding a spelling after
  seeing the room's answers is when it gets edited.
- **`tolerance` / `unit`** — unused
- **Student answer** — JSON string of a `string[]` the same length as `options`, each
  trimmed and at most 200 characters. Some blanks may be empty; all empty is refused.
- **Matching** — lenient on purpose (`shared/src/blanks.ts`, used by backend grading and
  every screen). Ignores case, accents, punctuation, small words (the, of, and…) and a
  trailing plural; forgives one typo on 4–5 letter words, two on 6–9, a fifth of the length
  beyond. Word by word and in any order, so a list counts however it is ordered. Generic
  structural nouns ("end", "fossa", "process"…) may be left off — "acromial" for
  "acromial end" — but not swapped: "olecranon process" does not match "olecranon fossa".
  Extra words are allowed up to the key's own count plus one, so a sentence around the
  answer counts and a list of guesses does not. Known cost: near-identical terms
  (ilium/ileum) match each other.
- **Grading** — per blank: 1 if close, 0.5 for a non-matching attempt, 0 if empty, 1 for any
  attempt on an unkeyed blank; the question score is the average. No key at all → full
  credit, and not counted until a key is set, like the other keyed types. Manual override
  wins as always.
- **Projector** — answers are withheld by `/addin/live` until at least 75% of the room
  (students who have answered anything in this run) has answered **and** answers have
  paused for 10 seconds (`services/reveal.service.ts`). The count keeps moving meanwhile.
  Once revealed it stays revealed for the run. Revealed answers carry a per-blank
  `blankVerdicts` array instead of the key.

---

## Planned / Backlog Types

- **Structure drawing** — ~~tabled~~ **implemented** as `STRUCTURE` above. `@ketcher-software/ketcher-react` is not on npm. Best current options: JSME via `@loschmidt/jsme-react` (works now, dated UI) or Ketcher built from source (best UX, manual build). Rendering of submitted SMILES: `smiles-drawer` (already installed). Grading: professor manual override, default 1.0.
- **Balanced chemical reaction** — tabled; grading semantics unresolved (see project backlog)
