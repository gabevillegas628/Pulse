# Quiz Grader — Product spec

## Problem
The instructor gives short paper quizzes where students fill in a metabolic pathway on a
printed template: enzyme names, cofactors on curved arrows, and drawings of selected
intermediates. Versions differ only in which structures are graded (marked with stars).
Grading ~250 by hand is slow and inconsistent. Goal: capture → auto-read → fast human
review → export.

## Users
- Instructor (primary, single user to start; design for adding TAs later).
- Students never use the app.

## Core flows

### 1. Set up a quiz (once per quiz form)
1. Upload the blank quiz PDF (see `samples/`).
2. **Layout editor:** draw/drag boxes over the page for each slot (name, netid, each
   enzyme blank, each cofactor arrow region, each structure region). Assign each a slot ID
   and type. Snap/resize; save as a layout. Works on desktop; phone editing not required.
3. Link the layout to a pathway key and create an assessment (versions, points).
4. **Print-ready export:** stamp the PDF with 4 ArUco corner markers and a QR code
   encoding `{assessment_id, version}`. Generate one PDF per version. (Later: optional
   per-student sheets with student ID in the QR.)

### 2. Capture
Two ingestion paths, same pipeline afterward:
- **Bulk scan (primary for a full class):** upload a multi-page PDF from the department
  copier. Split into pages.
- **Phone capture (PWA):** live camera preview with an overlay; detect markers in-browser
  and show a green frame when the page is flat and fully in view; auto-capture or tap.
  Grade the still, not the video stream. Queue uploads if offline/slow.

### 3. Process (background job per page)
1. **Align:** detect the 4 markers, perspective-warp to template coordinates. If markers
   are missing, fall back to page-contour detection; if still failing, flag the page.
2. **Identify version:** decode the QR. If unreadable, ask the user to pick.
3. **Crop** every slot box (with a small margin) into its own image.
4. **Blank detection** (pixel ink density vs. the blank template's crop) — blank slots
   score 0 without a model call.
5. **Read** non-blank slots with the vision model (see Grading engine).
6. **Identify student:** read name + netid, fuzzy-match against the uploaded course roster.
   Low-confidence matches go to review.
7. **Score** deterministically. Store the per-slot result record (`SCHEMA.md`).

### 4. Review (the main screen)
- **By item:** choose a slot (e.g. "step 6 enzyme"); see every student's crop for it,
  **grouped by normalized transcription**, with the verdict and confidence. Marking a group
  correct/incorrect applies to all members. Sort uncertain groups first.
- **By student:** one paper's crops with scores, for spot checks and regrade requests.
- **Structures:** show the crop beside the feature checklist; the instructor toggles
  features and the points recompute.
- **Alias learning:** when the instructor marks an unmatched transcription correct, offer
  "Add as accepted alias for this answer?" which writes to the pathway key, so it applies
  to future quizzes using that step.
- Every override is logged (who, when, old → new).

### 5. Export
CSV per assessment: netid, name, version, total, per-slot points. Format it so it can be
imported into the Canvas gradebook. (Integration with the host app's gradebook is a later
option.)

### 6. Manage keys
In-app editor for pathway keys (steps, enzyme aliases, cofactor groups, intermediate
features and weights) plus YAML import/export. The seed YAML in `seed/` is the initial
content.

## Grading engine

### Slot types (the whole engine is these handlers)
| type | model task | scoring (code) |
|---|---|---|
| `text` (enzyme) | transcribe the handwriting verbatim + confidence | normalize (case, spaces, hyphens, Greek letters/alpha, subscripts, `+`), then exact alias match → fuzzy match (normalized edit distance; threshold configurable, default ≤ 0.2) → else wrong. Store which alias matched and the distance. |
| `cofactor_set` | list every item written, each tagged `in` or `out` based on its position relative to the arrow (the layout says which end is "in"), + confidence | for each required group in `in`/`out`, satisfied if any accepted form is present on the correct side. Partial credit = satisfied groups / total groups. Items in `optional` are ignored. Extra wrong items: configurable penalty (default none). Wrong side: configurable (default no credit for that group). |
| `structure` | answer each feature question from the key yes/no + confidence; also a one-line description of what's drawn | points × (sum of weights of "yes" features / total weight). Default `review: always`. |
| `identity` (name, netid) | transcribe | fuzzy match to roster |

Blank slots skip the model and score 0.

### Model calls
- Use the Claude API with images (base64). Force structured output via a tool/JSON schema
  so every response parses; validate and retry once on failure.
- **Prompt context per slot:** what the slot is ("enzyme for the step converting X to Y"),
  and for `text`, the *expected* answer and aliases. This greatly improves reading messy
  handwriting, but the model must still transcribe what's written, not what's expected.
  Include an explicit instruction plus a test case: a correct-looking but different enzyme
  must be transcribed as written.
- Batch several slots from one page into one request where it improves cost/latency, but
  keep one result per slot.
- Model per slot type is configurable (env); a cheaper model for text, a stronger one for
  structures.
- **Cache** by (image hash, slot prompt hash) so re-runs don't re-bill.

### Confidence and review policy
Each assessment sets `text_review` and `structure_review` (`always | low_confidence |
never`). A slot needs review if the policy says so, if model confidence < threshold, if a
fuzzy match was near the threshold, or if alignment/version/student-ID was uncertain.

## Non-goals (v1)
Live grading of a video stream; student-facing feedback portal; free-response essays;
multi-page quizzes (design so they're possible later); LMS API integration.

## Success criteria
- On a hand-graded pilot set, text slots agree with the instructor ≥ 98% after review
  policy, and the instructor's total review time for 250 papers is well under hand-grading
  time. Measure both in Phase 0 and again before the first real use.
