# Assignment Page UX Plan

The homework side of Pulse, and the next thing needing attention. Written 2026-09-12, after
the session-page redesign (`docs/session-page-ux.md`) finished.

**It has not been used in a live setting and has not been touched in months.** That is the
premise: this is a pre-flight audit of a page about to matter, not a cleanup of one already
carrying load.

Files in scope:

```
pages/professor/AssignmentDetailPage.tsx   811 lines
components/assignment/GroupPanel.tsx       388
components/assignment/GradingControls.tsx  204
components/assignment/QuestionPanel.tsx    139
components/assignment/ResponseList.tsx      58
components/assignment/helpers.ts, types.ts
```

Out of scope unless explicitly pulled in: `pages/student/AssignmentPage.tsx` (682 lines) —
see Zone D.

---

## Status Legend
- [ ] Pending
- [~] In progress
- [x] Done
- [-] Rejected or parked — the Decision line says why

---

## The core diagnosis

**This page is the session page before its redesign.** Every class of problem that redesign
found still lives here, because the two pages were built from the same parts and then
diverged. The session page got eight slices of attention; this one got none.

But it is not only a catch-up job, and that is the thing to hold onto. Assignments have
concepts sessions do not — **groups** (multi-part questions), **deadlines**, **per-student
extensions**, **rich-text question bodies**, and a **student-facing submission flow**. Those
are where the page's actual value is, and they have never been designed, only accreted.

So the work splits four ways:

| Zone | What it is | Why it is ordered this way |
|------|-----------|---------------------------|
| **A** | Bugs | Things that are broken now. Cheapest, highest value, no redesign needed |
| **B** | Shared-component debt | The old UX-21. Mechanical once one refactor lands |
| **C** | Assignment-specific UX | The part that is genuinely new design work |
| **D** | The student-facing page | Highest stakes, entirely unaudited, scope to be decided |

Zone A before Zone B before Zone C is deliberate: fixing bugs first means the component
sharing in B lands on working behaviour, and C is design work best done once the mechanics
are honest.

---

## Zone A — Bugs

### AS-1 — The per-question grading stance silently does nothing
- [ ] **Status**

`AssignmentDetailPage:211` sends `PATCH /assignments/:id/questions/:qid` with
`{ effortGrading }`. That route's zod schema
(`backend/src/routes/questions.routes.ts:602`) accepts only `correctAnswer`, `groupId`,
`tolerance`, `unit`, `title`, `text`, `options` — **no `effortGrading`**.

Zod strips unknown keys rather than throwing, so the request returns 200, nothing is
written, and `onSuccess` invalidates the query and snaps the toggle back to its old value.
No error, no indication.

The grader *does* honour effort grading for assignments
(`grading.routes.ts:395` reads `question.effortGrading ?? assignment.class.effortGradingDefault`),
so it always falls through to the class default. The class-level switch works; the
per-question override is theatre.

**Fix:** add `effortGrading` to the route's schema and an `updateData` branch, mirroring the
session route (`questions.routes.ts:385`). One-line schema change plus the branch. Note this
is a **backend** change — the session branch deliberately touched no backend files, so this
arguably belongs on main independently rather than inside a UI branch.

**Decision:** TBD

### AS-2 — Numeric and ordering answer keys are frozen after creation
- [ ] **Status**

`GradingControls` renders both as read-only text:

- `NUMERIC` — `Answer: {q.correctAnswer ?? '—'} ± {tolerance} {unit}`, display only
- `ORDERING` — an `<ol>` of the stored order, display only

**Corrected 2026-09-12.** An earlier version of this item said these keys could not be set
at all. Not quite:

| Type | At creation | After creation |
|------|-------------|----------------|
| `NUMERIC` | **settable** — the add panel has answer / tolerance / unit | **frozen** |
| `ORDERING` | **auto-set** to the order the options are typed in | **frozen** |
| `MULTI_SELECT` | never sent by the UI | settable — the checkboxes work |

So they are not silently ungradeable by default: ordering always gets a key, and numeric
gets one if the fields were filled. The failure is that there is **no way back** — skip the
numeric fields at creation, or discover the sequence was wrong, and nothing in the UI can
change it.

**This is a frontend gap only.** The assignment `PATCH` route (`questions.routes.ts:625`)
validates numeric and ordering keys *identically* to the session route — same
`bypassClosedCheck` list, same per-type validation, and it accepts `tolerance` and `unit`.
It even comments that key edits are deliberately allowed while the assignment is `OPEN`.
Sharing `AnswerKey` (AS-9) closes this with no backend work.

