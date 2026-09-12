# SessionPage UX Redesign Plan

The professor's session page grew a feature at a time and the layout never caught up.
Everything on it works; the problem is that it all shows at once. Written 2026-09-11
against `11883bb`, where `frontend/src/pages/professor/SessionPage.tsx` is 1535 lines.

**Updated 2026-09-12** — slice 1 is done and `SessionPage.tsx` is 1419 lines. The work
happens on the `session-redesign` branch, not on main.

This is a reference to argue with, not a schedule. Every item carries a **Decision:**
line that is `TBD` until we agree on it — edit those in place rather than rewriting the
findings, so we keep the reasoning that led to each call.

Line references are as of `11883bb`. Slice 1 has already moved them — treat every line
number below as approximate and grep for the surrounding comment instead.

---

## Status Legend
- [ ] Pending
- [~] In progress
- [x] Done
- [-] Rejected — see the Decision line for why

---

## The core diagnosis

One layout serves three unrelated jobs, and shows all three at once.

| Mode | Condition in code | What the professor wants |
|------|-------------------|--------------------------|
| **Authoring** | `!hasBeenRun` | Write questions, set answer keys, set behaviour. Nobody is answering. |
| **Live** | `openRun !== null` | Project the code and QR, watch the counter climb, give them more time, close. |
| **Review** | `CLOSED` / `ARCHIVED` | Grade, spot-check low scores, read themes, export. |

The page already half-knows this — `hasBeenRun` gates the grading stance and the
correct-answer chips — but the gating is **per widget rather than per mode**, so each
control decides for itself and nothing ever fully leaves the screen. That is the root
cause. Most of the individual complaints below read differently once the page knows which
mode it is in.

**Correction, 2026-09-12.** The first draft of this plan said UX-1 came first and
everything else assumed it. That was wrong, and it is recorded rather than quietly edited
because it changed the order of the work. Auditing the dependencies properly: only UX-4,
UX-6 and UX-8 need mode-awareness, and UX-6 is not downstream of UX-1 at all — it *is* the
live half of implementing it. Everything else is independent. The real hinge is UX-21, the
component extraction, because UX-1 is far cheaper against extracted components than
against one 1400-line file.

The obvious correction — extract everything, then redesign — is also wrong: it extracts
components in their current shape and reshapes them immediately afterwards. So the work is
sliced by zone instead, each slice extracting *and* redesigning one zone in a commit that
leaves the page working. See **Order of work** at the end.

---

## Out of scope: the `Redesign/` folder

**Decided 2026-09-12: disregard it.** `Redesign/` holds the early pass that established
the app design language, and it is outdated enough now that referring back to the
prototypes means chasing a shape the app has already moved past. It is not evidence about
what the page should be.

What it contributed is already absorbed: the design tokens are in the app, and
`LiveMonitorPanel` and `enrolledCount` are real code regardless of which pass produced
them. Nothing below cites the prototypes.

---

## Zone 1 — The question header card

`SessionPage.tsx:683-987`. One card doing five jobs: question identity, projection assets
(code / QR / copy card), the edit affordance, and two to four stacked config rows. For a
`FREE_TEXT` question after a run it stands about 500px tall, which pushes the response
list — the thing actually being watched — below the fold.

### UX-1 — Make the page mode-aware
- [ ] **Status**

Branch the layout on authoring / live / review instead of gating each widget on
`hasBeenRun` and `isLive` separately. This is the structural decision the rest hangs off.

**Decision (redefined 2026-09-12):** Still wanted, but it is no longer three modes. With
Zone 2 parked, live is left exactly as it is, so this becomes **authoring versus review**
with the live path untouched. It was already last in the order, so nothing changes in
sequence — but the item as originally written no longer describes the work.

### UX-2 — Collapse the three settings rows into a popover
- [x] **Status** — done 2026-09-12

Live AI themes (`:764`), Close automatically (`:806`) and What the AI grades on (`:851`)
each cost roughly 70px — three buttons plus a two-line explainer — for a setting touched
once and then never again. Three of them is 210px of chrome.

Proposal: a `Settings` popover or disclosure on the header card, collapsed to a one-line
summary of the effective state — *"Live themes on · closes automatically · graded on
effort."* That line scans better than three segmented controls and costs about 20px.

**Decision:** Done. The settings became `components/session/QuestionSettings.tsx`: a `sm` ghost
`Button` trigger stating the stance in force — *Live themes on · closes automatically ·
graded on effort* — over a `Popover` panel. The trigger sits on one controls row with
`Edit` under the question text, and the bordered row the settings used to occupy is gone
entirely. Header card roughly 500px → 150px.

### UX-3 — Replace tri-state segmented controls with a toggle plus an inherited marker
- [x] **Status** — done 2026-09-12

`Class default (on)` and `On` are two buttons that both mean on; the selected state is
the only thing separating "I chose this" from "I inherited this". A single switch showing
the effective value, a small `Class default` chip when the override is `null`, and
*Reset to class default* in the overflow covers the same three states with one control.

**Decision:** Done. One `Switch` showing the effective value, a `Class default` pill when the question
has not overridden it, and a *Reset to class default* link when it has.

Known loss, accepted: the tri-state could pin a question explicitly to the value the class
default already held. With one switch, clicking an inherited-on setting sets explicit
*off*, so the only route to explicit *true* is off-then-on. This matters only if the class
default is later flipped and this question should hold its value. Judged not worth a
control; easy to add back.

### UX-4 — Move the projection block out of the header
- [-] **Status** — parked with Zone 2

Access code, QR toggle and copy-card (`:706-760`) are noise while authoring and far too
small during a run at 32px. They belong to live mode — see UX-6.

**Decision:** Parked. Reframed once already — with results appearing in PowerPoint, the code and QR are
used while building slides, which is authoring rather than monitoring. But moving them out
of the header still changes what is visible during a run, so this is not the
authoring-only change that reframing implied. It waits for UX-6.

