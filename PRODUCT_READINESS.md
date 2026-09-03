# Pulse: what it would take to run this for someone else

Written September 2026, ahead of the November talk, so there is a real answer
when somebody says they'd like to use it.

A formatted version of this document is in `PRODUCT_READINESS.html`,
self-contained — open it in any browser.

Status: first full rollout, one course, ~140 seats, single instance, 192 test
assertions, ~$17/semester in model spend.

Updated 2 September 2026 — Gate A is closed, and the first Gate B item with it.
See *Closed since this was written*.

---

## Where it stands

The code is in better condition than most things at this stage. The hard parts
— the arming threshold on the close countdown, monotonic deadlines, token
renewal on activity, warming clocks from `Response.submittedAt` after a restart
— are not just implemented but reasoned about in the comments.

What is missing is everything that assumes there is exactly one professor, one
machine, and one person who cares when it breaks. None of it is deep, but it is
broad, and it does not surface until a second person shows up.

Testing is further along than it looks from the outside: 183 assertions in
`backend/scripts/`, including a real unit suite for the clock driven on injected
timestamps. The clock half now runs on every push; the three integration
scripts still want a Postgres service and a booted backend before they can join
it.

## Three thresholds, not one

"Could I use it?" means three different things depending on who is asking, and
they need almost disjoint work.

**Gate A — survive this semester.** One course, you operating it. The bar is
that a lecture never fails in a way you can't recover from in the room.
*Closed — four items fixed, and a fifth that turned out not to be one.*

**Gate B — a second instructor at Rutgers.** Someone you know, no contract. The
bar shifts from "it works" to "it is isolated, recoverable, and doesn't need you
in the room." *Weeks of work; account self-service is the bulk of what is left,
now that ownership is enforced in one place.*

**Gate C — another institution.** People you've never met, whose IT department
has opinions. The bar is procurement, not engineering. *Months, mostly not code.*

---

## Closed since this was written

| Item | What changed |
|---|---|
| Duplicate submit returned 500 | The unique constraint is the guard now, not the `findUnique` in front of it. `responses.routes.ts` catches `P2002` and answers "Already answered" (409), and `error.middleware.ts` carries a generic `P2002` → 409 backstop for every other check-then-create in the codebase. |
| Tests existed; nothing ran them | `.github/workflows/ci.yml` builds all four workspaces on push — which is the typecheck, since every workspace build runs `tsc` — then runs `npm run test:clock`. A new `--clock-only` flag stops `smoke-autoclose.ts` before anything opens a connection, so its 37 clock assertions run on a runner with no Postgres at all. |
| No error tracking | A seam, not a provider. `utils/reporting.ts` exposes `captureException()`, called from the 500 branch of the error middleware and from process-level handlers for `unhandledRejection` and `uncaughtException`. Adopting a service is now one file and an env var. **Still the weakest of the four** — until something is behind it, a 500 mid-lecture is a log line, exactly as before. One behaviour changed with it: an unhandled rejection now logs and carries on rather than killing the process, which is the right trade during a lecture but means a broken invariant runs on. |
| `/health` didn't touch the database | Now `SELECT 1`, answering 503 and `db: "down"` when that fails. Railway reads this path for both routing and its restart policy, so an instance that cannot reach Postgres now says so. |
| Any professor could watch any lecture | Fixed, and the reason it was possible is fixed too. Ownership used to be answered inline at 54 query sites; it now lives in `utils/ownership.ts` as composable Prisma predicates, and `socket.ts` — the one caller that isn't a query — uses the same module to check that the session is actually the professor's before admitting them to `{sessionId}:professor`. `scripts/smoke-socket-auth.ts` covers it with two professors and one session, asserting both the room decision the server reports and what actually arrives on each socket when a student answers. It needs a booted backend and a database that isn't the live one, so it is a dev-machine suite rather than a CI one for now. |
| ~~Uploads on ephemeral disk~~ | **Not a bug.** A Railway volume is mounted and `UPLOAD_DIR` points at it. Worth revisiting if Pulse ever runs more than one instance, since a volume attaches to one — but nothing is being deleted, and this was a misreading of `config/index.ts:17`. |

