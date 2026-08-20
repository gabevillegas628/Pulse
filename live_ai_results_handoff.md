# Live AI Results — Handoff

## What This Is

A design brief for putting **live AI categorisation of free-text answers on the slide**, in front
of the room, as answers arrive. Nothing here is built yet. Everything it depends on is.

## Why

Pulse is being presented at a **GenAI talk around October 2026**. The audience is AI-literate, so
the interesting thing to show is the *mechanism*, not just a number going up. Today both AI
features — grading and summarising — are batch operations behind a button press. Nothing about
them is live, and nothing about them reaches the projector.

The stage for this already exists: a PowerPoint **content add-in** that renders during a slide
show. So the missing piece is genuinely just the AI half.

---

## The Stage (already built — read this before designing)

**`/present`** — a React route rendered inside a content add-in placed on a slide. It is the only
Pulse surface visible while presenting; the task pane and the whole PowerPoint editing chrome are
hidden during a show.

- `frontend/src/pages/present/PresentResultsPage.tsx` — the page
- `GET /api/addin/live` in `backend/src/routes/addin.routes.ts` — returns the professor's
  currently-open session, its questions, and `activeQuestionId`

**It needs no configuration.** Rather than being bound to a question, it displays whichever
question is *currently receiving answers*. The students' scans are what say where the lecture is.
Any new live feature should inherit that property — no mid-lecture setup step, ever. That is the
whole product thesis (see `classroom_response_tool_handoff.md`).

**Data flow:** initial fetch, then socket `new_response` for answers and `run_status` for a
session opening/closing, plus a 1s heartbeat that re-polls every 5–6s as a safety net.

**Aggregate only, enforced server-side.** `/api/addin/live` strips student identity from the
payload entirely — no `netId`, no `studentId`, no `student` object. This is projected in a lecture
hall, so a rendering bug must not be able to expose who said what. Three assertions in
`backend/scripts/e2e-qr.ts` guard it. **Any new endpoint feeding `/present` must do the same.**

---

## What AI Exists Today

Both in `backend/src/routes/grading.routes.ts`, both `claude-sonnet-4-6`, both button-press:

| Feature | Route | Notes |
|---|---|---|
| Summarise | `POST /sessions/:sessionId/questions/:questionId/summarize` | Returns `SummaryCategory[]` — `{label, description, count}` (`shared/src/index.ts`) |
| AI grade | `POST /sessions/:sessionId/questions/:questionId/grade` | `mode: all \| ungraded` |

**Reuse the grading pattern, don't invent one.** `gradeQuestionAsync` already does exactly the
shape this feature needs: work in batches of `BATCH_SIZE = 25`, emit `grade_progress` per batch
over the socket, then `grade_complete`. Live categorisation is the same pattern with a different
prompt and a different event name.

---

## Why Free-Text Themes Aren't On The Projector Yet

Considered during the live-results build and deliberately deferred, for two reasons. **Only one
still holds.**

1. **Summaries are not persisted.** `summary` is component state in
   `frontend/src/pages/professor/SessionPage.tsx`. The projected page cannot read it. *Still true
   — this is the prerequisite for anything live.*
2. **Auto-triggering AI mid-lecture is unpredictable in cost and latency.** *Still a fair concern
   for ordinary teaching, much less so for a demo.* Points at opt-in or debounced rather than
   always-on — not at skipping the feature.

Consequently free text currently projects as counts only: total responses, flagged-as-short
count, average word count (the `FREE_TEXT` branch of `frontend/src/components/ResultsSummary.tsx`,
which is already aggregate-safe).

---

## The Design Fork

**A — Re-summarise on a debounce.** Every N seconds or M new answers, re-run the existing
summarize call and push the result. Cheapest to build; reuses what is there. But the categories
are regenerated from scratch each time, so labels and ordering churn — on a projector this reads
as flickering, not insight.

**B — Bootstrap then classify incrementally.** Derive categories once from the first handful of
answers, then assign each subsequent answer to an existing category as it lands. Occasionally
re-cluster if enough answers fit nothing.