### UX-5 — "Give them more time" is a live action inside a config block
- [~] **Status** — partly done 2026-09-12

`:839`. It only renders when live, and it acts on the run, not on the configuration it
sits inside. It belongs next to Close.

**Decision:** Partly done. *Give them more time* moved out of the auto-close config block onto the new
controls row beside `Edit` and the settings trigger, so it is no longer nested inside
configuration. Whether it belongs next to *Close session* in the header instead is a
live-mode question, so it stays here until UX-6.

---

## Zone 2 — Live mode, and why it is parked

**Parked 2026-09-12, not decided.** Left exactly as it is, to revisit deliberately later.

The history matters. This page was once *the* place results came in — professors were meant
to keep it open and watch. Then Document PiP took that job, because it floats over
PowerPoint on the same screen. Then the PowerPoint add-in took it again, showing results in
situ on the slide. The author does not look at this page during a run at all any more.

Two facts constrain what can be done about that:

- **This page is the only run controller in the app.** The add-in is read-only on runs —
  `GET /addin/live` finds an already-open run and there is no endpoint to open or close one.
  Dashboard's "End" and "Open monitor", and ClassPage's "Open monitor" and "Resume", are all
  `<Link>`s here. So the live *controls* are load-bearing however little the live *monitor*
  is used.
- **PiP is the cross-platform live view and is not going anywhere.** It is the only live
  path that does not require PowerPoint — Chromium and, per the author, now Firefox, leaving
  Safari as the holdout. Any plan that demotes or deletes it is wrong.

So the split is between run *control* (load-bearing) and run *monitoring* (superseded
twice). Nothing here is deleted, and nothing is polished either, until there is a second
professor to design against or a demo that needs it. Building a live layout for a
hypothetical user is how this page got its three unused settings rows.

---

## Zone 2 — the live items, parked

With a run open the page looks almost exactly like it does closed.

### UX-6 — Build a real live layout
- [-] **Status** — parked 2026-09-12

When `isLive`: large access code and QR, an `answered / enrolled` counter, theme bars if
live themes are on, and two actions — *Give them more time* and *Close session*. Config
collapses away. `LiveMonitorPanel` is already well factored for exactly this; render it
inline rather than only through PiP.

**Decision:** Parked with the rest of Zone 2, and it is the specific thing not being built. Largest slice
in the plan, aimed at the least-validated need. Revisit when a second professor exists, or
when a demo needs a professor-view moment on screen.

### UX-7 — `enrolledCount` never reaches the main page
- [x] **Status** — done 2026-09-12

It is fetched and passed only to the PiP panel (`:1453`). `17 / 42 answered` is the number
that decides whether to move on, and it is absent from the page itself.

**Decision:** Done — in the page header, beside the response count: "14 responses · 42
enrolled". Session-level rather than per-question, which is what that header is; the richer
"17 of 42 answered" for a single question reads as a live-mode figure, and live is parked.
The sidebar could carry it per question later, which is Zone 6 work.

### UX-8 — PiP is the only good live view, and it is Chrome/Edge only
- [-] **Status** — withdrawn 2026-09-12

It needs a deliberate click and fails through `alert()` (`:709`). Once UX-6 exists, PiP
becomes a bonus rather than the only path to a usable live view.

**Decision:** Withdrawn. It was framed as "PiP is the only good live view", implying PiP was a stopgap to
be replaced by an inline layout. That has it backwards: PiP is the cross-platform live view
and the one to preserve. Nothing to fix here.

### UX-9 — The sidebar never shows which questions are closed
- [-] **Status** — parked with Zone 2

`Question.closedAt` exists (`shared/src/index.ts:122`) and auto-close closes questions
individually. During a run that is arguably the most important per-question state, and it
is invisible.

**Decision (2026-09-12): parked with Zone 2, and the finding was wrong.**

This item claimed `Question.closedAt` exists. It does not — not in `shared`, not in the
Prisma model. The `closedAt` cited at `shared/src/index.ts:122` belongs to `SessionRun`.

Per-question closure is not stored at all. It lives in `clock.service.ts`, in memory, and
only `/addin/live` computes and ships it as `closesAt` / `closeWindowMs`. So showing it in
the sidebar needs `sessions.routes.ts` to consult the clock service — a backend change this
branch has otherwise not needed — to surface a state that exists only while a run is open.

Which is live mode, and parked. It goes with Zone 2.

---

## Zone 3 — The answer key lives in three places

| Type | Where | When | Control |
|------|-------|------|---------|
| `NUMERIC` | header card `:947` **and** both modals | always | three inline inputs |
| `MULTIPLE_CHOICE` / `YES_NO` | header card `:917` | **only after a run** | chip buttons |
| `FREE_TEXT` rubric | nested inside the grading-stance block `:899` | only after a run | text input |
| `MULTI_SELECT`, `ORDERING` | nowhere | — | — |

### UX-10 — The MCQ key cannot be set before the session runs
- [x] **Status** — done 2026-09-12

Backwards twice over: the answer key is authoring work, and with auto-close on, the
correct answer is *revealed to students* when the question closes, so it has to exist
beforehand. The `FREE_TEXT` rubric hint has the same gate and the AI grader wants it up
front.

**Decision:** Done, and the finding needed correcting first. `docs/question-types.md` claimed the key
"can only be set once the session is CLOSED", which would have put it in genuine conflict
with auto-close revealing that key. The actual backend rule is narrower —
`questions.routes.ts:276` refuses a key change only **while a run is open**, and exempts
NUMERIC, ORDERING and STRUCTURE even then. So authoring-time keying was always permitted
and only the UI forbade it. Removing the UI gate was a pure frontend change; no backend
edit was needed, and there is no conflict with auto-close.

