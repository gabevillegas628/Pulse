# Quiz grader in Pulse

Grades photographed or scanned **handwritten pathway quizzes** (glycolysis, TCA, …):
crop each blank, have Claude read the handwriting, score it in code against an editable
key, and send the uncertain items to a review screen. The original handoff is in this
folder. Read `HANDOFF.md` first, then `SPEC.md`, `SCHEMA.md`, `PLAN.md`.

## Where it lives in Pulse

| Piece | Location | Notes |
|---|---|---|
| Content (keys, layouts, assessments) | `QuizContent` table, per professor | Stored as YAML source. Starter files in `docs/quiz-grader/seed/`. |
| Content UI | **Paper quizzes** in the professor header (`/professor/quiz-grader`) | List, import/export YAML, answer-key editor. |
| Content API | `backend/src/routes/quizGrader.routes.ts` | Under `/api/quiz-grader`, professor only. |
| Engine | `backend/src/quizGrader/` | `content.ts` (schemas, joining slots to the key), `scoring.ts` (normalisation, fuzzy match, cofactors, structures, review policy), `reader.ts` (Claude calls), `grade.ts` (one page → slot results). Pure except `reader.ts`. |
| Phase 0 spike | `backend/scripts/quiz-grader-spike.ts` | Script only, no DB or UI. |
| Tests | `backend/scripts/smoke-quiz-grader.ts` | `npm run test:quiz-grader --workspace=backend`; pure, runs in CI. |
| API tests | `backend/scripts/smoke-quiz-content.ts` | Needs a running server and database, like the other smoke tests: `E2E_BASE=… npm run test:smoke:quiz-content --workspace=backend`. |
| Later | a "Paper quizzes" tab on the class page | Professor-only. Students never use it. Grades can land in Pulse's gradebook, matched by `Student.netId`, not just a Canvas CSV. |

Pulse already supplies much of what the handoff's architecture lists: Prisma/Postgres,
professor auth, the Anthropic SDK with structured output (`themes.service.ts`), an upload
volume, CSV export, a PWA manifest, and a precedent for a sidecar container (Indigo). The
Python vision service in `ARCHITECTURE.md` (OpenCV alignment) arrives in Phase 3, as
a second sidecar.

## Phase 0: running the spike

**Status:** built and tested end to end against fake pages and a local stand-in for the API.
It has not yet been run on real handwriting, which is the point of Phase 0.

What it does per page: resample to letter at 200 dpi, crop every slot box from
`seed/layouts/glycolysis-template-v1.yaml`, skip slots with no more ink than the blank
form, send the remaining answer crops (never the name or NetID; see below) as text crops to `MODEL_TEXT` (default `claude-haiku-5-5`) and the
structure crops to `MODEL_STRUCTURE` (default `claude-sonnet-5-5`), one request each per
page, then score in code.

1. **Scan ~20 filled quizzes of one version** on the copier into PDFs (any number of
   pages per PDF; each page is one quiz) or page images. Pass one file, or a folder of them.
   Phone photos only work after a scanner app has flattened and cropped them to the page
   edge (Notes, Drive, Adobe Scan). Real alignment is Phase 3.
2. **Dry run.** No API calls. It checks the boxes and writes a grades template:
   ```bash
   cd backend
   npx tsx scripts/quiz-grader-spike.ts --in ~/scans/quiz.pdf --version A --dry-run
   ```
   Use `npx tsx` as shown, not `npm run quiz-grader:spike --`: PowerShell drops the `--`,
   npm then takes `--version` for itself and just prints npm's version number.
   Each scan is first lined up against the blank form (shift, scale, tilt up to 1.5°);
   the output prints how far off each page was, and warns if under 60% of the form's
   lines could be matched. Open `quiz-spike-out/pages/<page>/overlay.png` — the
   straightened page with the boxes drawn on — and check every box sits over its blank
   (blue = text, purple = structure, grey = judged empty). "Empty" means no ink beyond
   what is printed on the blank form, pencil included.
3. **Hand-grade** by filling in `quiz-spike-out/hand-grades-template.csv`: points per
   slot, with the same point values as the assessment (enzyme 1, cofactors 1, structure 2).
   Use fractions for partial credit (0.5).
4. **Full run:**
   ```bash
   npx tsx scripts/quiz-grader-spike.ts --in ~/scans/quiz.pdf --version A \
     --grades quiz-spike-out/hand-grades-template.csv
   ```
   The API key comes from `backend/.env` (`ANTHROPIC_API_KEY`). To set it for one
   PowerShell window instead: `$env:ANTHROPIC_API_KEY = "sk-ant-..."`.
   Read `quiz-spike-out/report.md`: agreement per slot type, the disagreements (unflagged
   ones first, since nobody would catch those), cost per page and seconds per page. Reads
   are cached in `quiz-spike-out/cache`, so re-running after fixing a hand grade is free.

`quiz-spike-out/` holds crops of student work and is git-ignored. Delete it when done.

**Decision Phase 0 feeds:** are structures auto-scored with review, or review-only?
(Question 6 below.)

