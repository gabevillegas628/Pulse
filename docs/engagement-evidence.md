# Engagement evidence — what we saw, what it proves, what would prove it

*Written 12 Sep 2026, third week of the first semester Pulse has run in a live course.
A conversational session, parked for later. **Nothing here is built.** The action items are
at the bottom; everything above them is the reasoning that produced them.*

*The course is in its third year. It was designed to be active-learning based from the start;
Pulse exists because there was no way to actually run it that way. This semester is the first
time the design and the tooling have both been present, which is why the observations below
are worth writing down rather than shrugging at.*

*Revised the same day, after checking `classroom_response_tool_handoff.md`: **this semester was a
full redesign, not the adoption of one tool.** Four variables moved at once. A cost-based
explanation for the enrolment anomaly was raised, looked like the best fit available, and was then
refuted — it is kept in §3 because the refutation is the useful part. The conclusions in §2 are
unchanged; those in §3 are weaker than the first draft claimed. See **§0**.*

---

## The two observations

**1. Participation.** Historically ~30 of 150 enrolled attended a given lecture, and the same
four students answered every question. This semester: ~130 of 140, and no student gets called
on twice.

**2. Enrolment.** All sections are still full past the no-penalty add/drop deadline. In six
years of teaching this has never happened — the normal pattern is multiple open sections by
week two. The expectation this semester was *worse* churn, not better, because attendance is
now required to participate.

Both are anecdotal. This document is mostly about which parts survive scrutiny and which don't.

---

## 0. This was a redesign, not a change

