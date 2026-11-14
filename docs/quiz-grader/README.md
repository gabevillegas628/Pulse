# Quiz grader in Pulse

Grades photographed or scanned **handwritten pathway quizzes** (glycolysis, TCA, …):
crop each blank, have Claude read the handwriting, score it in code against an editable
key, and send the uncertain items to a review screen. The original handoff is in this
folder. Read `HANDOFF.md` first, then `SPEC.md`, `SCHEMA.md`, `PLAN.md`.

## Where it lives in Pulse

| Piece | Location | Notes |
|---|---|---|
| Content (keys, layouts, assessments) | `QuizContent` table, per professor | Stored as YAML source. Starter files in `docs/quiz-grader/seed/`. |
| Content UI | **Paper quizzes** in the professor header (`/professor/quiz-grader`) | One page per quiz: setup checklist, answer key, boxes, versions, scoring, print, scans. YAML import/export under Files. |
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
- **One server, on a volume.** Scan images are on the Pulse server's own disk, while the
  scan and grading queues are in the database. So `UPLOAD_DIR` must be inside the service's
  volume (or every redeploy erases the scans), and only one Pulse server may work from a
  database: two split a batch's pages between their disks, and each shows the other's pages
  as missing (and fails to grade pages the other cut up). Each server checks in to
  `QuizServer` every 30 seconds (`quizGrader/servers.ts`); the quiz page warns about either
  problem, and a grade that finds its images missing fails at once saying so.

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

**Boxes at the page edge reach the paper's edge.** Pulse prints the form at 90% to make room
for the corner markers, so the paper runs about half an inch past the printed form on every
side, and long answers run into it. On a page found by its markers, a box drawn within 1% of
the form's edge in the Boxes tab is cut out to within 0.06 in of the paper's edge on that
side (the corner markers are never counted as writing). Boxes clear of the edge are cut
exactly as before. Pages printed without markers are the form at full size, so their boxes
stop at the form's edge. Existing pages pick this up on **Re-process all pages**.

**Re-process all pages** (Results) cuts every page up again after a layout change, then
grades it again; review decisions are kept. Model reads are cached per page and kind
(written answers, structures), so what did not change costs nothing, and a page that
gained name boxes has its written answers read again (a fraction of a cent with Haiku).

## Setting up a quiz (the quiz page)

A quiz is one assessment plus its own answer key and blank form: **one key per quiz**.
**Paper quizzes** lists quizzes; **New quiz** makes the three files from a title
(`store.ts` `newQuizFiles`) and opens the quiz page, whose tabs are:

- **Overview**: setup checklist (key, blank form, boxes, versions), print buttons, scans, results.
- **Answer key**: intermediates first, then steps (from/to, enzyme names, cofactors).
  Removing a step or intermediate also removes its boxes and version ticks.
- **Boxes**: the list of everything gradable is derived from the key (student name and
  NetID, each step's enzyme and cofactors, each intermediate's name and structure). Pick an
  item, drag on the form. Drawing a box makes the item graded; the tick beside it turns
  grading off and on without losing the box (this writes `grade:` in the settings). "Use the
  enzyme's/structure's box" copies a shared box. Boxes touching the name/NetID box show red.
- **Versions**: intermediates × versions ticks (structures graded) and the page each prints from.
- **Scoring**: points per kind, all-or-nothing vs partial credit, review rules, in words.
- **Files**: the three YAML files, to download.

The page edits all three files as one draft; Save sends `PUT /quiz-grader/quizzes/:id` with
whichever changed. Each is spliced by `patchYaml` (an empty `{}`/`[]` in a new quiz grows into
indented lines; a new key lands after the key it follows), and graded papers are re-scored
once. Uploading the blank form keeps the layout's `updatedAt`, so it never makes an open
page's save look stale. The data model did not change: existing quizzes open as they are,
and an optional `title:` names a quiz.

## Students and grades out (part of Phase 7)

Papers are matched to students by hand: **Results → Match students** shows each paper's
name and NetID crops beside a search over the roster of the Pulse class the quiz is linked
to (`QuizContent.classId`, set on that screen). Type a few letters, Enter takes the top match
and moves to the next paper. The NetID is stored on the page (`QuizPage.studentNetId`), so an
export still says whose paper it was if the student later leaves the class. A NetID not on
the roster is allowed and flagged, as is one used on two papers. Nothing here reaches a
model. (Reading NetIDs with an open handwriting model on the vision service was tried and
dropped: too slow on CPU, and the readings were not usable.)