**Decision:** TBD

### AS-3 — Standalone questions cannot be edited
- [ ] **Status**

`QuestionPanel` renders the question body with `RichTextRenderer` — read-only. Its only
mutation converts the question into a multi-part group. `GroupPanel` has the
`RichTextEditor`.

So to change the wording of an ungrouped assignment question you must first convert it into a
group. There is no edit affordance otherwise.

**The route accepts `text`**, so this is a missing UI rather than a missing capability.
Worth confirming what status gating applies to a text edit when implementing — the session
route refuses text changes while a run is open, and the assignment equivalent will have its
own rule.

**Decision:** TBD

### AS-4 — Score labels are exact-matched, so a custom score reads as zero
- [ ] **Status**

`ResponseList:44` matches exact values for both label and colour:

```
score === 1.0 ? 'Full' : score === 0.5 ? 'Partial' : 'None'
```

`aiScore` is a `Float?` and the route accepts any number in `[0, 1]`, so **0.75 renders as
"None" in red**. Identical to the session-side bug fixed in UX-15, and slightly worse: the
session badge showed a wrong number, this shows a wrong *word*.

Also: the vocabulary differs from the session page entirely — `Full / Partial / None` versus
`1.0 pt / 0.5 pt / 0 pt` — for the same underlying value.

Closed by AS-7.

**Decision:** TBD

### AS-5 — One Indigo render request per structure response
- [ ] **Status**

`ResponseList:29` calls `StructureRenderer` for every `STRUCTURE` response unconditionally,
and each instance `fetch`es `/api/indigo/indigo/render`. A structure question with 130
submissions fires 130 render requests on mount.

`ResponseTable` deliberately avoids this by rendering the molecule only when a row is
expanded. Closed by AS-8.

**Decision:** TBD

---

## Zone B — Shared-component debt

This was UX-21 in the session plan, moved here because this is where the work lands.

**Already shared**, both incidental to this zone rather than planned:

- `StructureKeyField` — extracted *from* `GradingControls` during the session work and handed
  back to it. `GradingControls` imports it and lost 60 lines. The pattern is proven.
- `Switch` — extracted from `ClassPage`, shared with `QuestionSettings`.

Everything else the session redesign built is available and unused here.

### AS-6 — Parameterise the endpoint in the shared components
- [ ] **Status**

**The enabling refactor for the rest of this zone.** `AnswerKey` and `QuestionSettings`
hardcode `/sessions/${sessionId}/questions/${id}`. The assignment equivalents are
`/assignments/${id}/...`.

Both need to take the base path — or a mutation — rather than a session id. Note the two
routes do not accept the same fields: the assignment route has no `liveThemes` or
`autoClose` (live concepts that do not apply to homework) and, as of AS-1, no
`effortGrading`. So `QuestionSettings` also needs to know which settings apply to the
context it is in, not merely where to send them.

**Decision:** TBD

### AS-7 — `ScoreBadge` into the response list
- [ ] **Status**

Closest to a drop-in: `ScoreBadge` wants `score`, `reason`, `onChange`, `pending`. Deletes
the cycling, fixes AS-4, and brings the custom-value picker.

One thing to preserve: the assignment list gates scoring on `isGradable`
(`CLOSED` or `ARCHIVED`), which the session page has no equivalent of. `ScoreBadge` already
takes `disabled`.

**Decision:** TBD

### AS-8 — `ResponseTable` into the assignment page
- [ ] **Status**

The biggest win and the most type work. `ResponseTable` takes
`question: QuestionWithResponses`; the assignment side uses `QWithGroup` and casts responses
to `ResponseWithStudent` at the call site, which suggests the student relation is optional in
that type. That needs resolving rather than casting through.

Brings sort, search, the expandable answer column, and closes AS-5. Also brings the filters,
which need `isGradable` gating.

**Decision:** TBD

### AS-9 — `AnswerKey` into `GradingControls`
- [ ] **Status**

Depends on AS-6. Closes AS-2, removes the read-only displays, and replaces the MCQ `<select>`
with the chips the session page uses. `GradingControls` is 204 lines and most of it is
answer-key rendering, so this is where the line count goes.

**Cheaper than first scoped.** The assignment `PATCH` route validates every type the same
way the session route does and accepts `tolerance`, `unit` and `title`. The only field it
lacks is `effortGrading` (AS-1). So this needs no backend work beyond AS-6's URL
parameterisation.