Written last, and placed first because it reframes everything below. The initial reading of the
semester was "the only variable that changed is Pulse." That is not close to true. Counting from
[`classroom_response_tool_handoff.md:123`](../classroom_response_tool_handoff.md#L123) and the
paragraph around it, at least four things moved at once:

1. **Pulse** — in-class engagement-graded openers, the subject of this document.
2. **Three chapters cut** from the end of the semester.
3. **Publisher adaptive quizzes (~15% of grade) replaced** by the in-class opener. Not deleted —
   the grade weight was transferred.
4. **Exam format shifted** toward fewer MCQ and heavier FRQ weighting, with more time per question.

A fifth is pending: an open-source textbook being written to replace the required access code.

None of this is a criticism — redesigns move many things, and this one was deliberate. But it
means **no single-variable attribution is available for anything measured at the course level**
(enrolment, grades, DFW). The participation finding in §2 is unaffected, because it is a
within-lecture behavioural measure that none of the other three touch. Everything in §3 is
affected.

---

## 1. Harvested question codes — solved, pending a toggle

### The worry

Question cards show the access code alongside the QR, so a student too far back to scan can
still answer. That also means codes can be posted to a group chat and answered from outside
the room.

### Why monitoring is the wrong fix

Geolocation is unreliable and carries a disclosure obligation. IP logging is porous — not
everyone is on campus wifi, and a hotspot defeats it. Both are a lot of privacy exposure for a
signal that would be wrong often enough to be unusable.

Worth stating plainly: **the app stores nothing that could answer this question today.**
[`Response`](../backend/prisma/schema.prisma#L277) holds `questionId`, `studentId`, `runId`,
the text, word count, the grading fields and `submittedAt`. No IP, no device, no location. The
only `req.ip` use in the codebase is in
[`login-throttle.ts`](../backend/src/middleware/login-throttle.ts), where it keys a rate limiter
and is never persisted. Adding any of it would be new collection, not new analysis.

### The fix that already exists

The structural answer is to make a harvested code worthless, and it was built on 27 Aug 2026:
per-question **auto-close** ([`clock.service.ts`](../backend/src/services/clock.service.ts),
gates in [`responses.routes.ts`](../backend/src/routes/responses.routes.ts)). A question's
deadline resets on every answer and closes once arrivals taper; after that both the access-code
lookup and the submit route refuse. The exposure window drops from the whole lecture to about a
minute per question.

**It ships dark.** `Class.autoCloseDefault` defaults to `false`
([`schema.prisma:85`](../backend/prisma/schema.prisma#L85)), so unless it has been switched on
for a class or a question, the loophole is fully open in the live sections right now.

> **This is the one action item with a live consequence. Turn it on.**

See [`pedagogy_handoff.md`](../pedagogy_handoff.md) for the design reasoning and the known
limits (single process, not auditable after the fact, a question nobody answers never closes).

### If it ever needs more

Aggregate timing anomalies are derivable from `submittedAt` alone — a tight burst of answers
long after a question's arrival curve has flattened is the signature of a code being shared and
answered in bulk. That is a report over existing data, not new collection, and it identifies a
*pattern* rather than a student. Not worth building unless auto-close proves insufficient.

---

## 2. The participation jump survives the obvious confound

The worry was that more answers is just more bodies. It isn't, and the arithmetic settles it.
The trick is to divide by **attendance**, not enrolment — that isolates behaviour from headcount.

| | Present | Answering | Rate among those present |
|---|---|---|---|
| Before | ~30 | ~4 | ~13% |
| Bodies-only prediction | ~130 | **~17** | 13% (unchanged by assumption) |
| Observed | ~130 | most of the room | ~90%+ |

The attendance effect explains 4 → 17. It does not explain 17 → 130. The conditional
participation rate moved roughly 7x *on top of* the 4.6x attendance increase, and those are
independent multipliers.

The mechanism is unglamorous, which is a point in its favour. Hand-raising is public, serial and
winner-take-all: one student answers while the rest watch, so the marginal student's cost is
social exposure and the benefit is nothing. Answering in Pulse is private, parallel and cheap.
"The same four people answer everything" was never a motivation problem — it was a cost
structure, and the cost structure changed. This is predictable from the design in advance of
observing it.

**Caveat:** the "30 and the same four" baseline is a recollection, not a record. Generous error
bars still don't close a gap that size, but it should be described as an estimate.

**What it does not show:** participation is near-guaranteed to rise when responding is made
cheap — that is close to tautological. Whether cheap responses reflect thinking is a separate
question, and neither the response counts nor anyone's gut can answer it. See §5.

---

## 3. The enrolment anomaly — interesting, not yet evidence

Three problems with reading this as "requiring attendance improved retention":

**The timeline doesn't fit the mechanism.** By the drop deadline students had seen perhaps three
to five Pulse lectures. Week one and two drops are overwhelmingly schedule-shopping, aid
packages, section swaps and syllabus-skim bailouts — not students who have formed an attachment
to a course. Engagement-driven loyalty needs months. The direction is genuinely surprising
(a participation requirement should push drops *up*), but "forcing them to come makes them want
to be there" cannot be the explanation at this range.

**"Full" is a two-sided quantity.** Sections at cap means either zero drops *or* drops
immediately backfilled by adds. Those are completely different stories — one is retention, the
other is demand. **The number to ask the registrar for is gross drops per section, not net
seats.** This is the cheapest thing on the list and it may dissolve the anomaly outright.

**Four variables changed, not one.** See §0. Undergraduate enrolment is also up nationally
(+1.2%, +1.4% at public four-years), and locally any of section counts, a competing section
removed, an instructor leaving, prereq or degree-plan changes or a cohort bump would do it. The
cleanest single control is **peer sections of the same course this semester** — if theirs are
also unusually full, it's institutional.

**A cost hypothesis was raised and killed, and the refutation is worth keeping.** Replacing the
publisher adaptive quizzes looked like it might have removed a paid access-code requirement, which
would have been the best-fitting explanation available: materials cost drives drops in exactly the
week-one-to-two window that engagement-loyalty could not explain, and the base rates are large
([FLVC 2022](https://www.flbog.edu/wp-content/uploads/2023/03/Student-Textbook-Survey-Infographic.pdf):
44% took fewer courses, 38% skipped a specific course, 53% didn't buy required texts).

**It is wrong.** The access code is still required — the open textbook that would replace it is
unfinished. Cost did not change, so cost cannot explain a change in behaviour.

Worse for the anomaly: students now pay the same fee while the ~15% of the grade that used the
courseware has moved in-class. Same cost, less use, a *worse* deal than last year — which should
push drops **up**. The enrolment result is therefore slightly harder to explain than before this
was checked, not easier.

**The real test is the mid-semester withdrawal deadline**, not add/drop. Withdrawals there *are*
about engagement and performance, which is where a Freeman-style DFW effect would surface if it
is real.

---

## 4. What the literature actually says

The prior going in was that this whole field is hokum. That prior was doing useful work and
should be kept — it just needs aiming.

| Finding | What it supports |
|---|---|
| [Credé, Roch & Kieszczynka 2010](https://journals.sagepub.com/doi/10.3102/0034654310362998) — 69 studies, 21k+ students | Attendance predicts grades better than SAT, HS GPA or study skills (r = .44). **But mandatory attendance policies have only a small effect on grades** — attendance predicts because of *who chooses to attend*. |
| [Freeman et al. 2014, PNAS](https://www.pnas.org/doi/10.1073/pnas.1319030111) — 250 studies | Failure rates 34% → 22% under active learning. Fail-safe N: 114 unpublished nulls for exam performance, 438 for failure rate, would be needed to erase it. Funnel plots clean. |
| [Theobald et al. 2020, PNAS](https://www.pnas.org/doi/10.1073/pnas.1916903117) — 44,606 students | Achievement gaps narrowed 33% on exams, 45% on pass rates. Their "heads and hearts" caveat: this needs deliberate practice *plus* inclusive facilitation. |
| [Schwartz, Sadler, Sonnert & Tai 2009](https://onlinelibrary.wiley.com/doi/10.1002/sce.20328) — 8,310 students, 55 colleges | Depth (a month+ on one topic) → better college science grades. Breadth → no advantage in chem/physics, **significant disadvantage in biology**. |
| [Kirschner, Sweller & Clark 2006](https://www.tandfonline.com/doi/abs/10.1207/s15326985ep4102_1) | The strongest critique of progressive pedagogy — and it is an attack on *minimal guidance* (discovery, inquiry, PBL), not on guided practice. See below. |
| [Deslauriers et al. 2019, PNAS](https://www.pnas.org/doi/10.1073/pnas.1821936116) | Randomised, same content and handouts: active-learning students **learned more and felt they learned less**. |
| [Finelli/Shekhar StRIP work](https://link.springer.com/article/10.1186/s40594-018-0102-y) — 1,051 students, 18 courses | Student resistance is significantly moderated by instructor *explanation* (purpose, course expectations, activity expectations) and facilitation. |
| [Cullen & Oppenheimer 2024, *Science Advances*](https://www.science.org/doi/full/10.1126/sciadv.ado6759) | "Optional-mandatory" attendance: 90% opted in; those who *chose* the requirement attended **more reliably than those who were mandated**. 73–95% opt-in across five classes, ≤10% regret. |
| [Just-in-Time Teaching](https://www.une.edu/sites/default/files/JiTT%20white%20paper_Final%20for%20Website.pdf); [Phys. Rev. PER case study](https://journals.aps.org/prper/abstract/10.1103/PhysRevPhysEducRes.12.020133) | Pre-class work raises retention, process skills and content knowledge, and narrows gender gaps. Gains on warmup-linked items exceeded those on traditional homework items. |

### The load-bearing point: this is guided practice, not discovery

Kirschner/Sweller/Clark is the most-cited demolition of constructivist teaching, and it is
*supporting evidence* for what Pulse does. Their target is minimal guidance — put students in
groups, let them construct understanding. Their finding is that novices learn far more from
strongly guided instruction with worked examples, and minimal guidance only stops hurting once
learners have enough prior knowledge to guide themselves.

Pose a problem → student commits to an answer → immediate feedback → expert explains. That is
the guided model they argue *for*. The instinct that dismissed "newfangled pedagogy" for years
was filtering correctly; it just had no name for what it was keeping. Nothing was converted to
here — the well-evidenced core was independently rebuilt.

### Two things to brace for

**Course evaluations may drop while learning improves.** Deslauriers is the citation to have
ready if the numbers dip and someone reads them back. The authors' own conclusion is that
evaluating instruction by student perception actively promotes inferior pedagogy.

**Framing does most of the work on resistance.** Explaining *why* the question is there costs
ninety seconds. Same lever as the Cullen & Oppenheimer autonomy result — worth considering an
opt-in framing for the attendance requirement next term, which would also be a free natural
experiment.

### Where the field is genuinely soft

- "Active learning" is definitionally mush — a
  [2023 systematic review](https://files.eric.ed.gov/fulltext/EJ1415910.pdf) exists because
  nobody agrees what it means. Always ask *which mechanism*.
- Most of it is quasi-experimental, unblinded, with outcome measures written by whoever is
  testing the hypothesis. Freeman's bias analysis addresses the file drawer, not this.
- Implementation quality dominates effect size; badly-run active learning loses to a good lecture.
- Adjacent claims are flatly debunked — learning styles being the standout.

### On the chapter cut

Three chapters were cut from the end of the semester to let the rest breathe. Depth-over-breadth
supports this directly. **One caveat worth revisiting:** cutting from the end means the calendar
chose what to drop, not pedagogy. Worth one pass asking which three would be cut if they sat in
the middle, and whether any are prerequisites for a downstream course.

### On dropping the pre-class quizzes

Recalled in conversation as "eliminated for effectively no return." The handoff doc says otherwise:
the ~15% grade weight was **transferred** to the in-class opener, not removed. That distinction
matters, because the instinct and the reasoning behind it point different directions.

**The instinct was right; the stated reason wasn't.** Pre-class work has a genuine evidence base
(table above). But look at what JiTT actually requires: students submit responses *and the
instructor reads them and changes the lecture accordingly*. That loop is the mechanism. Publisher
adaptive courseware does none of it — nobody reads the output, it doesn't alter what gets taught,
and it is autograded compliance work students resent. What was dropped was a low-fidelity
implementation of a good mechanism, replaced by a high-fidelity implementation of the in-class
half. The mechanism survived; the vendor didn't.

**What was actually lost: spacing.** Pre-class quizzes forced contact with the material between
lectures. The opener is entirely massed within the lecture hour. Distributed practice is among the
most robust findings in the literature, and some of it was given up in the trade. This is the
second argument for the delayed re-ask in §5.

**Loose end, student-facing.** The access code is still required (§3) while the graded work that
used it is gone. Students are paying the same fee for less use and will notice. Worth checking
whether the bundle can be unbundled now that the courseware component is dead, and worth saying
out loud in class either way.

---

## 5. Measurement plan

The retrospective comparison is dead: exams differ between semesters and aren't kept, so
per-item history is gone. Everything below is prospective except the registrar data.

### Revote — parked on cost, not rejected

The peer-instruction signature (vote → discuss → revote → correct share rises) is the cleanest
possible learning measure: each student is their own control, minutes apart, needing no cohort
comparison. It is parked because lecture minutes are the binding constraint and the semester is
already running behind its original pacing.

Two notes for whenever it comes back:

- **It was never meant to run on every question.** Mazur's rule is conditional: revote only when
  the first vote lands roughly in the **30–70% correct** band. Above ~70%, explain and move on.
  **Below ~30%, do not send them to discuss** — with almost nobody holding the right answer, peer
  discussion propagates the wrong one. That is a reteach signal. In practice this is a minority
  of questions, so the honest cost is a few minutes on maybe one question in four, not double
  on all of them.
- Pulse already computes the live distribution, so the cheap version is the app *flagging* that a
  question landed in the band and leaving the call to the professor.
- The blocker is real: `Response` carries
  [`@@unique([questionId, studentId])`](../backend/prisma/schema.prisma#L299) and
  [`responses.routes.ts:291`](../backend/src/routes/responses.routes.ts#L291) rejects a second
  answer with a 409. Revote is a migration with ripples into `ResultsSummary` and the projector
  payload, not a toggle.

### Delayed re-ask — the chosen instrument

**Ask the same question again two or three weeks later, as a warm-up.** Better than revote on
every axis that matters here:

- Costs one question slot, not a discussion block.
- **Needs zero schema work.** A second question record with the same text has a different
  `questionId`, so the unique constraint never notices. The migration problem disappears.
- Better evidence: revote measures whether four minutes of discussion moved someone; a delayed
  re-ask measures whether it stuck for three weeks, which is what exams actually test.
- The measurement *is* the intervention — spaced retrieval is itself among the most robust
  findings in learning science. Revote cannot claim that.
- **It partially replaces something the redesign gave up.** Pre-class quizzes forced contact with
  the material *between* lectures; the opener is entirely massed inside the lecture hour, so
  distributed practice was lost in the substitution (§4). A delayed re-ask restores some of it
  inside class time already under your control, at no cost in student workload. This is the second
  independent reason to build it, and it moves the item up the list.

The only build needed is a way to mark two questions as a matched pair and a report of first-ask
vs later-ask correctness per student. A nullable FK and a query. For a handful of pairs it can be
eyeballed before any code is written at all.

### Anchor items — start with the next exam

Identical exams aren't needed; **identical items** are. Embed 5–10 verbatim anchor items in every
exam from here on, and write the rest however you like. That is standard common-item equating: the
anchors calibrate difficulty across semesters so the rest becomes comparable. Costs nothing now
and in two years makes every exam commensurable. Tag each item as retained-chapter or cut-chapter
while you're at it — it is the only way the chapter cut ever gets evaluated.

### Registrar data — the retrospective set that survived

Exams weren't kept, but **institutional research has grade distributions and DFW rates for all six
years, per section**. That is precisely the Freeman outcome measure, and it is usually a routine
request. Ask for gross drops per section by week at the same time (see §3).

### Housekeeping from now on

Keep every exam, with per-item data. The habit is the point; it costs nothing and it is the only
reason this section has to exist at all.

---

## Action items

**No code required:**

| | Why |
|---|---|
| Turn on `autoCloseDefault` for the live classes | Closes the harvested-code window. The only item with a live consequence. §1 |
| Ask the registrar for gross drops per section, 6 years | Distinguishes retention from demand; may dissolve the anomaly. §3 |
| Ask for grade distributions / DFW rates, 6 years | The retrospective dataset that survived. §5 |
| Check peer sections of the same course this term | The single cleanest control for institutional confounds. §3 |
| Embed 5–10 anchor items in the next exam; tag retained vs cut chapters | Makes future exams comparable. §5 |
| Write a priority-ordered drop list for the rest of the semester | Vibes-based pacing is fine; its failure mode is an unplanned overflow in week 13. Deciding the cut order in advance fixes that without giving up the flexibility. |
| Re-ask 2–3 questions from earlier lectures as warm-ups | Starts generating retention data immediately, with no build at all. Also restores some of the spacing lost with the pre-class quizzes. §5 |
| Check whether the access code can be unbundled, and tell students either way | They pay the same fee for courseware that is no longer graded. Real money across 140 students, and a goodwill problem if it goes unmentioned. §4 |

**One build, when wanted:**

| | Size |
|---|---|
| Paired-question tagging + first-vs-later correctness report | Nullable FK and a query. Does not touch the response model. |

---

## Open, undecided

- **Revote** is parked on lecture-minute cost, not rejected on merit. If pacing settles, the
  conditional 30–70% version is the one to build.
- **Opt-in attendance framing** (Cullen & Oppenheimer) for next term — would likely improve
  compliance *and* constitute a natural experiment.
- **Which three chapters** — revisit whether the calendar picked correctly. §4
- **The open-source textbook is the cleanest future experiment available.** The term it replaces
  the access code, cost changes — and if everything else is deliberately held still that term,
  *only* cost changes. After a redesign that moved four variables at once, one term with a single
  moving variable is worth protecting on purpose. Do not ship it alongside another round of changes.
- `railway.toml` sets `watchPatterns` to match every path, which means a docs-only commit to `main` triggers a full
  build, migrate and restart. Narrowing the pattern to exclude `docs/` and `*.md` would make
  documentation commits free. Unrelated to the above; noted because it came up while filing this.

---

## Honest scorecard, 12 Sep 2026

A **real and large attendance effect**. A **real participation-rate effect** that survives the
bodies confound — the one finding here that is not threatened by §0, because it is measured within
a lecture. **No learning evidence yet** — absent, not negative.

The enrolment anomaly is **unexplained, and the explanation got harder rather than easier**: the
engagement-loyalty story doesn't fit the timeline, the cost story was checked and refuted, and four
variables changed simultaneously so nothing at the course level can be attributed to any one of
them. The honest summary of the semester is *a redesign appears to be working*, not *Pulse works*.
Separating those requires terms where fewer things move at once.

For week three of year three, that is a reasonable place to be standing. The two things that
would move learning from gut to data — delayed re-asks and anchor items — both start with the
next lecture and the next exam, and neither needs code.