## Names and NetIDs never go to the model

The handoff's step 6 had the model read each paper's name and NetID. Pulse doesn't do
that. The name and NetID boxes are cropped and saved locally (`pages/<page>/name.png`,
`netid.png`), and a person matches papers to students: you in the spike, and the review
screen later, or a per-student QR sheet (open question 9). Every crop the model sees is a
single answer blank with nothing that identifies the student.

Two guards keep it that way: `readTextRegions` throws if handed a name or NetID slot, and
`slotsForVersion` refuses a layout whose answer box overlaps the name or NetID box, since
that crop would carry the name along. Both are tested.

## Phase 0 results (20 real version-A papers)

First run: $0.01 per page, ~12 s per page. Enzymes 96.5% and cofactors 92.7% agreement
on unflagged slots. Nearly every miss was a key or settings issue, not a misread:

| Miss | Fix |
|---|---|
| "G3P dehydrogenase", "PFKI" marked wrong | aliases added to the key |
| "glyceraldehyde 3-phosphate hydrogenase", "enolate" passed as typos | every inexact match now goes to review |
| "2ATP", "2NAD+" not recognised | leading amounts ignored for cofactors |
| GAPDH without Pi given credit | Pi now required going in |
| Structures 1.7% (graded out of 1, key used 2) | structures 1 point, all or nothing |
| Structure and step-5 crops cutting writing off | boxes enlarged |

Decided by the instructor: **Pi required for GAPDH; structures and cofactors are 1 point,
all or nothing** (`partial_credit: false` in the assessments). A required cofactor written
on the wrong side as well as the right one fails its group. Structures stay
**review-always**: the model's feature checklist is a suggestion; the instructor is more
lenient than the checklist (e.g. full credit for a PEP drawn without its C=C).

## Phase 1: content in the database

**Status:** done. Answer keys, layouts and assessments live in Pulse, one row each per
professor, as their YAML text. **Paper quizzes** in the professor header lists them,
imports and exports YAML, loads the glycolysis/TCA starters, and edits answer keys:
accepted enzyme names, cofactor groups in and out, optional cofactors, intermediates'
names, structure features and weights. Layouts and assessments are import/export only
until their editors exist (layout editor: Phase 2).

**Lossless round trip.** The stored YAML is the record. An unedited export is
byte-identical to the import. An edit is saved by splicing only the changed text into
the file (`backend/src/quizGrader/yamlPatch.ts`), so comments and hand formatting
survive and the export diffs cleanly: adding an alias in the editor changes exactly that
one line. Re-rendering the parsed file was tried and rejected: the YAML library
normalises spacing on every line.

Guards: a save made from an out-of-date copy is refused; a key or layout an assessment
uses cannot be deleted or renamed; schema problems are listed with their path
(`steps.6.enzyme.accept: Required`); assessments warn about missing keys, layouts,
unresolvable refs and undrawn boxes.

Not yet wired: the spike script still reads `docs/quiz-grader/seed`, not the database.
The grading pipeline (Phase 3–4) reads from the database.

## Changes from the handoff

- **Seed YAML bug fixed.** Names containing a comma (`1,3-bisphosphoglycerate`,
  `fructose 1,6-bisphosphate`, `F1,6BP`, `fructose-1,6-bisphosphate aldolase`) were
  unquoted inside `[...]` lists, so YAML split each into two answers ("fructose 1" and
  "6-bisphosphate"). They are now quoted, and a test guards it.
- **Shared boxes.** On the glycolysis form an enzyme blank and its cofactor arrow
  overlap, so `sN_enzyme` and `sN_cofactors` share a box. The crop is sent once and the
  model returns both slots.
- **"3-P" means 3-phosphate.** Normalisation expands a number followed by `P`, so
  "glyceraldehyde 3-P dehydrogenase" (the example in `SCHEMA.md`) matches.
- **Short abbreviations match exactly.** Fuzzy matching skips aliases under five
  letters: "PKK" is not "PK".
- **Blank detection leans toward reading.** A missed answer silently scores 0, while a
  false "not blank" only costs a cheap read, so the empty-ink cutoff is low.

## Open questions (from `OPEN_QUESTIONS.md`)

1. ~~Host project~~: Pulse.
2. ~~FERPA~~: names and NetIDs are never sent (above); the model sees anonymous answer
   crops, in line with the typed answers grading and themes already send.
3. Image retention after export.
4. ~~Roster source~~: Pulse's own roster (`Student.netId`) is the likely answer.
5. ~~Points~~: 1 point per enzyme, cofactor set and structure; cofactors and structures
   all or nothing.
6. ~~Structures~~: review-always, with the model's checklist as a suggestion.
7. TCA: which structures are graded, and is the 9-step numbering right? TCA layout boxes
   are still empty; the arrows run around a circle, so `in_end` must be set per arrow.
8. Lenient answers in the keys: ~~Pi optional for GAPDH~~ (required). Still open for TCA:
   ATP alongside GTP, Q/QH2 alongside FAD/FADH2.
9. Per-student QR sheets.
10. TAs reviewing.