**Recommend B.** Bars grow smoothly and monotonically in front of the room — a histogram of
understanding assembling itself, which is the actual demo. It is also more honest to an
AI-literate audience, because the mechanism is legible: bootstrap, classify, re-cluster. A is a
black box that reshuffles.

---

## What Building B Requires

1. **Persist categories.** New table keyed to the question — the existing `SummaryCategory` shape
   is a reasonable starting point, minus `count` (derive that).
2. **Persist per-response assignment.** A category reference on `Response`, or a join table.
   `count` then falls out of a group-by and never goes stale.
3. **A classify step on arrival.** Hook where responses are created
   (`POST /api/responses`, `backend/src/routes/responses.routes.ts`), or a debounced worker
   draining unclassified responses in batches — the latter reuses the grading pattern and avoids
   putting an API call on the student's submit path. **Prefer the worker**; a student should never
   wait on an LLM to see their answer accepted.
4. **A socket event** (`categories_updated` or similar) so `/present` updates without polling.
5. **Extend `/api/addin/live`** to include categories and counts — still with no student identity.
6. **Render it** — a bar list on `/present`. `ThemesBody` in
   `frontend/src/components/LiveMonitorPanel.tsx` is aggregate-safe and close to what is wanted.
   **Do not reuse `WallBody`** from that file: it renders netIDs and raw response text.

### Model and API notes

- Current code uses `claude-sonnet-4-6` ($3/$15 per MTok). Per-response classification is a
  high-volume, short-output call, so **whether to use a cheaper model for it is a live decision** —
  `claude-haiku-4-5` exists at $1/$5, 200K context. Gabe's call, not an automatic downgrade.
- **Use structured outputs** (`output_config: {format: {...}}`) to constrain the classifier to one
  of the known category ids. This is the single highest-value reliability win here; free-text
  category names from an LLM will drift otherwise.
- **Prompt caching** may fit the bootstrap-then-classify shape (stable prefix = question text +
  category definitions). Verify with `usage.cache_read_input_tokens`; note the minimum cacheable
  prefix is ~1024 tokens, which short category lists may not reach.
- Batches API is 50% cheaper but asynchronous — **not** suitable for the live path.

---

## Constraints That Will Bite

These cost real time during the live-results build. All are documented in `addin/README.md`.

- **`flushSync` is mandatory.** React does not reliably commit in an unfocused add-in frame. Any
  state update arriving from a socket or timer must be wrapped, or the UI silently stops updating
  until someone clicks the object. CSS animations keep running, so it *looks* alive.
- **Long timers get throttled** in a backgrounded frame; short intervals keep firing.
- **`/present` needs the add-in CSP** (`backend/src/app.ts`) — the Office CDN in `script-src` and
  relaxed frame-ancestors. Under the app-wide policy, `office.js` is blocked and the page renders
  as dead HTML with no error.
- **Office.js cannot report the displayed slide during a show.** Any design that wants to know
  which slide is up is dead on arrival.
- **Not supported in PowerPoint Live (Teams)** — remote/hybrid sessions lose the in-slide view.

---

## Open Questions

1. **Teaching feature, or demo feature?** This determines how much the failure modes matter. If it
   is meant to survive real lectures, "the AI miscategorised an answer in front of 30 students"
   needs an answer — probably a professor override, and category labels conservative enough to be
   defensible. My read: build it as a teaching feature, because one that only survives a rehearsed
   demo tends to embarrass you live.
2. **Who triggers it?** Fully automatic once N answers arrive, or an explicit "start categorising"
   from the session page? Automatic demos better; explicit is kinder to the API bill.
3. **What happens to the existing summarize button?** Does it become the bootstrap step for this,
   or stay separate?
4. **Should categories persist across runs of the same session?** Re-teaching the same lecture next
   year with last year's categories is either a nice continuity feature or a subtle bias problem.

---

## Verification

- `npm run test:e2e:qr` (needs a running server) must stay green — currently **50 assertions**.
  Add live-categorisation assertions to it, especially **payload-carries-no-identity** checks
  mirroring the existing three.
- End to end: open a session, project a deck with the results object, answer from several phones,
  confirm categories appear and bars grow **without leaving the slide show**.
- Pull the network mid-show: must degrade to a readable status line and keep the last known
  counts, never a blank projector.