The UI now locks the key only while a run is open, for the types the backend actually
refuses, and says so in place rather than hiding the control.

**A real bug fell out of this.** The free-text rubric hint also writes `correctAnswer`, and
FREE_TEXT is *not* on the exempt list — so the old `hasBeenRun` gate showed the input
during a live run (any run after the first), where saving it returned a silent 400.
`setCorrectAnswerMutation` had no error UI, so the hint simply failed to save with no
indication. Now locked while live, and errors surface.

### UX-11 — `MULTI_SELECT` and `ORDERING` have no answer-key UI at all
- [x] **Status** — done 2026-09-12

`GradingControls` on the assignment side already handles `MULTI_SELECT`. In sessions those
question types are silently ungradable. Closer to a bug than a layout problem.

**Decision:** Done, with one correction to the finding. MULTI_SELECT had no key UI in sessions and now
has checkboxes.

ORDERING was less broken than stated: its key is **auto-set at creation** to the order the
options were written in, so ordering questions were always gradable — what was missing was
any way to *change* that order afterwards. It now has an up/down reorder list. Plain
buttons rather than drag-and-drop: dnd-kit is already a dependency on the student side, but
buttons are keyboard-accessible for free and this list is rarely touched.

### UX-12 — Numeric keys are editable in two places
- [x] **Status** — done 2026-09-12

The header card and the Edit modal write the same fields with no sign they are the same
fields.

**Decision:** Done. The numeric key left the edit dialog, which now points at the answer key on the page
behind it. The `eqCorrectAnswer` / `eqTolerance` / `eqUnit` state and the NUMERIC branch of
the edit mutation went with it.

### UX-13 — One "Answer key" section, per type, in every mode
- [x] **Status** — done 2026-09-12

The fix for UX-10 through UX-12 together: a single section that renders the right control
for the question type and is available regardless of mode. Remove the key fields from the
Add and Edit modals so there is one home.

**Decision:** Done as `components/session/AnswerKey.tsx`: one component rendering the right control per
type — free-text rubric hint, chips for multiple-choice and yes/no, checkboxes for
multi-select, an up/down list for ordering, and value/tolerance/unit for numeric. It owns
its own mutation, so `setCorrectAnswerMutation` and four draft-state maps left
`SessionPage`. Mounted with `key={question.id}`, so drafts are plain state seeded from
props instead of `Record<string, string>` keyed by question.

Two deliberate deviations from this item as written:

- **The add-question dialog keeps its numeric fields.** The plan said to strip the key from
  both dialogs, but at creation time the question does not exist yet, so there is no
  `AnswerKey` to use — stripping it would force create-then-key for every numeric
  question. The edit dialog is the one that had a redundant second home.
- **Only RATING renders nothing**, because it is participation credit by design and the
  backend 400s on a key for it. Structure questions are fully supported — see the
  correction in the notes below; the first pass at this slice wrongly left them out.

---

## Zone 4 — Grading is scattered across four vertical zones

Grading one question currently means moving through: the stance toggle in the header card
(`:851`), *Give all full credit* tucked into the score-summary line (`:1000`), *Grade all
with AI* / *Grade ungraded* in a separate block (`:1044`), the *Needs review* filter below
that (`:1157`), and per-response cycling in the list.

### UX-14 — One sticky grading toolbar above the response list
- [x] **Status** — done 2026-09-12

`avg 0.82 · 12/14 graded` on the left; `Grade with AI` (all / ungraded), `Needs review
(3)`, `All full credit` on the right. One row, reading order, stays visible while
scrolling responses.

**Decision:** Done as `components/session/GradingToolbar.tsx`, **sticky** at the top of the response list
per the author's call. Left side carries the count and average; right side carries Grade with
AI, Ungraded (n), Needs review (n) and All full credit. The AI progress bar takes over the
whole bar while grading, and the outcome message sits underneath it.

Presentational on purpose — it takes values and callbacks rather than mutations. The socket
that drives progress and result belongs to the page, and giving the toolbar its own listener
would have meant two subscriptions to the same events.

Three stretches of page collapse into it: the score summary line, the AI grade block, and
the needs-review filter. The themes panel stayed where it is; that is UX-16.

### UX-15 — Score cycling is undiscoverable and has no undo
- [x] **Status** — done 2026-09-12

`:1229-1240`. A button reading `1.0 pt` silently cycles 1 → 0.5 → 0 on click, with the
AI's reason in a `title` tooltip. For a real grading pass: a visible 0 / 0.5 / 1 segmented
control, and keyboard shortcuts (`j`/`k` to move, `0`/`1`/`2` to score).

**Decision:** Done as `components/session/ScoreBadge.tsx`, and **the badge stays** — the author's call over
the segmented control this item proposed. Hovering it opens a picker with 0, 0.5 and 1.0
presets plus a custom 0–1 field. It also opens on click and focus: hover alone would strand
keyboard and touch users on the one control in the app that assigns marks.

**Custom scores were always supported and always displayed wrong.** `aiScore` is `Float?` and
the route validates `z.number().min(0).max(1)`, so any value in range stores and grades
correctly — `gradeSession` sums the float. But the badge read
`score === 1.0 ? '1.0' : score === 0.5 ? '0.5' : '0'` with a matching exact-match colour, so
a 0.75 rendered as **"0" in red**. Latent for as long as the UI only ever wrote three values;
exposing a custom field would have surfaced it immediately. Label and tone are now
generalised — threshold colours, two decimals — which is what makes the custom field safe
rather than just possible.

**Not done from this item as written:** the `j`/`k` plus `0`/`1`/`2` keyboard shortcuts. The
picker removes the aim-by-cycling problem, which was the real complaint; list navigation is a
separate idea and belongs with UX-19 if it is wanted.

One deliberate duplication: the grader's reason now shows both in the picker and on the line
under the response. They serve different moments — scanning the list, versus deciding a new
score — so both stay.

