# Data formats

Three content layers, all YAML-importable/exportable, stored in Postgres.

## 1. Pathway key — `seed/keys/*.yaml`
Reusable biochemistry. See the comments at the top of `glycolysis.yaml` for conventions.
```yaml
pathway: glycolysis
intermediates:
  <id>: { name, accept: [...], features: [...], feature_weights?: [...] }
steps:
  <n>:
    from: [<intermediate id>]
    to:   [<intermediate id>]
    enzyme:    { accept: [canonical, alias, ...] }
    cofactors: { in: [[any-of], ...], out: [[any-of], ...], optional: [...] }
```
- An enzyme can appear in multiple steps (e.g. aconitase in TCA steps 2 and 3).
- Alias additions from the review screen append to `enzyme.accept`.

## 2. Layout — `seed/layouts/*.yaml`
Geometry of one printed form. Coordinates are **fractions of page width/height** (0–1), so
they survive any scan resolution. Boxes are drawn in the layout editor; the seed files list
slot IDs/types with `box: null` to be filled in.
```yaml
layout: glycolysis-template-v1
page: { size: letter, source_pdf: samples/glycolysis-quiz-versions-ABC.pdf }
markers: { dictionary: DICT_4X4_50, ids: [0, 1, 2, 3] }   # TL, TR, BR, BL
slots:
  - { id: s1_enzyme, type: text, ref: step.1.enzyme, box: [x, y, w, h] }
  - { id: s1_cofactors, type: cofactor_set, ref: step.1.cofactors, in_end: top, box: [...] }
  - { id: int_f6p, type: structure, ref: intermediate.f6p, box: [...] }
```

## 3. Assessment — `seed/assessments/*.yaml`
Which slots are graded, points, review policy, versions (see seed files). The QR on each
printed page encodes `{assessment_id, version}`.

## 4. Result record (per student × slot, DB)
```json
{
  "page_id": "...", "student_id": "...", "slot_id": "s6_enzyme",
  "status": "blank | read | error",
  "transcription": "glyceraldehyde 3-P dehydrogenase",
  "normalized": "glyceraldehyde3pdehydrogenase",
  "match": { "alias": "glyceraldehyde 3-phosphate dehydrogenase", "distance": 0.08 },
  "cofactors_read": [{ "text": "NAD+", "side": "in" }],
  "features": [{ "feature": "phosphate on C6", "answer": true, "confidence": 0.9 }],
  "model_confidence": 0.93,
  "points_auto": 1, "points_final": 1, "max_points": 1,
  "needs_review": false,
  "override": { "by": "...", "at": "...", "from": 0, "to": 1, "note": "" },
  "crop_url": "...", "model": "...", "prompt_version": "..."
}
```

## Core tables (suggested)
`pathway_keys`, `layouts`, `assessments`, `assessment_versions`, `rosters`, `students`,
`batches` (an upload), `pages` (image, alignment status, version, student match),
`slot_results`, `answer_groups` (assessment × slot × normalized text → verdict),
`overrides` (audit log), `model_cache`.
