# Build plan

Work in order; each phase ends with something the instructor can try. Stop and ask at
phase boundaries.

## Phase 0 — Feasibility spike (before any UI)
Script only. Hand-measure slot boxes for ONE glycolysis version; take ~20 real (or
instructor-filled mock) quizzes; crop; run model reads; score with the seed key; compare
with the instructor's hand grades.
**Done when:** a short report lists per-slot-type agreement, failure examples (especially
structures and cofactor sides), cost per page, and seconds per page. The instructor decides
whether structures are auto-scored or review-only.

## Phase 1 — Content layer
DB schema; YAML import/export for keys, layouts, assessments (lossless round-trip test);
seed from `seed/`; simple key editor (aliases, cofactor groups, features, weights).
**Done when:** editing a key in-app and exporting YAML diffs cleanly against the seed.

## Phase 2 — Templates
Upload blank PDF → layout editor (draw/resize/label boxes, assign type + ref) → stamp
markers + per-version QR → printable PDFs.
**Done when:** both sample quizzes have complete layouts and print-ready PDFs.

## Phase 3 — Ingest + alignment (vision service)
Bulk PDF upload and single-photo upload; page splitting; marker alignment with contour
fallback; QR version read; cropping; blank detection. Debug view showing aligned page with
boxes overlaid.
**Done when:** a skewed phone photo and a copier scan both align so all boxes land on
their blanks.

## Phase 4 — Grading engine
Slot handlers, prompts with structured output, batching, caching, roster matching,
deterministic scoring, review flags.
**Done when:** unit tests cover normalization, fuzzy matching, cofactor sides/partial
credit, feature weighting; the Phase 0 set reproduces or beats the spike's agreement.

## Phase 5 — Review UI
By-item grouped review, by-student view, structure feature toggles, overrides with audit
log, alias-learning prompt, progress indicator ("37 items need review").
**Done when:** the instructor grades a full mock batch end to end without touching the DB.

## Phase 6 — Phone capture (PWA)
Camera with marker-based framing overlay, auto-capture, upload queue, works on iOS Safari
and Android Chrome.

## Phase 7 — Export + deploy
CSV export in a Canvas-importable format; Railway deploy (web, vision, postgres, storage);
retention job for images.