**Decision:** TBD

### AS-10 — `QuestionSettings` replaces the tri-state
- [ ] **Status**

Depends on AS-6 and AS-1. `GradingControls` still has
`Class (effort) / Understanding / Effort` — precisely the control UX-3 replaced. Pointless
until AS-1 makes the setting actually persist.

**Decision:** TBD

### AS-11 — Ten off-token colours
- [ ] **Status**

`bg-white`, `bg-gray-50`, `bg-gray-100`, `border-gray-200`, `border-gray-100`,
`text-gray-400/500/600/800`, `bg-green-50`/`text-green-700`, `bg-yellow-50`, `bg-red-50`,
`bg-amber-50`/`text-amber-600`, plus `rounded-xl` and `rounded-lg` where the house radius is
`rounded-[14px]`.

These are pre-theme-system leftovers. They will be wrong in any dark or alternate theme, and
they are why the assignment page looks subtly unlike the rest of the app. Mostly deleted for
free by AS-7 through AS-10; do the remainder while those files are open.

**Decision:** TBD

### AS-12 — Two helpers doing one job
- [ ] **Status**

`assignment/helpers.ts` has `questionPreview(text)`, which parses rich-text JSON and falls
back to plain text. `QuestionSidebar` exports `questionLabel(q)`, which prefers the
professor-set `title` and falls back to a text snippet.

They want to be one function that handles rich text *and* prefers a title. Blocked on AS-15.

**Decision:** TBD

---

## Zone C — Assignment-specific UX

The part that is new design rather than catch-up.

### AS-13 — Status is a raw four-way select, and Archive has no confirmation
- [ ] **Status**

`AssignmentDetailPage:489` is a `<select>` over `DRAFT / OPEN / CLOSED / ARCHIVED`. Picking
a value fires immediately.

Two problems. The transitions are not equivalent — Draft→Open publishes to students,
Open→Closed stops submissions, →Archived is a filing action — and a dropdown presents them as
four interchangeable values. And Archive from a dropdown is one click with no confirmation,
where the session page's Archive now has one.

Worth borrowing the session page's shape: a primary action for the likely next transition,
the rest behind an overflow, and a confirmation on the one-way step.

**Decision:** TBD

### AS-14 — The sidebar shows no grading progress
- [ ] **Status**

Ungrouped questions show `{n} resp`; groups show `{n} parts`. Neither says whether anything
is graded.

The session sidebar computes and shows `14 ungraded` / `9/14 graded` / `14 graded` (UX-18),
which is the single most useful thing in that list when working through a batch. Homework is
*more* grading-heavy than an opener, so this matters more here, not less.

**Decision:** TBD

### AS-15 — `Question.title` is unused on this page
- [ ] **Status**

The field exists on the model, the session page sets it in `QuestionDialog` and shows it in
the sidebar, and the assignment page neither sets nor reads it. The sidebar shows
`questionPreview(q.text)` — the first text node of the rich-text body.

Consequences: a title set on a question is invisible here, assignment questions cannot be
given one, and long rich-text questions are identified in the sidebar by whatever their first
sentence happens to be.

Note the collision in vocabulary: `QuestionGroup.title` exists and *is* used
(`GroupPanel:272`, labelled "Question title / shared context"). So "title" already means
something on this page — the group's — which is part of why the question's own title got
skipped. Any fix has to name these two things distinguishably.

**The routes are already there.** `POST /assignments/:id/questions` accepts `title` and the
`PATCH` route accepts it too, with a comment that it stays editable regardless of status
because it is professor-facing navigation metadata. The assignment add panel simply never
sends it. Frontend-only.

Confirmed by the author: `Question.title` was designed while looking only at session
questions, so the omission here is an oversight rather than a decision.

**Decision:** TBD

### AS-16 — Add-question is an inline panel, not the shared dialog
- [ ] **Status**

`AssignmentDetailPage:584` has an inline add-question panel with its own state; `GroupPanel`
has a separate add-a-part flow. The session page consolidated add and edit into one
`QuestionDialog` (UX-22), collapsing sixteen state slots into one.

Worth reusing, but it is not a drop-in: the assignment dialog needs rich text rather than a
plain input, a group selector, and the type list minus whatever does not apply to homework.
Depends on AS-3 existing at all, since edit has no home here yet.

**Decision:** TBD

### AS-17 — Groups and questions drag in separate contexts
- [ ] **Status**

