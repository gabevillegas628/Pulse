# Pedagogy handoff — knowing when a question is "done"

*Written 2026-08-26. Parked mid-session; the session had drifted from projector polish into
incentive design and the thread was worth keeping rather than losing.*

*Revised the same day in a second session: every claim below has now been checked against the
code, three of them were wrong, and the shape of the work changed as a result. Items 1 and 2
have merged into a single build. See **What changed on review**.*

*Updated 2026-08-27: **the countdown and the close are built.** The scope narrowed usefully
along the way — see **What was actually built**. The revote and the real denominator are still
design notes.*

---

## The question

> I never know how many students are physically present, so I never know when a question is
> done. If I move on too early, students learn they can wait until I go over it and then
> answer correctly. Once that is common knowledge, nobody answers and we wait forever.

A timer was considered and rejected as ham-fisted. Making everything participation-graded
was considered and rejected because it produces garbage answers.

## Three problems, not one

They were tangled together, and each looked unsolvable because the fix for one made the
others worse. Separated:

**A. The denominator is unknown.** `enrolledCount` counts everyone on the roster, present or
not. "17 of 140" could be near-total participation or near-total apathy and there is no way
to tell from the screen.

**B. The close is discretionary, and therefore predictable.** Any rule becomes common
knowledge. Worse, the current implicit rule — close when answers stop arriving — is a
feedback loop students control, and it rewards exactly the behaviour that breaks it: *not
answering keeps the question open longer.*

**C. Grading incentive.** Correctness-graded breeds waiting and copying. Participation-graded
breeds "idk".

---

## Decisions

| Idea | Status | Reason |
|---|---|---|
| Countdown that resets on every answer | **Wanted** | "Genuinely genius." Highest priority. Now understood to require per-question closure — see below. |
| Vote → discuss → revote → reveal | **Kernel worth keeping** | Not the revote itself. The kernel is *theme migration* — see the reframing below. |
| Hide the distribution until close | **Rejected** | Live distributions are the point of the app. Not negotiable. |
| Fixed timer | **Rejected** | Ham-fisted. |
| Blanket participation grading | **Rejected** | Produces garbage answers. |

---

## What changed on review

Three claims in the first draft did not survive contact with the code.