### UX-16 — The themes panel splits configuration from result
- [x] **Status** — done 2026-09-12

`:1077-1150`. It sits between the score summary and the responses, pushing responses down,
and is configured 400px above where it renders. Better as a collapsible panel next to
`ResultsSummary`, with its on/off control on the panel itself.

**Decision:** Done, and this item was much too small as written. It described a placement problem. The
placement is fixed — `ThemesPanel` now sits between `ResultsSummary` and the grading
toolbar, so the aggregate views group at the top and the sticky bar stays against the list
it acts on — but the controls were the real issue.

**Three controls expressed two actions, and the labels hid which ones destroy.**
`Summarize responses` and `Regenerate` were the *same call*: `POST /summarize`, which
`deleteMany`s the run's theme set and re-derives it from scratch
(`themes.service.ts:271`). `Dismiss` only hid the panel locally.

The trap was the interaction. A dismissed panel made `Summarize responses` reappear, and
clicking it cleared the dismissal *and* destroyed the existing set — unconfirmed — when
clearing the dismissal alone would have shown it again. So the destructive path reachable by
accident was the one with no warning, while `Regenerate`, doing exactly the same thing,
asked first and warned about the projector.

Now: collapsing is a view state that touches nothing, `Summarize responses` appears only
when no set exists for the run (the one case where it creates rather than replaces), and
`Regenerate` is the single path that replaces a set and keeps its confirmation. `Dismiss` is
gone as a name — it never dismissed anything.

Collapse is **ephemeral and open by default**, per the author's call: no persistence, so a
collapsed panel cannot hide incoming live themes past a navigation. `localStorage` keyed by
question id is the whole job if it is ever wanted. The collapsed header shows the theme
count, so a closed panel is not silent about having content.

Two pieces of page state went with it: `dismissedThemesFor` and `shownThemes`.

---

## Zone 5 — Header actions have no hierarchy

### UX-17 — One primary action plus an overflow
- [x] **Status** — done 2026-09-12

`:513-575`. *Pop out*, *Export CSV* and the session-state action all carry equal weight,
and **Archive sits immediately beside Reopen** — a one-way action next to the common one.
Export CSV is also a hand-rolled `<button>` rather than `<Button>`, so it is styled
slightly off from its neighbours.

Proposal: one primary button reflecting session state (Open / Close / Reopen), with
Export CSV, Archive and Pop out behind an overflow menu.

**Decision (amended 2026-09-12):** Do it, but **Pop out stays first-class** — the original
proposal was wrong. It assumed PiP was vestigial; PiP is in fact the only live view that
does not require PowerPoint, and burying the sole cross-platform live path behind `⋯` would
be the opposite of the right call. The overflow holds **Export CSV and Archive only**.

**Built 2026-09-12.** Pop out and the state action are first-class; Export CSV and Archive
sit behind a `⋯` menu. Archive leaving that row is the substantive part — it was a one-way
action beside Reopen, and it had no confirmation at all. It has one now, and Reopen became
the state button on its own, collapsing two branches of the old markup into one.

`Popover` gained an optional chevron and children-as-a-function receiving `close`, since a
click inside the panel is not an outside click and a menu item that acts should also leave.

---

## Zone 6 — The sidebar is the best part of the page and under-used

### UX-18 — Show the grading label it already computes
- [x] **Status** — done 2026-09-12

`:614` builds `"9 / 14 graded"` / `"not graded"` and then buries it in a `title` tooltip,
rendering only `"14 responses"` in a colour that has to be decoded.

**Decision:** Done. The sidebar shows the summary it was already computing, instead of burying it in a
`title` and rendering a bare response count in a colour you had to decode.

Shortened to fit 256px: `14 ungraded`, `9/14 graded`, `14 graded`, or plain
`14 responses` for a type that carries no score. The colour stays as the glance; the words
are what it meant.