There are two `DndContext`s — one over groups, one over ungrouped questions — so a question
can be reordered within its list but cannot be dragged into or out of a group. Regrouping
goes through the "Make multi-part" button, which creates a group and moves one question into
it.

One context with two sortable zones would make grouping a drag. This is the largest piece of
interaction work in this plan and should probably wait until the rest has settled.

**Decision:** TBD

### AS-18 — Deadlines and extensions are the page's real value, and they are buried
- [ ] **Status**

Two things exist here that sessions have no concept of: a `deadline`, editable inline in the
header, and **per-student `DeadlineExtension` records** with their own table, routes and
roster picker — collapsed behind a disclosure that reads `Extensions (2)`.

Per-student extensions are a genuinely useful feature and almost certainly the thing that
will matter most the first time this is used in anger — accommodations, illness, an
add/drop. Right now granting one means expanding a disclosure, picking from an unfiltered
roster dropdown, and choosing a datetime.

**The feature itself is sound — this item is purely about presentation.** Extensions are
enforced on submission in four places in `responses.routes.ts`, each computing
`effectiveDeadline = extension ? extension.deadline : asgn.deadline`, and the model carries
`@@unique([assignmentId, studentId])`. There is nothing here like AS-1. Do not re-audit the
enforcement; audit the interface.

**And extensions are assignment-only by design, which is correct.** `DeadlineExtension` has
`assignmentId` and `studentId` and no session relation. A session is a room in a moment;
there is nothing to extend. Nothing in this plan proposes otherwise.

What the page should answer, which it currently cannot: who has an extension and until when,
whose is about to lapse, and how many submissions are outstanding against *which* deadline.
That is a small dashboard, not a form.

**Decision:** TBD

### AS-19 — The Preview modal is the only answer to "what will students see"
- [ ] **Status**

There is a Preview button and modal (`AssignmentDetailPage:485`, and a rendered preview
around `:761`). It has not been audited as part of this plan, and it is the professor's only
proxy for the student experience before publishing.

If it is faithful it is the most important control on the page before a first real
assignment. If it has drifted from the student page, it is actively misleading. Worth
checking against `pages/student/AssignmentPage.tsx` before trusting it.

**Decision:** TBD

---

## Zone D — The student-facing page

### AS-20 — `pages/student/AssignmentPage.tsx` is unaudited
- [ ] **Status**

682 lines, entirely outside the session redesign, and **the highest-stakes surface in this
plan** — after the projector, it is the only thing students themselves use for homework.

One concrete thing already noticed: it defines its own local `ScoreBadge` function
(`:102`) with different props and read-only rendering, unrelated to the shared component of
the same name. Two components with one name in a codebase is a trap for whoever greps next.

Scope call needed: is student-side work part of this plan, or its own? It is a different
audience with different constraints (mobile, submission under deadline pressure, no
professor to explain a confusing control), and mixing it into a professor-page redesign is
how plans lose focus.

**Decision (2026-09-12):** Its own redesign, not part of this plan. The author's call, and
the right one — a different audience, different constraints, and 682 unaudited lines is not
a footnote to a professor-page plan. A separate plan doc when it comes up.

---

## Order of work

1. **Zone A bugs.** AS-1 first and on its own — it is a backend fix and belongs on main
   independently. Then AS-2 through AS-5, several of which close as side effects of Zone B.
2. **AS-6**, the endpoint parameterisation, alone. Nothing else in Zone B moves until it does.
3. **AS-7, AS-8**, the response list. Biggest visible improvement, and closes AS-4 and AS-5.
4. **AS-9, AS-10, AS-11**, the answer key and settings. Closes AS-2 and needs AS-1.
5. **Zone C**, in the order AS-14, AS-13, AS-15, AS-12, AS-16 — cheapest and most useful
   first, AS-17 last or never.
6. **AS-18** deserves its own slice and a conversation, not a position in a queue.
7. **Zone D** — decide scope before starting.

---

## What not to disturb

`lib/scoring` and `backend/src/utils/scoring.ts` are shared with the session page, the
gradebook, the projector and the CSV export. `gradeSession` is the single source of truth for
grades. Nothing in this plan should change scoring *semantics* — AS-4 is about how a score is
displayed, not how it is computed.

`docs/question-types.md` is the reference for per-type behaviour, and it was wrong twice
during the session work. Verify against the routes before trusting it.

---

## Notes

*Space for changes and corrections to the findings above.*