**Download grades (CSV)** (`GET /quiz-grader/content/:id/export.csv`, `?boxes=1` for a column
per box): one row per paper with NetID, email, score after review decisions, out of, boxes
still to review, version, upload, page and a note (not matched, not on the roster, two papers,
not graded, review not finished), then each roster student with no paper. Cells are guarded
against spreadsheet formulas.

## Quizzes belong to classes

A paper quiz belongs to one class (`QuizContent.classId` on its settings file), like a
session or an assignment. It is made and run from the class page's **Paper Quizzes** tab,
and its papers are matched against that class's roster. **Paper quizzes**
(`/professor/quiz-grader`) is now an overview by class, with the YAML import and export.

- **New quiz** and **Add glycolysis & TCA examples** create quizzes in the class.
- **Copy setup there** (quiz Overview, or "Copy a quiz from another class" on the tab) and
  **Duplicate class** copy a quiz's answer key, boxes, blank form and settings, never its
  scans or grades (`quizGrader/copy.ts`). File names are unique per professor, so a copy
  gets fresh ones (`glycolysis-quiz-2`) and its settings are re-pointed at its own key and
  boxes through `patchYaml`: only the naming lines change.
- **Move there** moves a quiz with its scans and grades. Quizzes made before this change
  show on every class tab under "Not in any class yet", one click to move in.
- Moving a quiz or uploading its blank form keeps the files' `updatedAt`, which only guards
  edits to their text.

## Second looks at near misses

The fast text reader (Haiku) is sometimes sure of a misread: "Endase" for a cramped
"Enolase" scored 0 with no flag. So an enzyme or name reading gets a second, blind look by a
stronger model (`MODEL_SECOND_LOOK`, default Sonnet) when it is illegible, unsure (below
the confidence threshold), or within about a third of the letters of an accepted answer
(`SECOND_LOOK_DISTANCE`, 0.34; "aldolase" for enolase is 0.38 and gets none). Cofactors and
structures never do; names and NetIDs never reach any model.

- The second look is told neither the expected answer nor the first reading
  (`readSecondLook` in `reader.ts`): a reader told what to expect tends to see it.
