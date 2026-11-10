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
| Vision service | `vision/` (Python, OpenCV), its own Railway service | Splits PDFs, lines pages up, finds versions, crops boxes. Deploy steps in `vision/README.md`. |
| Scans | `backend/src/quizGrader/scans.ts`, `routes/quizScans.routes.ts` | Uploads, background worker, page images under `<UPLOAD_DIR>/.quiz-scans` (never public). |

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
   npx tsx scripts/quiz-grader-spike.ts --in ~/scans/quiz.pdf --dry-run
   ```
   Use `npx tsx` as shown, not `npm run quiz-grader:spike --`: PowerShell drops the `--`,
   npm then takes `--version` for itself and just prints npm's version number.
   Each page's version is detected (see Phase 2); add `--version A` to force one.
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
   npx tsx scripts/quiz-grader-spike.ts --in ~/scans/quiz.pdf \
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
until their editors exist (layout editor: Phase 2, below).

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

## Phase 2: forms, boxes, printing

**Status:** done. Changed from the handoff's plan with the instructor: no QR code; corner
markers kept for phone capture later.

- **Box editor.** A layout opens on its blank PDF (drawn in the browser with pdf.js), with
  every slot's box over it. Drag to move, corners to resize, draw a box for a slot that has
  none, arrow keys to nudge; edit each slot's kind, what it grades, and for cofactor arrows
  which end is the tail. Saves splice into the YAML like key edits.
- **Blank PDFs** are stored with their layout (one page per version). The starter layouts
  come with the sample PDFs.
- **Printing.** An assessment's **Print** gives each version's page with an ArUco marker
  (DICT_4X4_50, ids 0–3) in each corner, the form shrunk to 90% to clear them
  (`backend/src/quizGrader/print.ts`). Checked with OpenCV
  (`backend/scripts/quiz-grader/verify-markers.py`): all four found on the flat print and
  on simulated angled phone photos, and flattening from the markers alone lands the page
  back on the form. Print at "actual size" if you can; fit-to-page is fine too.
  `PRINT_SCALE` must not change once quizzes are printed.
- **Version detection, no QR.** Marks printed on only one version's form (the stars, on
  the glycolysis quiz) tell the versions apart; each page is matched against all of them
  and called only when one clearly fits. Unsure pages are skipped with their scores, never
  guessed. Versions map to PDF pages by position, or `page:` in the assessment.
- **Copier scans** of new prints line up as before: the line matcher now covers 84–106%
  scale. Pages printed without markers keep working.
- **TCA layout** has boxes for name, NetID, all nine enzyme blanks and all nine cofactor
  arrows. Each arrow's tail end was read off the form; **check them in the box editor**.
  TCA structures are not graded, so they have no boxes.

Marker detection on uploads arrived in Phase 3.

## Phase 3: scans in, pages lined up

**Status:** done, pending deployment of the vision service.

- **Vision service** (`vision/`): a small Python service (FastAPI, OpenCV, pypdfium2) on
  Railway's private network, called only by Pulse with a shared secret. Splits PDFs into
  pages; lines each page up by corner markers, else the form's printed lines, else the
  paper's edges; finds the version; crops every box and flags empty ones. Keeps nothing.
- **Uploads**: an assessment's page has a **Scans** section. Upload a copier PDF (one quiz
  per page) or photos. Pages are processed in the background, two at a time; progress
  updates live. Each upload opens as a grid of its pages; each page opens a debug view
  with the boxes drawn over the lined-up scan, how it was lined up, how well the form's
  lines matched, version fits, and every box's crop.
- **Unsure pages wait**: a page whose version cannot be told is marked "needs version";
  pick it on the page and it is processed again. Any page can be re-processed after a
  layout change, or forced to another version.
- **Privacy**: page images are student work. They are stored on the upload volume under
  `.quiz-scans/`, which the public `/uploads` route never serves, and are read only by
  the owning professor through signed-in requests. Names and NetIDs are cropped but, as
  before, never sent to Claude. The vision service deletes each upload once Pulse has
  every page.
- **Acceptance**: an angled phone photo of a marker print, an angled phone photo of an old
  print, a crooked copier scan of an old print, and a copier scan of a marker print all
  line up (93–100% of the form's lines matching) with the right version, through the real
  upload path: `backend/scripts/smoke-quiz-scans.ts` (22 checks) with fixtures from
  `vision/make_fixtures.py`, and `vision/test_pipeline.py`. These are synthetic pages
  built from the real forms; a run with your own scans and phone photos is the real test.

To deploy: create the `vision` service and set `VISION_URL`/`VISION_TOKEN` on Pulse
(`vision/README.md`). Until then the Scans section says scanning is not set up.

Still open: how long to keep scans (open question 3). Delete an upload to remove its
images now.

## Phase 4: grading in Pulse

**Status:** done. Not connected to the gradebook, on purpose, until there has been more
testing.

- **Automatic.** Once a page is lined up, a background worker sends its answer crops to
  the model (one call for text boxes, one for structures; Haiku 5.5 and Sonnet 5.5, or
  `MODEL_TEXT`/`MODEL_STRUCTURE`) and scores the readings in code against the key, with
  the assessment's rules. Empty boxes are not sent; name and NetID boxes never are.
  Needs `ANTHROPIC_API_KEY` on the server (already there for live themes).
- **Results** per box (`QuizSlotResult`): reading, points, review reasons, and a group key
  so identical answers can be reviewed together in Phase 5. Per page: total, boxes to
  review, model cost. The page view shows each box's crop with its reading and points;
  the upload's grid shows each page's score; **Results** lists every paper.
- **Edits re-score for free.** What the model read is stored on the page, so saving an
  edited key, layout or assessment re-scores every graded page that uses it with no
  model calls (also a **Re-score with current key** button). Reads are cached by model,
  prompt and image, so re-grading an unchanged page costs nothing.
- **Pages from before grading** (like the first real upload) are graded with **Grade
  ungraded pages** on the Results page.
- **Compare with hand grades** on an upload's page takes the spike's hand-grades CSV and
  shows the same agreement table, to repeat the Phase 0 check on pages graded in Pulse.

Tests: `backend/scripts/smoke-quiz-grading.ts` (23 checks, against a running Pulse and
vision service with a stand-in model, `backend/scripts/quiz-grader/mock-claude.mjs`).
Not yet tried with the real model on real scans: that, plus the comparison, is the
acceptance test.

## Phase 5: review

**Status:** done. Still not connected to the gradebook.

- **Review by item** (assessment → Results → **Review**): boxes listed with how many are
  left to review; each box's papers grouped by what was written, flagged groups first,
  with every paper's crop. **Correct**, **Wrong**, or **Keep** (the automatic score) decides
  the whole group, and papers uploaded later with the same answer arrive decided. Click a
  crop to decide that one paper instead.
- **Add to the key from review**: accepting an enzyme answer that was not an exact match
  offers "also accept it in the key"; the alias is spliced into the key's YAML (one line)
  and the assessment is re-scored.
- **Structures** are reviewed one drawing at a time: the model's feature checks are filled
  in, the professor corrects them, and the points follow from the key's rules.
- **By paper**: the page view has 0 / full / undo on every box.
- **Precedence**: a paper's own decision, else its group's, else the automatic score.
  Decisions are stored apart from results, so re-scoring after a key edit never erases
  them. Scores everywhere (Results, upload grid, page view) are after decisions.
- **Audit log**: every decision (group, paper, alias) with who, when, how many papers,
  and points before and after; recent ones at the bottom of Review.

Acceptance: a mock batch reviewed to zero entirely in the browser, with the Results page
agreeing (0 boxes to review). Tests: `backend/scripts/smoke-quiz-review.ts` (22 checks).

## Intermediate names

A fourth kind of graded box, alongside enzyme names, cofactors and structures: an
intermediate's written name (G6P, "fructose 6-phosphate"). In the layout it is a
**Written name** box whose ref is `intermediate.<id>.name`; it is scored like an enzyme
name against the intermediate's name plus its `accept` list in the key, inexact matches go
to review, and review can add a written name to the key. An unnamed intermediate scores 0
without being flagged (its box usually holds the drawing, so it is never "empty").

The assessment controls it: `points: name:` (default 1) and `grade: names:` (`all`, the
default, or a list of intermediate ids). The glycolysis layout has name boxes for its ten
drawn intermediates: on the left they share the structure's box; on the right they run to
the page edge, where students write the name beside the drawing.

What counts, in general: enzyme and cofactor boxes for the steps `grade: enzymes/cofactors`
selects (default all), name boxes for the intermediates `grade: names` selects, and
structures only for the intermediates a version lists. Only boxes the layout has count.

**Re-process all pages** (Results) cuts every page up again after a layout change, then
grades the new boxes; review decisions are kept and unchanged crops come from the cache.

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
9. Per-student QR sheets: the one QR worth considering, to match papers to students
   without reading names. Decide before Phase 4–5. (A per-*version* QR was dropped:
   versions are detected from the printed form.)
10. TAs reviewing.
