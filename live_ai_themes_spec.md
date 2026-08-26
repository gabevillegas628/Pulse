# Live AI Themes — Implementation Spec

Supersedes the design fork in `live_ai_results_handoff.md`. That document asked four open
questions; this one answers them and specifies the build. Read the handoff first for its
constraints section — it is still accurate and is not repeated here.

**Decision that shapes everything below:** this is a **real classroom feature**, not a demo prop.
It will be used weekly in Gabe's own course. Where demo-optimal and classroom-optimal diverge,
classroom wins — the talk in mid-November 2026 is a deadline, not the requirement.

---

## 1. Decisions locked

| Question | Decision | Why |
|---|---|---|
| Design fork A vs B | **B** — bootstrap then classify incrementally | Bars grow monotonically; the mechanism is legible |
| Teaching or demo feature | **Teaching** | Stated requirement. Drives override + the "Forming" bucket |
| Who triggers it | **Automatic in the lecture, opt-in at authoring time** | See below |
| Fate of the summarize button | **Becomes the bootstrap** — same prompt, now persisted | No new professor-facing surface |
| Categories across runs | **Keyed to `runId`** — fresh every run | No cross-year bias; rehearsals reset cleanly |
| Model | **Opus 5 to bootstrap, Haiku 4.5 to classify** | Spend where errors compound, save where they don't |

### The trigger, resolved

Two rules were in tension. The product thesis says *no mid-lecture setup step, ever*. Prudence for
a real feature says *don't fire LLM calls unbidden*.

Resolve it by moving the choice out of the lecture entirely:

- `Class.liveThemesDefault` — a class-level default, set once.
- `Question.liveThemes` — a per-question override (`null` = inherit).

Both are set while authoring, never during a show. In the lecture the behaviour is fully automatic:
at `BOOTSTRAP_N` answers the categories appear and bars start growing, with nothing to click.
Opt-in is preserved and the thesis is not violated.

Default is **off**. Some free-text questions deserve theming ("what's still confusing?"); some do
not ("what's your lab section?").

---

## 2. Data model

Three new tables, two new config columns, two new enums. No changes to existing columns.

```prisma
enum ThemeSetStatus {
  WAITING        // enabled, not enough answers yet
  BOOTSTRAPPING  // deriving categories now
  ACTIVE         // categories exist, classifying incrementally
  RECLUSTERING   // re-deriving categories
  FAILED         // gave up; /present falls back to counts
}

enum ThemeSource {
  AI
  PROFESSOR
}

model ThemeSet {
  id              String          @id @default(cuid())
  questionId      String
  runId           String
  question        Question        @relation(fields: [questionId], references: [id], onDelete: Cascade)
  run             SessionRun      @relation(fields: [runId], references: [id], onDelete: Cascade)
  status          ThemeSetStatus  @default(WAITING)
  model           String?         // which model produced the categories, for the record
  bootstrapN      Int?            // how many answers seeded it
  classifyCalls   Int             @default(0)  // cost ceiling counter
  lastClusteredAt DateTime?
  createdAt       DateTime        @default(now())
  updatedAt       DateTime        @updatedAt
  categories      ThemeCategory[]

  @@unique([questionId, runId])
  @@index([runId])
}

model ThemeCategory {
  id          String          @id @default(cuid())
  themeSetId  String
  themeSet    ThemeSet        @relation(fields: [themeSetId], references: [id], onDelete: Cascade)
  label       String
  description String
  order       Int
  isOther     Boolean         @default(false)
  assignments ResponseTheme[]

  @@index([themeSetId])
}

model ResponseTheme {
  id          String        @id @default(cuid())
  responseId  String        @unique
  categoryId  String
  response    Response      @relation(fields: [responseId], references: [id], onDelete: Cascade)
  category    ThemeCategory @relation(fields: [categoryId], references: [id], onDelete: Cascade)
  confidence  Float?
  source      ThemeSource   @default(AI)
  assignedAt  DateTime      @default(now())

  @@index([categoryId])
}
```

Plus back-relations on `Question`, `SessionRun`, `Response`, and:

