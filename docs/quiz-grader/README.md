# Quiz grader in Pulse

Grades photographed or scanned **handwritten pathway quizzes** (glycolysis, TCA, …):
crop each blank, have Claude read the handwriting, score it in code against an editable
key, and send the uncertain items to a review screen. The original handoff is in this
folder. Read `HANDOFF.md` first, then `SPEC.md`, `SCHEMA.md`, `PLAN.md`.

## Where it lives in Pulse

| Piece | Location | Notes |
|---|---|---|
| Content (keys, layouts, assessments) | `docs/quiz-grader/seed/` | YAML. Moves into Postgres in Phase 1 with lossless import/export. |
| Engine | `backend/src/quizGrader/` | `content.ts` (schemas, joining slots to the key), `scoring.ts` (normalisation, fuzzy match, cofactors, structures, review policy), `reader.ts` (Claude calls), `grade.ts` (one page → slot results). Pure except `reader.ts`. |
| Phase 0 spike | `backend/scripts/quiz-grader-spike.ts` | Script only, no DB or UI. |
| Tests | `backend/scripts/smoke-quiz-grader.ts` | `npm run test:quiz-grader --workspace=backend`; runs in CI. |
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
   Open `quiz-spike-out/pages/<page>/overlay.png`: every box should sit over its blank
   (blue = text, purple = structure, grey = judged empty). The glycolysis boxes were
   measured by hand from the sample PDF, so nudge `box:` values in the layout if needed.
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
5. Real point values and partial-credit rules (seed values are placeholders).
6. Structures: auto-score with review, or review-only? **Answer from Phase 0.**
7. TCA: which structures are graded, and is the 9-step numbering right? TCA layout boxes
   are still empty; the arrows run around a circle, so `in_end` must be set per arrow.
8. Lenient answers in the keys (Pi optional for GAPDH, ATP for GTP, Q/QH2 for FAD/FADH2).
9. Per-student QR sheets.
10. TAs reviewing.