- Code compares (`gradePage` in `grade.ts`). The same reading: it stands, with no flag for
  being close (a real mistake), and an unsure right answer is settled. A different reading
  that would score differently: review, showing both ("A closer second look read it as
  'Enolase', which is an accepted answer"). Two spellings that are both accepted: nothing
  to decide. The automatic score follows the first reading until you decide.
- Second readings are stored with the page's reads (`reads.second`) and cached like the
  first, so re-scoring never calls a model.
- **Results → Second looks** runs them, in the background, for papers graded before this
  existed.

## In the class gradebook

A quiz's scores reach its class gradebook, and its students, only once released
(**Results → Gradebook → Release**; `QuizContent.releasedAt`). The panel first lists what is
not settled: boxes still to review (their automatic scores count until decided), papers not
graded, papers not matched, NetIDs not on the roster, NetIDs on two papers. After release it
stays live: review decisions and key edits flow through. **Take back** removes it again.

- One place works it out, `quizGrader/gradebook.ts`, for the release check, the gradebook,
  the class CSV and the student view, so they agree.
- Each released quiz is a **Quiz** column (after sessions and homework) with a **Quiz
  Total**; a cell opens that student's paper. A matched paper scores its points after review;
  a roster student with no paper scores 0 unless **excused** (Match students → No paper;
  `QuizExcusal`), and then counts for nothing ("exc"). A NetID on two papers, or a matched
  paper not graded yet, shows "…" and counts for nothing until settled.
- The class CSV export gains a column per quiz, a Quiz Total and a Quiz Max ("excused" and
  "pending" written out).
- Students see each released quiz as a score only, in a Quizzes group: no breakdown and no
  scans. An excused or unsettled quiz is left out for them rather than shown as 0.

## Fewer unsure flags

A first real batch (115 CAC papers) put 950 boxes in review, 787 of them "unsure":
cofactors (365) and structures (294) mostly. So:

- **Cofactors get second looks too**, when unsure, when an item's side could not be
  placed, or when the arrow was read as empty though the box has ink. The two readings are
  compared item by item and side by side.
- **A second look settles any answer whose two readings score the same**: the same words,
  two accepted spellings, two wrong answers, or two cofactor lists worth the same. Only a
  disagreement that changes the score goes to review. An arrow read as empty twice is not
  flagged for its ink (the enzyme name sharing the box, usually).
- **All-or-nothing structures** are flagged only when a doubtful check could change the
  score (`decidingConfidence` in `grade.ts`): a check the model is sure is missing scores
  the drawing 0 whatever the doubtful ones say. With partial credit, every check counts.
- **Results** shows model calls and cost per model, and how many answers had a second look
  and how many still disagree.

After those changes the batch still had 573 "unsure" flags, so two more:

- **Two readers agreeing settles an answer whatever they rated themselves** (it used to keep
  the higher confidence and still flag it under 80%). Independent agreement is the evidence.
- **Drawings get second looks too**, from Opus 5.5 (`MODEL_STRUCTURE_SECOND_LOOK`), since
  Sonnet reads them first: only the doubtful checks that could change the score
  (`doubtfulChecks`), blind. Agreement settles the drawing; disagreement goes to review
  naming the checks ("A second, closer look … disagreed about: …").
- A second look that fails (an error, a refusal) never fails the page: it is graded without.

For papers already graded: **Second looks**, then the flags update; **Re-score with current
key** applies the rules. Neither re-grades a paper or touches a decision.

## Suggested structure checks

A drawing scores only if every check is yes, so one badly worded check marks every correct
paper wrong, with confidence. "Carboxylates on carbons 2 and 4" on α-ketoglutarate did
exactly that: true with one numbering, false with the usual one. The Key tab now helps
write checks, and tests them before they are used.

1. **Upload your filled-in key** (PDF or photo of the quiz with the answers drawn in). It
   is lined up like a scan and each structure box is cut out (`keyDrawings.ts`). A box
   catches ink from the answers beside it, so a page whose detected version draws that
   intermediate is preferred. Stored in `QuizKeyDrawings`, apart from the YAML. If boxes
   move, **Cut again**.
2. **Suggest checks** (`suggest.ts`). One call (Opus, `MODEL_SUGGEST`) sees every key
   drawing and writes checks for each graded structure. The rules: one yes/no fact; true for
   any correct drawing however drawn; no carbon numbers or layout words; together false for
   every other molecule in the pathway.
3. **Tested by code.** The grading reader (`MODEL_STRUCTURE`) answers every list on every
   key drawing, one call per drawing. Lists are labelled l1, l2… so it is never told which
   molecule a list is for. Then code tallies:
   - a molecule's own drawing must pass all its checks;
   - every other drawing must fail at least one.

   Lists with problems go back once with what went wrong; a revision is kept only if it does
   better. A check the key's own drawing still fails is left out, and listed. The current
   checks are tested the same way, so the Key tab shows both side by side.
4. **Use these** puts the checks in the unsaved changes (dropping any weights); **Save** as
   usual. A run costs well under a dollar.

The model writes the key here; it never grades. The results live in memory until the
server restarts.

**Changing checks reads drawings again.** A drawing's answers are matched to its checks by
position, so re-scoring old answers against new checks was wrong. Pages now record the
checks each drawing was asked (`reads.checks`). After a key edit, a graded page whose
drawings were asked other checks is queued to be graded again: its drawings are read with
the new checks, and its written answers come from the cache. Pages read before this change
are caught by the edit's changed intermediates, or by a different number of answers.

## Empty answers in review

A box that looks empty scores 0 without a flag. There are two ways that happens:
- **Left empty:** the ink check found too little ink, so the box was never sent to the model.
- **Read as empty:** the model said nothing was written. Intermediate names are never flagged
  for this, because a name box nearly always holds ink from the drawing beside it.

Either can miss real writing, and that 0 is never seen otherwise. So the review page has an
**Empty answers** view, beside **To review** and **All boxes**. It lists every box with
answers scored as empty, and shows the two kinds separately. Each paper is decided on its
own; there is no "Correct for all", since that would credit every empty answer in the class.

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