---

## The register

Ordered by when it bites. Gate = earliest threshold at which it stops being
optional. Gate A rows have moved to the section above.

| Item | Gate | If skipped | Size |
|---|---|---|---|
| Response uniqueness ignores run (`schema.prisma:235`) | B | `ThemeSet` is keyed by run; responses aren't. Repeating student can't answer, or overwrites last term. | 1 day |
| No self-service password reset | B | Professor-resets-student works at one class, fails at five. No mail provider wired in. | 3 days |
| No admin role | B | Flat professor list behind one shared invite code. No transfer, deactivate, or system view. Three features under one row, and only the system view is expensive. | 1–2 days |
| Unbounded AI spend per account | B | `MAX_CLASSIFY_CALLS` bounds a runaway loop, not a term or a person. | 2 days |
| Untested backups, no retention policy | B | A backup never restored is not a backup. Responses are education records. | 2 days |
| Multi-instance coordination | B | See below. For zero-downtime deploys, not capacity. | 1 week |
| SSO (Shibboleth / InCommon) | C | No university wants a separate password. Also dissolves the reset problem. | 2 weeks |
| LTI 1.3 / Canvas grade passback | C | Largest adoption lever after "does it work". Rutgers is a Canvas school. | 3 weeks |
| Accessibility (WCAG 2.1 AA, VPAT) | C | The blocker nobody anticipates. Public universities must ask. | 3 weeks |
| HECVAT + data processing agreement | C | The standard higher-ed security questionnaire, plus a FERPA position in writing. | 2 weeks |
| A legal entity | C | The boundary between side project and personal assets. Also required to be paid. | 1 week |

Sizes are unhurried solo estimates including testing.

---

## Multi-instance: Redis, for four things

The Socket.io room adapter is the easy part (`@socket.io/redis-adapter`, ~10
lines). There are four pieces of process-local state, and two are
correctness-critical.

| State | Where | What a second instance does |
|---|---|---|
| Question clocks | `clock.service.ts` (the `clocks` Map) | **The real problem.** A arms a clock, B has no record, `isOpen()` returns true, B accepts answers after the countdown ended. The countdown becomes advisory. |
| Theme debounce timers | `themes.service.ts:529` (`pending`) | Both instances bootstrap the same theme set: duplicate categories, double spend. |
| Socket.io rooms | `socket.ts` | Half the room misses `question_closed` / `new_response`. |
| Rate limiter | `auth.routes.ts:30` (MemoryStore) | Login attempt limit multiplies by instance count. |
| Scheduler + clock sweep | `scheduler.ts`, `startClockSweep()` | Every instance runs both. Needs a leader lease, not a shared store. |

The header comment in `clock.service.ts` already flags this. Everything is keyed
`runId:questionId`, so it maps onto Redis hashes with a TTL almost
mechanically; the scheduler needs a `SET NX` lease. Do it as one project — a
half-migrated clock is worse than an un-migrated one.

**Why, though.** A 140-seat lecture is ~3 writes/sec; capacity is not the
constraint. Multi-instance buys deploying without dropping a live lecture, and
surviving a crashed container mid-question. Real reasons — just different ones.

---

## What a class costs to run

One 140-seat course: 5 free-text questions/lecture, ~120 answers each, themes
and grading both on, 28 lectures/semester.

| Call | Model | Rate in/out per MTok | Per question | Per lecture |
|---|---|---|---|---|
| Theme bootstrap (1 call, ≤40 sampled) | Opus 5 | $5 / $25 | $0.032 | $0.16 |
| Theme classify (~10 calls of 8) | Haiku 4.5 | $1 / $5 | $0.013 | $0.07 |
| AI grading (~5 calls of 25) | Sonnet 4.6 | $3 / $15 | $0.076 | $0.38 |
| **Total** | | | **$0.12** | **$0.61** |

Estimated from call shapes at list rates (answer ≈ 45 tokens), not measured.
Log `response.usage` for a fortnight to replace with real figures.