```prisma
// on Class
liveThemesDefault Boolean @default(false)
// on Question
liveThemes        Boolean?   // null = inherit the class default
```

### Why a join table rather than `Response.categoryId`

`Response` is hot and widely selected — including by the identity-stripped `/addin/live` payload.
A foreign key there means every existing `select` has to think about it, and `confidence`/`source`
would widen the row for a feature most responses never use. A separate table keeps the blast radius
at zero and lets counts fall out of a `groupBy` on `ResponseTheme.categoryId`, so **`count` is
derived and can never go stale** — requirement 2 of the handoff.

### Why classifications never need invalidating

In-class responses are immutable: [responses.routes.ts:257](backend/src/routes/responses.routes.ts#L257)
rejects a second submission, enforced by `@@unique([questionId, studentId])`. Assign once, done.
(The homework path upserts drafts — this feature is session-only and must not touch it.)

### The "Forming" bucket

Every theme set gets exactly one category with `isOther: true`, **created server-side** — never
invented by the model. Low-confidence classifications land there instead of being forced into a
wrong bin. It renders as "Still forming" rather than "Other", so an unsorted answer reads as
in-progress rather than as a judgement. This is the cheapest 80% of "the AI was wrong in front of
30 students".

---

## 3. Backend

### 3.1 The worker

No queue infrastructure exists — `runAiGradingAsync` is simply an un-awaited async call. Match that
pattern rather than introducing one.

New module `backend/src/services/themes.service.ts`:

```
scheduleThemeWork(questionId, runId)   // debounce entry point, never throws
drainThemeWork(questionId, runId)      // does one unit of work, emits, may reschedule
```

Constants:

| Name | Value | Note |
|---|---|---|
| `BOOTSTRAP_N` | 8 | answers before categories are derived |
| `CLASSIFY_BATCH` | 8 | small, so bars step visibly rather than lurching |
| `DEBOUNCE_MS` | 2000 | quiet period after the last answer |
| `MAX_WAIT_MS` | 6000 | ceiling, so a steady stream still fires |
| `RECLUSTER_OTHER_RATIO` | 0.30 | share in the Forming bucket that triggers a re-cluster |
| `RECLUSTER_MIN_TOTAL` | 20 | don't re-cluster on thin data |
| `RECLUSTER_COOLDOWN_MS` | 60000 | never churn labels on the projector |
| `MAX_CLASSIFY_CALLS` | 60 | hard cost ceiling per theme set (~480 answers) |

Debounce state is a module-level `Map` keyed by `questionId` + `runId`, holding the pending timer
and the timestamp of the first queued item (so `MAX_WAIT_MS` can be enforced).

> **Single-instance assumption.** In-memory debounce means two app instances would both classify.
> Railway currently runs one. If that changes, add a `claimedAt` column to `ThemeSet` and claim with
> a conditional update before doing work. Documented, not built.

### 3.2 Hook into response creation

In [responses.routes.ts:278](backend/src/routes/responses.routes.ts#L278), immediately after the
existing `new_response` emit and **after** the 201 response is sent:

```ts
// Fire and forget: a student must never wait on an LLM to see their answer accepted.
if (question.type === 'FREE_TEXT' && themesEnabled(question, cls)) {
  scheduleThemeWork(questionId, openRun.id)
}
```

Wrapped so a throw can never surface on the student's request path.

### 3.3 State machine

```
WAITING ──(unclassified >= 8)──> BOOTSTRAPPING ──ok──> ACTIVE ──> ACTIVE (classify batches)
   │                                   │                  │
   │                                 fail          (Forming > 30%, cooled down)
   └──(still < 8: emit progress)       ▼                  ▼
                                    FAILED           RECLUSTERING ──> ACTIVE
```

`WAITING` still emits on every drain with `{have, need}`, so the projector can show
"Finding themes… 5 of 8". That progress line is the mechanism made visible — worth having for the
talk, and genuinely informative in a real lecture.

### 3.4 Prompts and structured outputs

**Bootstrap** reuses the wording of the existing `runAiSummarize`, with two changes: drop `count`
from the output (it is derived now), and do not ask for an "other" category — the server appends it.

> **Amended during phase 1.** Bootstrap also returns an assignment for every answer it was shown,
> not categories alone. The model has already read each answer in order to cluster them, so a
> separate classification pass over that same text pays twice for nothing — and with categories
> alone, phase 1 would have shown every count as zero. The phase 2 classifier therefore handles
> only answers arriving *after* the bootstrap. Assignments below `MIN_CONFIDENCE` (0.6), out of
> range, or omitted entirely all fall to the Forming bucket.

**Classify** is where structured outputs earn their keep. Constrain `categoryId` to an enum of the
known ids plus `"other"`, so a drifting label becomes impossible by construction rather than by
parsing.

```ts
import * as z4 from 'zod/v4'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'

const assignmentSchema = (categoryIds: string[]) => z4.object({
  assignments: z4.array(z4.object({
    index:      z4.number().int(),
    categoryId: z4.enum([...categoryIds, 'other'] as [string, ...string[]]),
    confidence: z4.number().min(0).max(1),
  })),
})

const res = await anthropic.messages.parse({
  model: 'claude-haiku-4-5',
  max_tokens: 1024,
  temperature: 0,
  output_config: { format: zodOutputFormat(assignmentSchema(ids)) },
  messages: [{ role: 'user', content: prompt }],
})
const parsed = res.parsed_output   // null if parsing failed — guard, don't assert
```

> **Gotcha.** `zodOutputFormat` imports from `zod/v4`. The rest of the backend uses classic
> `import { z } from 'zod'` (the v3 API). Both ship inside the installed zod 3.25.76, but schemas
> from the two entry points cannot be mixed. Keep request validation on `z` and output formats
> on `z4`.

> **Verified in phase 2.** `claude-haiku-4-5` handles enum-constrained structured outputs correctly
> and keeps every returned id inside the enum. It also **accepts `temperature`**, unlike Opus 5 —
> so the classify call sets `temperature: 0` and the bootstrap call must not.
>
> One behaviour worth knowing: the model returns `"other"` with *high* confidence when it is sure an
> answer fits nothing (junk scored 0.95). So `"other"` means Forming regardless of its score, and the
> `MIN_CONFIDENCE` floor applies only to the real categories. Treating a high-confidence `"other"` as
> a good match would put junk straight onto the projector.

> **`temperature` is deprecated on Opus 5.** Sending it returns a 400 — an
> `invalid_request_error` reading *"temperature is deprecated for this model"* — and the whole call
> fails. Found by the phase 1 smoke test. The grading calls on `claude-sonnet-4-6` still accept it, so
> do not assume a parameter that works there works here. Check this again when wiring the phase 2
> classifier.

Anything with `confidence < 0.6`, and any response the model omits from its answer, goes to the
Forming bucket. Never guess.

**Prompt caching does not apply here** and should not be built for: question text plus four category
descriptions is ~300–400 tokens, well under the ~1024-token minimum cacheable prefix. The handoff
left this to be verified; it is answerable on paper.

### 3.5 Cost

Per free-text question with 100 students: one bootstrap (~$0.008 on Opus 5) plus ~12 classify
batches (~$0.023 total on Haiku 4.5) ≈ **$0.03**. Five such questions a lecture ≈ $0.15. A 28-lecture
semester ≈ **$4.20 per class per semester**. `MAX_CLASSIFY_CALLS` exists to bound a bug, not the bill.

### 3.6 Endpoints

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/addin/live` | **Extended** — see below |
| `POST` | `/api/sessions/:sid/questions/:qid/themes/bootstrap` | Force bootstrap or re-cluster. Replaces the summarize button's behaviour |
| `GET` | `/api/sessions/:sid/questions/:qid/themes` | Task-pane read. Professor-only, **may** include identity |
| `PATCH` | `/api/sessions/:sid/questions/:qid/responses/:rid/theme` | Professor override → `source: PROFESSOR` |

The existing `POST .../summarize` stays for the assignment path, which has no runs and no live view.

### 3.7 `/api/addin/live` changes

Two changes, one of which **tightens** the existing privacy invariant.

**Drop `responseText` for FREE_TEXT questions.** Today
[addin.routes.ts:376](backend/src/routes/addin.routes.ts#L376) selects it for every question type,
and the e2e guard at [e2e-qr.ts:386](backend/scripts/e2e-qr.ts#L386) only asserts `netId` is absent.
So raw student answers are currently one rendering bug away from the projector — and free text is
quasi-identifying ("like I said in office hours yesterday…"), which is exactly what the invariant
exists to prevent.

This is safe to remove *only* for FREE_TEXT: `ResultsSummary` reads `responseText` for
MULTIPLE_CHOICE, NUMERIC, YES_NO, MULTI_SELECT, ORDERING and STRUCTURE, but its FREE_TEXT branch
([ResultsSummary.tsx:182-206](frontend/src/components/ResultsSummary.tsx#L182-L206)) uses only
`isFlagged` and `wordCount`. Categories replace the need for text — so this feature is what makes
the tightening possible.

**Add a `themes` object** to each FREE_TEXT question, aggregate-only:

```ts
themes: {
  status: 'WAITING' | 'BOOTSTRAPPING' | 'ACTIVE' | 'RECLUSTERING' | 'FAILED'
  categories: Array<{ id: string; label: string; description: string; count: number; isOther: boolean }>
  classified: number      // responses with an assignment
  total: number           // responses overall
  need?: number           // WAITING only: BOOTSTRAP_N
} | null                  // null when the feature is off for this question
```

No `responseId`, no `studentId`, no per-response detail. Same discipline as the rest of the payload.

### 3.8 Socket event

One event, not two — status is a field, so the projector never has to reconcile two sources.

```
themes_updated → `${sessionId}:professor`
{ questionId, runId, ...the themes object above }
```

Emitted to the room [socket.ts:26](backend/src/socket.ts#L26) already joins professors to, and which
`/present` already joins. No new plumbing.

---

## 4. Frontend

### 4.1 Extract `ThemeBars`

`ThemesBody` in [LiveMonitorPanel.tsx:175](frontend/src/components/LiveMonitorPanel.tsx#L175) is
aggregate-safe and close to what is wanted — but it lives in the same file as `WallBody`, which
renders netIDs and raw text. Move the bar list to `frontend/src/components/ThemeBars.tsx` and import
it from both places, so `/present` **cannot** reach `WallBody` even by an autocomplete accident.

Additions over today's `ThemesBody`: the Forming bucket rendered muted and always last regardless of
count; a `classified/total` line ("42 of 51 sorted") so a lagging classifier is honest rather than
invisible; and count transitions animated on width only.

### 4.2 `/present` wiring

- The `themes_updated` handler must be wrapped in `flushSync`, same as the existing `new_response`
  handler. Non-negotiable in an unfocused add-in frame.
- Include themes in the poll fallback so a dead socket still updates.
- Render below the participation bar, replacing the FREE_TEXT counts block when
  `status === 'ACTIVE'`.
- `status === 'FAILED'` falls back to the existing counts plus a quiet "Themes unavailable" line.
  Never blank.

### 4.3 Full-screen legibility

Venue is undecided, so `/present` must read well both in a small add-in frame and full-screen in a
browser at 1920×1080 — the fallback if the talk turns out to be hybrid, since PowerPoint Live does
not render content add-ins.

The floors are fine; **the ceilings are the problem.** The question text is
`clamp(15px, 2.8vw, 30px)`: at 1920px wide, `2.8vw` is 54px but the cap pins it to 30px, so it looks
tiny on a projector. Same for the counter at `clamp(38px, 9vw, 96px)`.

Raise the ceilings to roughly what the `vw` term yields at 1920 (question → `54px`, counter →
`170px`, and proportionally for the rest). **This changes nothing below ~1070px viewport width**,
because the `vw` term is what binds there — so the add-in path is untouched and needs no
re-testing.

---

## 5. Failure modes

| Failure | Behaviour |
|---|---|
| Anthropic API down or erroring | Retry the batch once, then `FAILED`. Projector falls back to counts + status line |
| Classifier slow, answers piling up | `classified < total` shown honestly. Bars keep growing as batches land |
| Model returns a bad or missing assignment | Response goes to the Forming bucket. Never a silent wrong bin |
| Categories are simply wrong | Professor re-clusters from the task pane, or overrides individual responses |
| Fewer than `BOOTSTRAP_N` answers all lecture | Stays `WAITING`, shows counts. No LLM call is ever made |
| Network drops mid-show | Existing behaviour: last known state stays on screen, status line reports it |
| Two app instances | Duplicate classification. Documented in §3.1; not currently possible |

---

## 6. Verification

**`npm run test:smoke:themes`** exercises the AI path end to end without needing real students. It
fabricates 13 answers in three known groups plus two junk ones and checks the clustering is sensible
rather than merely well-formed — each group holding together, junk landing in Forming, counts
deriving correctly, a re-read matching, and a re-run replacing rather than blending.

Phase 2 added a second fixture that submits through the **real student route**, so the hook on
response creation actually fires. It asserts the parts that only exist in motion: nothing happens
below the threshold (no set row, no API call), the 8th answer triggers bootstrap with nothing
clicked, later answers are classified incrementally, the remaining five cost a *single* batched
call, and the category ids do not change mid-run — labels churning on a projector is the failure
this design exists to avoid.

The interleaving matters. `ANSWERS` is grouped, so its first eight would be four entropy and four
heat with no phase answers at all, and bootstrap would derive categories that miss a third of the
class. `LIVE_ORDER` interleaves them so the first eight span all three groups.

36 assertions. Costs about three Opus 5 calls and one Haiku call. Run it after any change to a
prompt, a model, the output schema, or the worker's timing constants.

`npm run test:e2e:qr` is at **50 assertions** and must stay green. Add:

1. `/addin/live` FREE_TEXT payload contains no `responseText` *(tightens the existing invariant)*
2. `themes` object contains no `studentId`
3. `themes` object contains no `responseId`
4. `themes` is `null` when `liveThemes` is off
5. No LLM call fires below `BOOTSTRAP_N` (status stays `WAITING`, `bootstrapN` null)
6. Categories appear once `BOOTSTRAP_N` is crossed
7. Exactly one category has `isOther: true`
8. Category counts sum to `classified`
9. A professor override sets `source: PROFESSOR` and moves the counts
10. A second run of the same session starts with a fresh, empty theme set

Target: **60 assertions**.

End to end, unchanged from the handoff: open a session, project a deck with the results object,
answer from several phones, confirm categories appear and bars grow **without leaving the slide
show**. Then pull the network mid-show and confirm the last known counts survive.

Add one classroom-specific rehearsal the handoff did not have: answer with deliberately junk input
("asdf", "idk", one-word answers) and confirm they land in Forming rather than distorting a real
category.

---

## 7. Build order

Each phase is independently shippable and useful on its own.

| Phase | Contents | Value even if the next phase slips |
|---|---|---|
| **1** | Schema, migration, config columns, bootstrap persisted behind the existing summarize button | Summaries survive a page reload — fixes a real annoyance today. No new AI behaviour |
| **2** | Debounced worker, classify step, auto-bootstrap, `themes_updated` | Live themes visible in the task pane |
| **3** | `/addin/live` changes, `ThemeBars` extraction, `/present` rendering, full-screen ceilings | The projector feature. **This is the talk** |
| **4** | Professor override, manual re-cluster, authoring toggles, the ten e2e assertions | What makes it survive real lectures |

Phase 3 is the demo; phase 4 is what the "real feature, not a prop" decision actually buys. With
three months both fit comfortably — do not let phase 4 be the thing that slips, because it is the
half that keeps a live miscategorisation from being embarrassing.

---

## 8. Deliberately not in scope

- **Assignment (homework) questions.** No runs, no live view. The existing summarize button stays.
- **Prompt caching.** The prefix is too short to reach the minimum. Revisit only if category lists grow.
- **The Batches API.** 50% cheaper but asynchronous — the wrong shape for a live path.
- **Cross-run or cross-year category reuse.** Explicitly rejected in §1.
- **Multi-instance safety.** Documented in §3.1; add the `claimedAt` claim if Railway ever scales out.
