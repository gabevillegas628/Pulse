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
- [ ] **Status** — unblocked, worth doing

It is fetched and passed only to the PiP panel (`:1453`). `17 / 42 answered` is the number
that decides whether to move on, and it is absent from the page itself.

**Decision:** Not actually a live feature, so it survives the parking. "34 of 42 answered" is a
participation fact that reads as well after class as during it, and it is cheap.

### UX-8 — PiP is the only good live view, and it is Chrome/Edge only
- [-] **Status** — withdrawn 2026-09-12

It needs a deliberate click and fails through `alert()` (`:709`). Once UX-6 exists, PiP
becomes a bonus rather than the only path to a usable live view.

**Decision:** Withdrawn. It was framed as "PiP is the only good live view", implying PiP was a stopgap to
be replaced by an inline layout. That has it backwards: PiP is the cross-platform live view
and the one to preserve. Nothing to fix here.

### UX-9 — The sidebar never shows which questions are closed
- [ ] **Status**

`Question.closedAt` exists (`shared/src/index.ts:122`) and auto-close closes questions
individually. During a run that is arguably the most important per-question state, and it
is invisible.

**Decision:** TBD

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
- [ ] **Status**

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

---

## Zone 6 — The sidebar is the best part of the page and under-used

### UX-18 — Show the grading label it already computes
- [ ] **Status**

`:614` builds `"9 / 14 graded"` / `"not graded"` and then buries it in a `title` tooltip,
rendering only `"14 responses"` in a colour that has to be decoded.

**Decision:** TBD

### UX-19 — Keyboard navigation between questions
- [ ] **Status**

Up/down arrows or `1`-`9`. Helps both grading and live teaching.

**Decision:** TBD

### UX-20 — Question reordering
- [ ] **Status**

No way to reorder from the sidebar.

**Decision:** TBD

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

**Decision:** Started. Four shared pieces now exist: `components/StructureKeyField` (the structure answer
key, previously living only inside the assignment page), `ui/Switch` (lifted from `ClassPage`, which
hand-rolled the same markup three times), `ui/Popover` (new — the repo had only
`<details>`), and `session/QuestionSettings`. `ui/Button` gained a `size` so the small
inline controls share one definition rather than copying each other's classes.

Net −282 lines across the two pages. The assignment-side duplication is untouched.

### UX-22 — Add and Edit question modals are near-duplicates that diverged
- [ ] **Status**

`:1264` and `:1348`. Add uses a newline textarea for options, Edit uses per-option inputs
with add and remove; Add lets you pick a type, Edit does not. One component with a `mode`
prop.

**Decision:** TBD

### UX-23 — Native `alert()` / `confirm()` in six places
- [ ] **Status**

Delete question, re-grade, full credit, PiP unsupported, delete failure — alongside
`Card`-based modals everywhere else.

**Decision:** TBD

### UX-24 — Duplicated feedback
- [ ] **Status**

`summarizeMutation.isError` renders twice (`:1143` and `:1148`), and *"Could not change
that — try again."* appears three times verbatim.

**Decision:** TBD

### UX-25 — About 25 `useState` calls in one component
- [ ] **Status**

Eight for Add-question and eight for Edit-question. UX-22 collapses most of it.

**Decision:** TBD

---

## Order of work

Sliced by zone rather than by phase. Each slice extracts one zone into a component *and*
redesigns it, in a commit that leaves the page working — instead of one wholesale
extraction followed by one wholesale redesign.

1. **Settings** — UX-2, UX-3, part of UX-5 and UX-21. ✓ done 2026-09-12
2. **Answer key** — UX-13, carrying UX-10, UX-11 and UX-12. ✓ done 2026-09-12
3. **Grading** — UX-14 and UX-15. ✓ done 2026-09-12
4. **Sweep** — UX-17 (amended), UX-18, UX-22 through UX-25, and whatever of UX-21 is left.
   UX-16 was pulled forward ahead of this and is done.
   UX-7 and UX-9 ride along here; neither is a live feature.
5. **Authoring versus review** — UX-1, redefined. By then each zone is a component, so it
   reduces to choosing which ones render when.
6. ~~**Live layout**~~ — UX-4, UX-6, UX-8. Parked; see Zone 2. Not a step in this plan
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

### Still open

*Space for changes and corrections to the findings above.*