**~$17 per class per semester. About $0.12 per student for the whole term.**
Hosting is several times that (~$150–250/yr). Ten classes ≈ $170/semester. A
hundred classes is still under $2,000/yr.

Consequence: **do not build usage-based pricing.** Metering would cost more to
build and support than the tokens. The expensive resource is your time.

Free improvement: grading calls `claude-sonnet-4-6` ($3/$15). Sonnet 5 is
$2/$10 — newer and a third cheaper. Worth doing for quality; the ~$7/semester is
irrelevant. Prompt caching is *not* a lever here — the classify prefix is a few
hundred tokens, below the minimum cacheable prefix.

---

## Pricing options

| Model | Shape | Why it works | What it costs you |
|---|---|---|---|
| Open source, self-hosted | Free | Zero liability or procurement. Self-hosters don't email at 9pm. | No revenue; needs deploy docs and the shared-invite-code assumption removed. |
| You eat it, departmentally | Free | Frictionless for the first few colleagues; real feedback. | Untenable past ~3 classes, with no natural moment to start charging. |
| Per instructor, per semester | ~$300–500 | Simple, scales with support burden, no student-facing payment. | Instructors rarely hold budget — so sell to the department directly. |
| Per student, per term | ~$25–45 | The incumbent model; most lucrative. | **Don't.** Drags in the bookstore and refunds, and student-pay is exactly what faculty resent about incumbents. Undercuts the reason to exist. |
| Department / site licence | ~$3–6k/yr | Matches how universities buy. One invoice, one security review. | Long cycles; forces Gate C in full. |

Ranges are directional anchors, not quotes — verify before repeating publicly.

**Recommendation: free and open for self-hosters, plus a hosted departmental
licence.** Keep the core clicker free forever — that's the position that makes
the project worth talking about, and it costs nothing real. Charge a department
for the hosted instance, where money maps onto what's actually scarce: your
attention. Decline per-student pricing explicitly when it comes up.

---

## Order to do it in

Everything worth doing before November is done. What remains, in order:

1. **Run ID in the response uniqueness constraint** — five minutes now, archaeology in two years.
2. **An admin role** — decide which of the three bundled features you actually need before building any of them. "Create an account for someone and hand them a class" is most of a day; a system view that sees every professor's classes is the expensive one, and it is only expensive because it changes what ownership means. That now happens in one file, which is the whole reason this came after the consolidation rather than before it.
3. **A provider behind `captureException()`** — the seam is in and every call site already routes through it, so this is an account, a DSN, and one file. Deferred deliberately, not forgotten.
4. **Restore a backup, once, to a scratch database.**
5. **A scratch database, then the three integration scripts in CI** — they want a Postgres service and a booted backend, and `smoke-themes.ts` spends real tokens, so it needs a decision about a CI key first. The absence of a non-production database is its own small blocker: it is why the socket suite has to be run by hand.
6. **Spend caps and a kill switch** — the gate on anyone else's lecture touching your key.
7. **Redis** — adapter, clocks, theme locks, rate limits, leader election. One project.
8. **Email, then SSO.**
9. **LTI, accessibility, HECVAT, entity** — only once someone has said yes.

---

## What to say when somebody asks

**"Could I use this in my course next semester?"**
Yes, with a caveat up front: it's built for one instructor and hasn't been
tested with two. Give me a semester of hardening and I'd like you to be the
second. Happy to show you the whole thing and let you watch a lecture run on it.

**"Could our department adopt it?"**
Bigger conversation than the code. Departmental adoption means SSO, Canvas grade
passback, an accessibility review, and a security questionnaire — none exotic,
but a few months, and it doesn't make sense to build speculatively. If there's
real appetite, let's talk about what would fund that time.

**"What does it cost to run?"**
Almost nothing, and that's the interesting part. About twelve cents of model
usage per student for a whole semester; a course runs on ~$17 of tokens. The
expensive part was never the AI — it's someone being responsible for it at 8am
on a lecture day.