**1. The reset countdown is not self-contained.** This was the load-bearing error.
[`Question`](backend/prisma/schema.prisma#L189) has no status field. Openness is a property
of `SessionRun`, and every question in a session shares one run — the submission gate at
[responses.routes.ts:264-267](backend/src/routes/responses.routes.ts#L264-L267) checks only
that *some* run is open. **There is no such thing as closing a question.** When the clock
hits zero there is nothing for it to close.

That is not a detail. It is the whole problem, and it is described in **The open-question
hole** below.

**2. The revote is blocked at the database level.** The first draft's supporting fact was
half right. `SessionRun` is per-run and `ThemeSet` is keyed by `runId` — but `Response`
carries `@@unique([questionId, studentId])`
([schema.prisma:235](backend/prisma/schema.prisma#L235)), and
[responses.routes.ts:280](backend/src/routes/responses.routes.ts#L280) rejects a second
answer with "Already answered". A second run over the same question does not produce a second
response; it produces a 409. Revote is a migration, not an existing modelled concept.

**3. The correct-answer fix is cleaner than it looked, for a reason worth knowing.** The
student payload at
[responses.routes.ts:131-151](backend/src/routes/responses.routes.ts#L131-L151) already omits
`correctAnswer` — the only channel is the wall. And `ResultsSummary` is shared by four
callers, two of which
([LiveMonitorPanel](frontend/src/components/LiveMonitorPanel.tsx#L156),
[SessionPage](frontend/src/pages/professor/SessionPage.tsx#L902)) are the professor's own
laptop, where seeing the correct answer live is the point. Gating `isCorrect` in the
component would break professor monitoring. Stripping `correctAnswer` from the `/addin/live`
payload is therefore not merely the stronger option, it is the only one that costs nothing.

Everything else in the first draft verified: the file references, the `enrolledCount`
definition, the quadratic arrival model, and the dead `BOOTSTRAPPING` union member.

---

## The open-question hole

Because questions never close, a student can answer *any* question in the session at *any*
time while the run is open. The consequences compound:

- The professor goes over Q1's answer aloud. Students then submit Q1. This is the exact
  behaviour the whole note is trying to prevent, and it is available today with no
  cleverness at all.
- Those late answers land in the live distribution while the class is on Q2, corrupting the
  data the professor is actively teaching from.
- The projector infers the active question from "whichever most recently received an answer"
  ([addin.routes.ts:387-394](backend/src/routes/addin.routes.ts#L387-L394)), so a straggler
  on Q1 drags the wall backwards to a stale question.
- Question access codes are 4-digit numeric and durable for the life of the run
  ([questions.routes.ts:12-19](backend/src/routes/questions.routes.ts#L12-L19)). Write the
  codes down, leave, and submit everything five minutes before the end — after every answer
  has been discussed — with no penalty and without being in the room.

One more, adjacent and worth fixing regardless: the codes are globally unique in a
10,000-space, `/questions/by-code/:code`
([responses.routes.ts:20](backend/src/routes/responses.routes.ts#L20)) has no rate limiter —
the only two in the app are on login and indigo
([app.ts:94](backend/src/app.ts#L94), [auth.routes.ts:13](backend/src/routes/auth.routes.ts#L13))
— and both lookup and submit call `upsertEnrollment`, which auto-enrols. So an authenticated
student who is not in the class can guess codes and be enrolled by the act of answering.
Per-question closure does not fix this, but it shrinks the exposure window from the whole
lecture to the life of one question, which is most of the practical fix.

---

## What was actually built

Shipped 2026-08-27. The scope came down a long way from the section below, because of one
realisation: **a close only has to mean anything during a live session.** Once the run ends,
nothing needs to remember that a question was closed. So the *toggle* persists and the *clock*
does not.

| | Where | Persisted? |
|---|---|---|
| `Question.autoClose` (nullable) + `Class.autoCloseDefault` | [schema.prisma:210](backend/prisma/schema.prisma#L210), [:47](backend/prisma/schema.prisma#L47) | yes — two columns |
| The countdown itself | [clock.service.ts](backend/src/services/clock.service.ts) — an in-memory `Map` | no |
| Submit gate | [responses.routes.ts](backend/src/routes/responses.routes.ts) | — |
| Access-code + question-detail gates | [responses.routes.ts](backend/src/routes/responses.routes.ts) | — |
| Answer key withheld while open | [addin.routes.ts](backend/src/routes/addin.routes.ts) | — |
| Class default toggle | [ClassPage.tsx](frontend/src/pages/professor/ClassPage.tsx) | — |
| Per-question tri-state | [SessionPage.tsx](frontend/src/pages/professor/SessionPage.tsx) | — |
| "Give them more time" override | [questions.routes.ts](backend/src/routes/questions.routes.ts) + SessionPage | — |
| Student sees the close live | [QuestionPage.tsx](frontend/src/pages/student/QuestionPage.tsx) via `question_closed` | — |
| Projector countdown | [CloseCountdown.tsx](frontend/src/components/CloseCountdown.tsx) + [PresentResultsPage.tsx](frontend/src/pages/present/PresentResultsPage.tsx) | — |

The toggle mirrors the `liveThemes` / `liveThemesDefault` pair exactly — same nullable-inherits-
class-default shape, same tri-state UI — with one deliberate difference: **no type restriction.**
`liveThemes` is FREE_TEXT-only; `autoClose` applies to every type, because the answer key is
most worth protecting on the objective ones.

**Grace is scaled, not fixed**, as the tuning note below asked for: the deadline is the median
observed inter-arrival gap for that question times three, clamped to 8–45s, and never sooner
than 20s after the first answer. A hard question that keeps drawing stragglers stays open; an
easy one closes fast. No per-question numbers for a professor to guess at.

**The clock is a cache, not a source of truth.** Every value in it is derivable from
`Response.submittedAt`, so `warmFromDb()` rebuilds it at boot and a mid-lecture restart does not
silently un-time every question. A server that was down long enough for the deadlines to pass
correctly finds those questions already closed.

**It ships dark.** `autoCloseDefault` is false, so nothing changes for any student until the
professor turns it on for one question in one session. For a feature whose whole job is to make
the server refuse submissions, that mattered.

Covered by [smoke-autoclose.ts](backend/scripts/smoke-autoclose.ts) — 63 assertions, of which
the load-bearing ones are that a late answer is refused, that a harvested access code stops
resolving, that the answer key is absent from the projector payload while the question is open
and present once it closes, and that a question with the countdown off behaves exactly as it
does today. `touch()` and `isOpen()` take injected timestamps so the reset, the floor and the
clamps are checked without waiting out real seconds; only one ~20s floor is sat through for
real, because faking that would test nothing.

**Known limits, all consequences of the ephemeral design and all acceptable:**

- Single process only. The `Map` is not shared; running more than one backend instance breaks it.
- Nothing is auditable afterward. You cannot later prove a question was closed, so this cannot
  settle a grading dispute.
- A question nobody answers never closes — the clock starts on the first answer.

### The projector countdown

The bar drains and **every answer snaps it back to full**. That reset is the visual the whole
mechanic depends on — the room has to see that answering buys time, or the rule is just a
server behaviour nobody can act on.

Three constraints shaped it, all of them already written into the page:

- **No JavaScript drives the motion.** A slide show backgrounds the add-in frame, where
  Chromium throttles timers and `requestAnimationFrame` cannot be relied on — the rule is
  stated outright in `globals.css`. So the drain is one linear keyframe on `transform`, and
  the colour shift from signal to warn is an opacity crossfade between two stacked bars
  rather than an animated colour.
- **It has to be right when it mounts mid-window.** The projector connects whenever it
  connects. The payload therefore carries `closeWindowMs` alongside `closesAt`, and the bar
  seeks into its animation with a negative `animation-delay` instead of restarting from full.
- **The reset has to be immediate.** `closesAt` rides along on the `new_response` socket
  event, not just the 6s poll — a bar that jumps five seconds after the answer that caused it
  breaks the connection the room is meant to draw.

Only the seconds readout is driven by JavaScript, on a 1s tick. If the frame is throttled the
number goes coarse while the bar stays smooth, which is the right way round: the bar is what
the back of the hall reads.

The clock has no deadline until the first answer lands, so the bar *appearing* is itself the
room being told what starts it. Under `prefers-reduced-motion` the bar is pinned full rather
than zero-duration — a zeroed drain finishes instantly and would read as "no time left" on a
question with plenty.

### Two tuning constraints found by building the visual

Neither was obvious from the design note, and both are load-bearing. The projector is what
exposed them: as a pure server rule the clock behaved acceptably, and only drawing it made
the failures legible.

**1. The deadline must be monotonic — it may never move in.** The first answer has no pace to
go on and so falls back to a default grace; the second reveals the pace and the computed grace
collapses. With the original constants that second answer pulled the close *twenty-five seconds
earlier*, so the room would have watched the bar shrink at the exact moment an answer landed —
teaching the precise opposite of the rule the countdown exists to teach. `recompute()` now
clamps with `Math.max(clock.closesAt, …)`, and the smoke test asserts no step of a realistic
arrival pattern ever moves the close in.

**2. The unknown-pace grace must not exceed the floor.** Reaching for the *maximum* grace on the
first answer looked conservative and was wrong: it pinned the deadline so far out that the next
thirty seconds of answers could not move it, and the reset stayed invisible for most of the
question's life. The floor already guarantees the room a minimum window, so the grace does not
need to guard it too. With the fallback lowered to the minimum, a realistic pattern holds at
the floor for ~15s and then every subsequent answer visibly extends the close.

The generalisation worth keeping: **the reset is only pedagogically real while the grace is the
binding constraint.** During the floor the question cannot close, so there is nothing for an
answer to extend and the bar legitimately holds still. The floor should therefore be as short
as the room can tolerate, not as long as feels safe — every second of floor is a second where
answering visibly does nothing. `FLOOR_MS`, `MIN_GRACE_MS` and `GRACE_GAPS` in
[clock.service.ts](backend/src/services/clock.service.ts) are the three numbers to retune from
a real lecture; the smoke test's assertions are written against their current values on purpose,
so changing one fails loudly rather than silently drifting.

### Still not built

The full per-`(runId, questionId)` row described below. The ephemeral version gets the
behaviour; the persisted version would add auditability and multi-instance safety. Swapping the
`Map` for that row later does not touch the gate, the payload or the UI.

---

## The build: per-question closure + the reset countdown

*Superseded in part by the section above — this is the fuller, persisted version. Kept because
it is where the ephemeral build would grow to.*

Items 1 and 2 of the original ordering are one build. Withholding the correct answer is not a
separate feature; it is a consequence of a question having a closed state.

**The state belongs to the run, not the question.** A `status` column on `Question` is the
obvious move and it is wrong — re-teaching the same session next term would inherit last
term's closures. The schema already contains this exact reasoning, written for `ThemeSet` at
[schema.prisma:240](backend/prisma/schema.prisma#L240). So: a per-`(runId, questionId)` row
carrying `openedAt` / `closesAt` / `closedAt`.

Given that, the surface is:

| Area | Change |
|---|---|
| Schema | New per-run-question row. `ThemeSet` gives the precedent for the shape. |
| Submit gate | [responses.routes.ts:264-267](backend/src/routes/responses.routes.ts#L264-L267) checks that question's state in this run, not just "a run is open". |
| Lookup gate | `/questions/by-code/:code` refuses a closed question, or the answer page still loads and only the submit fails. |
| Projector | `activeQuestionId` stops being inferred from most-recent-answer ([addin.routes.ts:387-394](backend/src/routes/addin.routes.ts#L387-L394)) and becomes explicit. This *deletes* logic and fixes the drag-backwards quirk for free. |
| Reveal | Strip `correctAnswer` from the live payload while that question is open ([addin.routes.ts:364](backend/src/routes/addin.routes.ts#L364)). Old item 2, roughly three lines, falls out. |
| Professor | Open/close per question, plus extend and reopen. The countdown becomes an automatic caller of "close", not a new mechanism. |

### The clock

Store `closesAt` and treat closed as `closesAt < now()` **at read time**, with
[scheduler.ts](backend/src/scheduler.ts) doing only the socket emit. Then the wall animates
against an absolute timestamp rather than resetting off polled data — the projector polls on
an interval ([PresentResultsPage.tsx:141](frontend/src/pages/present/PresentResultsPage.tsx#L141)),
and a countdown that visibly rewinds is a rule nobody believes. It also removes any race
between the scheduler tick and a submission landing. The existing 100-minute run auto-close
is the precedent; this is the same pattern at a finer grain.

Tuning notes, unchanged from the first draft:

- Needs a **floor** — a minimum open window, or it closes before anyone has read the slide.
- The arrival model in `backend/scripts/rehearse.ts` (`arrivalOffsets`) is a reasonable basis
  for the grace period: mean gap starts near 900ms and widens quadratically, so a fixed grace
  of a few seconds will close too early on the tail. Consider scaling the grace to the
  observed median inter-arrival gap for that question.

### What actually does the work

Worth being clear-eyed about the mechanism. The countdown's input signal — "answers stopped
arriving" — is roughly what the professor already acts on. What changes is that the rule
becomes **announced and un-extendable**: today a stall makes an anxious professor wait
*longer*, and students have learned that. The floor and the grace tuning matter much less
than the fact that zero means zero.

Which is why the first draft's soft version — the clock as a visual the professor honours by
advancing the slide — was rejected on review. A soft zero overrun once teaches the room the
rule is theatre, and that is precisely the failure being escaped. If the clock is built, the
close has to be real.

---

## The unresolved tension, reframed

Peer Instruction as classically specified (Mazur) is: vote → **hidden** → discuss with a
neighbour → revote → reveal. The hiding is what makes round one honest, and hiding round one
collides directly with the app's premise.

Two things sharpen this from the first draft.

**Think-pair-share's usual objection is about the discussion, not the data.** The N/2
reduction is about who is *talking*; the measurement is still N both times. Mazur's actual
claim is narrower — the second vote improves specifically when round one splits in the 30–70%
band, i.e. when there are enough wrong answers for a neighbour to be worth listening to.
Outside that band it does nothing, which likely matches the experience of it never working
well.

**But the real objection survives that, and it is the better one:** the answers still cannot
be dealt with at scale. Which is the thing Pulse actually solves — and that is where the
kernel is.

**The kernel is not the revote. It is theme migration.** Two theme sets over the same
question, showing which categories drained and which filled after discussion. No clicker can
do that, and "here is how the room's *reasoning* moved" is a better teaching moment than
"here is where it landed".

The specific thing that has to be true for this to be worth anything: `ThemeSet` is keyed by
`runId`, so two runs give two theme sets naturally — but they would be derived
*independently*, and the categories would not align, so there would be nothing to draw a
migration between. **Round two must inherit round one's categories rather than re-derive
them.** That is a constraint on the theming service, not a blocker, but it is the load-bearing
requirement.

Still parked. Both the response uniqueness migration and the category-inheritance work are
real, and neither is on the critical path for the build above.

---

## The real denominator

Not attendance. **How many people have the question open.**

Every student hits `GET /student/questions/:id`
([responses.routes.ts:70](backend/src/routes/responses.routes.ts#L70)) to see the question.
Nothing records it — the route only calls `upsertEnrollment` and returns. Log it and the
screen can say:

> **43 opened · 38 answered · 5 outstanding**

"Done" becomes observable instead of intuited. Roughly a `(questionId, studentId,
firstSeenAt)` table plus a count on the live payload.

**Zero-schema interim, corrected:** the first draft suggested using the previous question's
answer count as the denominator. That is biased down exactly when it hurts — if the previous
question suffered the waiting problem, its count is depressed, and an undercount would make
the current question look done early. Take the **max over prior questions in the session**,
not the previous one. Same zero lines of schema. `enrolledCount` is the one number on screen
that is guaranteed to be wrong.

Note this pairs well with the reset countdown — "5 outstanding" plus a running clock is a
much fairer close signal than either alone.

---

## Grading — half-solved already

The garbage-answer problem has machine-checkable parts that already exist:

- `isFlagged` (word count under 10) and `aiScore` are computed per response and already reach
  the projector payload.
- So "participation credit requires a non-trivial answer" is enforceable **for FREE_TEXT**.
  That is grading *effort*, not correctness — which is the middle ground between the two
  rejected options.
- Objective types have no equivalent signal. For those the lever is structural (closure, and
  possibly the revote), not analytical.

The other half is stakes, and it is policy rather than software: copying is rational when one
question matters. Drop-lowest-N across the semester makes any single question cheap, and
cheap is what makes honest answering rational.

---

## Suggested order

1. ~~**Per-question closure + the reset countdown.**~~ **Done 2026-08-27**, in its ephemeral
   form — see *What was actually built*. Closed the harvest hole and made the correct-answer
   reveal a consequence rather than a feature. The projector countdown followed the same day.
   The drag-backwards quirk still stands: `activeQuestionId` is still inferred from
   most-recent-answer, because the ephemeral build did not need to replace it.
2. **Max-over-prior-questions denominator.** Zero schema, computed from data already on the
   wire. Replaces the one number guaranteed to be wrong.
3. **Rate-limit `/questions/by-code/:code`.** Small, unrelated to pedagogy, worth doing while
   the area is open.
4. **Log question opens** for a real denominator and an "outstanding" count.
5. **Theme migration**, if the category-inheritance constraint resolves into something worth
   building.

---

## Caveat, resolved

The first draft ended: *software cannot fix an incentive problem, only change which path is
easier. The single thing that would end "wait for the professor" is not revealing the answer
while the question is open — and that is a policy held in the room, not a feature that can be
shipped.*

That conclusion was wrong, and it was wrong because of the same missing fact as everything
else here. With per-question closure, the question is **closed before the professor goes over
it**, and late submissions are refused by the server. It is not a policy held in the room. It
is the build described above.

What remains genuinely policy: whether the professor honours the reopen button.

---

## Loose end noticed along the way

`BOOTSTRAPPING` is declared in `ThemeSetStatus` in both
[themes.service.ts:86](backend/src/services/themes.service.ts#L86) and
[shared/src/index.ts:304](shared/src/index.ts#L304), and is **never assigned anywhere** (the
enum in [schema.prisma](backend/prisma/schema.prisma#L245) declares it too). The pre-theme UI
derives that state on the frontend instead. Worth deleting from the unions so it stops
implying a state that exists.