*(This item briefly held UX-17's decision text, written here by a doc helper that searched
past the end of UX-17's section. Corrected, and the helper now bounds itself.)*

### UX-19 — Keyboard navigation between questions
- [-] **Status** — declined 2026-09-12

Up/down arrows or `1`-`9`. Helps both grading and live teaching.

**Decision:** Declined by the author: not necessary. Recorded rather than deleted, because the keyboard
idea also surfaced in UX-15 as `j`/`k` navigation and was dropped there too. Twice
considered and passed over is worth knowing before it is proposed a third time.

### UX-20 — Question reordering
- [x] **Status** — done 2026-09-12

No way to reorder from the sidebar.

**Decision:** Done, by dragging, and **it needed no backend work at all** — worth recording, because the
author reasonably doubted both halves of it.

Three things were already true:

- **Session and assignment questions are one table.** `Question` has nullable `sessionId`
  and `assignmentId`, so both live in the same model with the same required `order Int`.
- **A reorder route already existed**: `PUT /sessions/:id/questions/reorder`, taking
  `[{ id, order }]` in a transaction, ownership-checked. Written for the assignment side and
  never called from the session page.
- **dnd-kit is already a dependency**, used in five places including the student ordering
  question. So this uses the same `DndContext` / `SortableContext` / `PointerSensor` setup as
  `AssignmentDetailPage` rather than a new approach.

**Reordering is closed off while a run is open**, alongside adding and deleting. The route
does not enforce that — it checks only ownership — but the numbering is what a professor
says out loud, and renumbering mid-lecture makes a liar of them.

**One thing the obvious implementation gets wrong:** `activeTab` is an index, so moving a
question would leave the professor looking at a different one. The drag handler resolves the
open question by id before the move and re-selects it afterwards.

## Zone 7 — Per-type distributions

### UX-26 — Free text carried a distribution block that earned nothing
- [x] **Status** — done 2026-09-12

Raised by the author while reviewing the types: most of them have a visualization between
the question and the responses, and they get in the way.

**The extraction this started as was already done.** `ResultsSummary` (378 lines) has handled
all eight types in one component for a long time — multiple-choice bars, rating histogram,
yes/no split, multi-select bars, ordering sequence, numeric dot plot, free-text stat tiles.
Nothing per-type was inline in `SessionPage`. So the question was only ever about when to
show it.

**A blanket collapse would have been wrong, because the value inverts by type.** For
multiple-choice, rating, yes/no, multi-select and numeric, the distribution *is* the result —
forty individual "4"s tell you nothing a histogram does not tell you instantly, so
defaulting those closed hides the reason you opened the page. Free text is the reverse: the
responses are the substance and the summary was three stat tiles.

Taking those three apart is what settled it:

- **Response count** — already in the grading toolbar, the sidebar, and the page header. A
  fourth copy earns nothing.
- **Average word count** — no decision changes on 18 versus 22, and every card shows its own
  count.
- **Short (<10 words) count** — the only aggregate of `isFlagged` anywhere, and under effort
  grading short answers are exactly what loses credit. Worth keeping.

So free text now renders no distribution on this page, and the short count became a **filter**
rather than a stat — `Short (n)` beside `Needs review (n)` in the toolbar, where it is one
click to see just those instead of a number to look at. The two filters are mutually
exclusive: independent toggles can combine into an empty list, which reads as a bug.
`reviewOnly` became a `{ questionId, mode }` pair.

**And with that, the collapsible wrapper was not built.** Every remaining instance would have
defaulted to open, so a disclosure triangle on each one is ceremony. `ThemesPanel` keeps the
collapse it already has; a shared `CollapsibleSection` waits until something needs a second.

**Decision:** Done — and deliberately *not* by deleting `ResultsSummary`'s `FREE_TEXT`
branch, which was the first plan. That branch is load-bearing for the projector:
`PresentResultsPage` falls back to it when themes fail, with a comment about not "leaving a
gap nobody can interpret" on the big screen. `LiveMonitorPanel` and `PipDisplay` call the same
component. So the change is scoped to the page that had the problem — `SessionPage` skips it
for free text — and the component still serves its other three surfaces.

---

## Zone 8 — The response list

### UX-27 — Hundreds of cards, unsortable and unsearchable
- [x] **Status** — done 2026-09-12

Raised by the author: the list is a straight stack of cards, potentially hundreds of them,
so much data it may as well not be there, and mostly wasted space.

Each card spent roughly 90px carrying an eighteen-word answer plus four pieces of metadata
at competing sizes — netId, a short-answer flag, a word count, a timestamp and a score —
with the answer, the only part that matters, styled no differently from the chrome around
it. Fixed at newest-first, with no sort, no search, and 200 borders of visual noise.

**A table, with one qualification: answer length varies by type**, which is the third time
that has decided a design here. Multiple choice, yes/no, rating and numeric answers are a
single token and tabulate perfectly. Free text averages eighteen words and *is* the thing
being read, so a truncated column would hide the content on the one type where the list is
the point. Structures are a rendered molecule.

So: one table, with the answer column clamped to two lines and expandable in place for the
long types. Structured types get one row each and become scannable; free text drops from
~90px to two lines and opens on click.

**What the table bought that density did not:**

- **Sortable columns**, defaulting to **score ascending** on the author's call. The old fixed
  newest-first was never the order anyone graded in. Unscored rows sort with the zeros —
  ascending means "what still needs me", and nothing-yet belongs with the worst.
- **A search box** over netId and answer text. Finding one student among 200 was a Ctrl+F job.
- **Sortable time**, de-emphasised rather than given equal billing.

**Two fields were dropped rather than given columns.** The per-row word count is a proxy for
effort that the `Short` flag already marks at the extreme, and it earned no column. The AI
reason line cost ~30px on every partially-scored row and now appears in the expanded row
only — `ScoreBadge` already shows it in its picker.

**Three latent display bugs surfaced once answers shared a column**, all of them showing the
stored value rather than the answer:

- `MULTI_SELECT` rendered its raw JSON array — `["Option A","Option C"]`.
- `ORDERING` likewise, where the order is the answer — now joined with arrows.
- `STRUCTURE` rendered the InChI string it is compared by. The assignment side has always
  rendered structures properly; this page never did. Now rendered with
  `StructureRenderer` when a row is expanded — not per row, since that would be one Indigo
  request per response.

**Decision:** Done as `components/session/ResponseTable.tsx`.

**No virtualisation**, deliberately. Eight hundred rows is roughly four thousand DOM nodes:
noticeable, not broken. Sorting and search address the actual complaint more cheaply, and
adding a windowing dependency to a page this redesign has just finished simplifying is the
kind of speculative complexity that created the mess. Measure first.

**Two bugs of my own, caught before committing.** `SortHeader` was defined inside the render
body, so it took a new identity every render and React remounted the header cells on each
sort — dropping focus from the button just used. And the table was wrapped in
`overflow-x-auto` inside a card with `overflow-hidden`, either of which clips an absolutely
positioned descendant: the score picker would have been cut off on the lower rows, making
exactly those rows ungradeable. Both containers are gone — the answer column wraps, so
nothing needed to scroll — and the zebra striping went with them, since row borders already
separate the rows and its square corners would have shown past the card's radius.

Portalling the picker is the durable answer if `ScoreBadge` ever lands somewhere that must
clip. It needs anchored positioning that survives scrolling, so it is not worth buying until
something needs it.

---

## Cross-cutting debt this redesign should sweep up

### UX-21 — Two parallel implementations have drifted
- [~] **Status** — started 2026-09-12

`AssignmentDetailPage` extracted `QuestionPanel` / `GradingControls` / `ResponseList` into
`frontend/src/components/assignment/`; `SessionPage` inlines all of it. The same concepts
now differ: MCQ correct answer is a `<select>` there and chips here, `MULTI_SELECT` keys
work there and not here, and `GradingControls` still uses raw `bg-white` /
`border-gray-200` instead of the theme tokens.

Extracting shared `QuestionSettings` / `AnswerKey` / `GradingToolbar` / `ResponseList`
components would roughly halve `SessionPage` and stop the drift. This is the natural
vehicle for the whole redesign rather than a separate cleanup.

**Decision:** In progress, and the extraction is now most of the page. What exists after
seven slices:

```
components/session/   QuestionSettings  AnswerKey  GradingToolbar  ScoreBadge
                      ThemesPanel  QuestionDialog  QuestionSidebar
components/           StructureKeyField
components/ui/        Switch  Popover  ConfirmDialog  (Button gained a size)
lib/                  questionTypes
```

`SessionPage` is 1535 → 843 lines and holds the socket, the queries, the run controls and
the response list; every zone around them is a component.

**The assignment side is still the drift risk.** `StructureKeyField` was extracted *from*
`GradingControls` and is shared, which proved the pattern. But `GradingControls` still has
its own grading-stance tri-state — the exact control UX-3 replaced on the session side — and
`assignment/ResponseList` still cycles scores on click with the same exact-match label bug
`ScoreBadge` fixed. Those two are the obvious next call sites, and closing them would make
the redesign a shared-component change rather than a session-page one.

`GradingControls` also still uses raw `bg-white` / `border-gray-200` instead of theme
tokens, which is a separate and smaller job.


### UX-22 — Add and Edit question modals are near-duplicates that diverged
- [x] **Status** — done 2026-09-12

`:1264` and `:1348`. Add uses a newline textarea for options, Edit uses per-option inputs
with add and remove; Add lets you pick a type, Edit does not. One component with a `mode`
prop.

**Decision:** Done as `components/session/QuestionDialog.tsx`, one component for both modes. The
divergences that were accidental are gone: options are per-option rows in both (a new
question starts with two empty ones, so the first is typed rather than clicked for), and the
add dialog no longer parses newline-separated text.

The two differences that remain are deliberate and now stated in the UI. **Type is fixed
after creation** — changing it would orphan the options and re-interpret every answer
already given — so edit shows a chip and says why. **A numeric key is offered at creation
only**, because until the question exists there is no `AnswerKey` on the page to set it
from; the edit dialog points at it instead.

**A leak closed on the way past.** The upload happens when a file is picked, so abandoning
the dialog could strand it. Add handled that; edit did not, so replacing an image and
cancelling orphaned the new upload. One rule now covers both: on cancel, delete the draft
image unless it is the one already saved on the question.

### UX-23 — Native `alert()` / `confirm()` in six places
- [x] **Status** — done 2026-09-12

Delete question, re-grade, full credit, PiP unsupported, delete failure — alongside
`Card`-based modals everywhere else.

**Decision:** Done as `components/ui/ConfirmDialog.tsx`, covering both shapes: a confirm, or a notice with
one dismiss button where an `alert` used to be. Destructive actions get a red confirm button,
which `window.confirm` could never express.

**The count in this finding was wrong, in both directions.** It said six; the session page
had five. But grepping only that file missed a sixth in `ThemesPanel` — a component this
redesign created two slices earlier — so the Regenerate confirmation was still native. Fixed.

Six remain elsewhere in the frontend, untouched because they are outside this redesign:
`assignment/GroupPanel`, `assignment/QuestionPanel`, `RichTextEditor`, `AdminPage`, and two
in `ClassPage`. `ConfirmDialog` makes each a small change now that it exists.

**The Picture-in-Picture notice also stopped lying.** It read "requires Chrome or Edge.
Firefox is not supported yet", which is no longer true. The check is a feature test, so
support arriving anywhere already works — only the message went stale. It now names the
capability and no browsers, so it cannot go stale again.

### UX-24 — Duplicated feedback
- [x] **Status** — done 2026-09-12

`summarizeMutation.isError` renders twice (`:1143` and `:1148`), and *"Could not change
that — try again."* appears three times verbatim.

**Decision:** Mostly resolved by slices 3 and 4 before it was reached. Of the original two complaints:

- The duplicated `summarizeMutation.isError` block is now one `errorLine` in `ThemesPanel`,
  rendered from two mutually exclusive branches. It never rendered twice even before — but
  the literal existed twice, which is what drifts.
- "Could not change that — try again." is down from three to two, in `QuestionSettings` and
  `SessionPage`. Left alone deliberately: they are different mutations in different
  components reporting in different places on screen. A shared constant would couple two
  unrelated components for the sake of one string.

### UX-25 — About 25 `useState` calls in one component
- [x] **Status** — done 2026-09-12

Eight for Add-question and eight for Edit-question. UX-22 collapses most of it.

**Decision:** Done, mostly as a consequence of UX-22 rather than as its own work. `SessionPage` went from
29 `useState` mentions to 13, and from 1535 lines to about 870.

The sixteen add/edit slots — `aqTitle`, `aqText`, `aqType`, `aqOptions`, `aqImageUrl`,
`aqNumericAnswer`, `aqTolerance`, `aqUnit`, `aqError`, `eqId`, `eqTitle`, `eqText`,
`eqOptions`, `eqImageUrl`, `eqError`, plus the two `show*` booleans — became one
`dialog` slot. Earlier slices had already taken `rubricDraft`, three numeric drafts,
`dismissedThemesFor` and `shownThemes`.

---

## Do not disturb the projector

`pages/present/PresentResultsPage.tsx` is the PowerPoint content add-in that renders live
results on a slide, and as of 2026-09-12 it is the surface that works best in real lectures.
Nothing in this redesign should reach it unless that is the intention.

It shares these with `SessionPage`, and they are effectively frozen unless the projector is
deliberately in scope:

- `ResultsSummary` — including its `FREE_TEXT` branch, which is the fallback when theme
  derivation fails. Slice 5 nearly deleted that branch; see the note in that slice's log.
- `ThemeBars` — the `stage` variant is the projector's theme display.
- `NumericDots`, and `lib/scoring` (`normalizeNumeric`, `parseValueUnit`) through it.
- `ui/PulseMark`, `ui/LiveDot`, `PresenceGrid`, `AnswersArriving`, `CloseCountdown`.

The remaining sweep items are all `SessionPage`-local and come nowhere near these. The one
foreseeable collision is migrating `ThemesPanel`'s collapse into a shared
`CollapsibleSection`, which would touch `ThemeBars` territory — that needs the projector
checked alongside it.

Verified for slices 1 to 5: none of the 14 files changed on `session-redesign` appears in
that page's dependency closure, and no backend file was touched at all.

---

## Order of work

Sliced by zone rather than by phase. Each slice extracts one zone into a component *and*
redesigns it, in a commit that leaves the page working — instead of one wholesale
extraction followed by one wholesale redesign.

1. **Settings** — UX-2, UX-3, part of UX-5 and UX-21. ✓ done 2026-09-12
2. **Answer key** — UX-13, carrying UX-10, UX-11 and UX-12. ✓ done 2026-09-12
3. **Grading** — UX-14 and UX-15. ✓ done 2026-09-12
4. **Sweep** — UX-17 (amended), UX-22 through UX-25, UX-7. ✓ done 2026-09-12.
   UX-16 was pulled forward ahead of it. UX-9 turned out to belong to Zone 2. UX-18 moved
   into Zone 6 below.
   UX-7 and UX-9 ride along here; neither is a live feature.
5. **Zone 6 as one unit** — UX-18 and UX-20. ✓ done 2026-09-12. UX-19 declined.
6. **Authoring versus review** — UX-1, redefined. By then each zone is a component, so it
   reduces to choosing which ones render when.
7. ~~**Live layout**~~ — UX-4, UX-6, UX-8, UX-9. Parked; see Zone 2. Not a step in this plan
   until there is a reason to un-park it.

Nothing in steps 3 to 5 depends on the parked live work, which is why parking it does not
stall the redesign.

---

## Notes

### Slice 1 — settings, 2026-09-12

New: `ui/Switch`, `ui/Popover`, `session/QuestionSettings`; `ui/Button` gained `size`.
`SessionPage.tsx` 1535 → 1419 lines, `ClassPage.tsx` −91/+65.

**Carried along, not a plan item.** `ClassPage`'s three class-default cards each had their
own mostly-empty row, and are now one `md:grid-cols-3` row (stacking again below `md`),
with the "any question can override it" that all three repeated pulled out into a single
caption above them.

**Copy this trim dropped**, recorded in case it should come back: the class-level effort
card used to spell out the gradations — half credit for "idk" and one-word answers, none
for keysmash or an answer to a different question. That detail is now nowhere in the UI.
Grid items equalise height, so keeping it would have made all three cards as tall as the
longest. If it is wanted: a tooltip, or a line in the question-level popover, where
someone is actually deciding how one question gets graded.

Two labels were also shortened to fit the narrower cards — "Close questions automatically"
→ "Close automatically", "Grade free text on effort" → "Grade on effort". They now match
the question-level popover, at the cost of the class card no longer saying "free text".

### Slice 2 — answer key, 2026-09-12

New: `session/AnswerKey.tsx`. `SessionPage.tsx` 1419 → 1283 lines; `setCorrectAnswerMutation`,
`rubricDraft`, `numericDraftAnswer`, `numericDraftTolerance`, `numericDraftUnit`,
`eqCorrectAnswer`, `eqTolerance` and `eqUnit` are all gone, which is real progress on UX-25.

**`docs/question-types.md` was stale and actively misleading**, and has been corrected in
the same commit. It described the key gate as "can only be set once the session is CLOSED"
for multiple-choice, yes/no and multi-select; the rule is "not while a run is open", with
NUMERIC, ORDERING and STRUCTURE exempt. It also called the structure key unused, when both
sides of that comparison are converted to InChI and scored.

**Correction, same day: structure answer keys were already solved, and I claimed otherwise.**
The first pass at this slice left STRUCTURE out of `AnswerKey` on the grounds that setting a
key needs a molecule editor the app lacks. It does not lack one. `GradingControls` on the
assignment side has had a complete implementation for some time — a Ketcher editor against
`RemoteStructServiceProvider('/api/indigo')`, saving a molfile the backend converts to InChI,
with `StructureRenderer` showing the current key and Change / Clear beside it. Indigo runs as
its own container. So structure questions were never manual-grade-only; the session page just
never got the control.

That makes it a UX-21 drift case, not a missing feature, and it was fixed as one: the editor
is now `components/StructureKeyField.tsx`, used by both `AnswerKey` and `GradingControls`
rather than copied into a second place. `GradingControls` drops 60 lines and its own Ketcher
wiring.

The editor opens in a modal rather than inline. Inline it was a 500px canvas wedged into
whichever card contained it — tolerable in the assignment list, absurd in the question header.
The overlay is portalled to `document.body`, since this field sits several cards deep where a
`fixed` position cannot be trusted.

The lesson worth keeping: `docs/question-types.md` said structure equivalence checking "is
not implemented — out of scope", and I believed the document over the code twice in one
slice. Both claims are corrected there now.

### The live question, 2026-09-12

Parked rather than answered — see Zone 2 for the reasoning and the two facts that constrain
it. The three forks considered were: rip live out entirely, build UX-4/6/7/8, or accept the
mess. The first turned out not to be available (this page is the only run controller), the
second is speculative work for a user base of one who does not use it, and the third
conflates the live ambiguity with the grading-zone mess, which is separable and fork-independent.

**Small thing worth fixing whenever Zone 2 thaws:** `openPip` hardcodes "Picture-in-Picture
requires Chrome or Edge. Firefox is not supported yet." The code feature-detects
`window.documentPictureInPicture`, so support arriving anywhere works on its own and only the
message goes stale. It should name the capability, not a browser list.

**Dead code confirmed:** `components/PipDisplay.tsx` has zero references — superseded by
`LiveMonitorPanel`. Already on the project backlog; safe to delete independently of any of
this. `LiveMonitorPanel` itself is live and must stay.

### Slice 3 — grading, 2026-09-12

New: `session/GradingToolbar.tsx`, `session/ScoreBadge.tsx`. `SessionPage.tsx` 1283 → 1186
lines, and `cycleScore` is no longer imported there (the assignment page still uses it, so it
stays in `lib/scoring`).

**The find worth remembering:** custom scores have always been storable and gradable, and
would have rendered as "0" in red. The three-value UI was hiding a display bug rather than
enforcing a three-value model. Anyone adding a score control elsewhere should use
`formatScore` and the threshold tone from `ScoreBadge` rather than matching on exact values.

`assignment/ResponseList.tsx` still cycles scores on click, with the same exact-match label
and colour. It has the identical bug and the identical discoverability problem. Not touched
here — it is the assignment side — but it is the obvious next `ScoreBadge` call site and
would close UX-21 a little further.

### Slice 4 — themes, 2026-09-12

New: `session/ThemesPanel.tsx`. `SessionPage.tsx` 1186 → 1123 lines, and `ThemeBars`,
`RefreshCw` and `Sparkles` are no longer imported there.

**The find:** two buttons with different names, different placement and different
confirmation behaviour were the identical destructive call. Worth a general suspicion — where
the same mutation is reachable from two controls, check that both agree about whether it is
dangerous.

The panel order on the page is now `ResultsSummary` → `ThemesPanel` → `GradingToolbar` →
responses. Aggregates group together, and the sticky bar is adjacent to what it acts on
rather than separated from it by a theme card.

### Slice 5 — free-text distribution, 2026-09-12

No new component. `SessionPage.tsx` 1123 → 1138 lines (the filter logic costs more than the
block removed, which is fine — the page got shorter on screen, not in source).

**The near-miss worth recording:** the plan was to delete `ResultsSummary`'s `FREE_TEXT`
branch outright. That component has four consumers — `SessionPage`, `LiveMonitorPanel`,
`PipDisplay` and `PresentResultsPage` — and the projector uses exactly that branch as its
fallback when theme derivation fails. Deleting it would have put a hole on a lecture-hall
screen in the one case someone had already written a comment to prevent. Check the consumer
list before removing a branch from a component that serves more than one surface.

Both filter chips initially used the same `Flag` icon and colour, which made two different
filters look like one control. `Flag` now stays with Short, matching the per-card "Short"
pill, and Needs review took `AlertCircle`.

### Slice 6 — the sweep, 2026-09-12

New: `session/QuestionDialog.tsx`, `ui/ConfirmDialog.tsx`, `lib/questionTypes.ts`.
`SessionPage.tsx` 1138 → about 870 lines, `useState` 29 → 13. Across all six slices the page
has gone 1535 → ~870.

`lib/questionTypes.ts` exists because the type list was encoded twice and the two had
drifted: the add dialog's picker said "Structure drawing" and "Rating (1–5)" where the
header chip said "Structure" and "Rating". One list now, with a terse label for chips and a
fuller one for the picker.

**Two findings in this pass were wrong when checked**, which is the argument for checking
before implementing: UX-9 cited a field that does not exist, and UX-23 undercounted its own
subject while missing an instance in a component this redesign had just written.

### Slice 7 — the sidebar, 2026-09-12

New: `session/QuestionSidebar.tsx`, which also takes `questionLabel` off the page.
`SessionPage.tsx` 870 → 843 lines. Across seven slices: 1535 → 843, and `useState` 29 → 14.

**The check that cost nothing and would have cost a day to skip:** the author doubted session
questions even stored an order, and doubted drag was feasible. Both were already solved — one
table with a required `order`, a reorder route written for the assignment side, and dnd-kit
installed and used five times over. The whole item was one frontend call.

**A correction to this document itself.** UX-18's Decision was holding UX-17's text. The
helper used to write these entries searched for the next unanswered Decision line *after* a
heading, with no upper bound, so an item whose Decision had already been hand-edited — UX-17,
amended when the live view was parked — sent the write to the following item. Both are
repaired and the helper is bounded to a single section. Worth knowing that every entry
written between 2026-09-12's parking note and now was produced by that helper.

**For whoever does UX-1:** `activeTab` being an index rather than a question id is now
load-bearing in three places — the sidebar's drag handler translates around it,
`deleteQuestionMutation` nudges it with `Math.max(0, t - 1)`, and `pipActiveTab` is a second
index tracking a different question. Moving to an id simplifies all three, and UX-1 is the
natural moment.

### Slice 8 — the response table, 2026-09-12

New: `session/ResponseTable.tsx`. `SessionPage.tsx` 843 → 790 lines, and it no longer
imports `calcResponseScore`, `ScoreBadge` or `Flag` — every part of the response list now
lives in the table.

**The pattern worth naming, since it has now decided three designs:** on this page, *answer
length varies by question type*, and that single fact has settled the distribution block
(Zone 7), the answer key (UX-13) and now the response list. Any future design that treats
the eight types as interchangeable will be wrong in the same way.

**Next obvious call site:** `assignment/ResponseList.tsx` is the same job on the other page,
58 lines, still a card stack that cycles scores on click with the exact-match label bug
`ScoreBadge` fixed. Sharing this table would close the largest remaining piece of UX-21.

### Still open

*Space for changes and corrections to the findings above.*
