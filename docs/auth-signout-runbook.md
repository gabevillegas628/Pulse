# Runbook: a professor gets signed out unexpectedly

The long-running "my session died for no reason" bug. Caught live on 9 Sep 2026, investigated
against production logs for an evening, and **still not root-caused**. Four contributing
defects were fixed in `d7270b8`, and two instruments were added so the next occurrence
diagnoses itself.

Read this before touching any code. Three earlier attempts (`5a9fc9a`, `a8db8a6`, `f6fee8a`)
each fixed a plausible *trigger*, shipped, and did not hold. Do not add a fourth story.

---

## What it looks like

A professor is working normally. Some action that needs auth — an image upload, saving a
question — comes back `Unauthorized`. Since `d7270b8` the "Session expired" prompt should be
visible on top of whatever dialog is open; before that fix it painted underneath.

## Step 0 — do not reload

A reload runs the auth providers' mount effects, finds no token, and redirects to `/login`.
That destroys the live state. In-app clicks only, and don't type a password into the prompt
until the evidence is captured.

## Step 1 — read the instruments first

This is the whole point of `d7270b8`. Both live in the production logs, not the browser.

```bash
railway logs -s "Pulse main" -e production --since 1h --json > plogs.json
grep 'client auth diagnostic' plogs.json    # the watchdog's report: who took the token
grep 'authFailure' plogs.json               # which check refused the request
```

Railway gotchas, each of which cost real time:

- The repo is linked to `Pulse-Dev`. Production is **`Pulse main`** — always pass `-s`.
- `--filter` silently returns nothing. Pull raw and grep locally.
- Logs are scoped per deployment. Use `railway deployment list -s "Pulse main"`, then
  `railway logs <deployment-id>` to reach anything from before the last deploy.
- **Never** run `railway variables` or `railway run` — they print secrets.

## Step 2 — what the beacon says

`POST /api/client-diag` fires when the professor token disappears from localStorage, and names
who took it. This is the question an entire night of log archaeology could not answer, so read
it before forming any theory.

| `byApp` | `byOtherTab` | `canaryLocal` | `canaryIdb` | Conclusion |
|---|---|---|---|---|
| `true` | — | — | — | Our own code. `appStack` has the stack — go straight to that line. |
| `false` | a URL | — | — | Another tab or window did it. The URL names the page. |
| `false` | `null` | `false` | `false` | Profile-wide clear: private-mode teardown, or site data cleared. |
| `false` | `null` | `false` | `true` | localStorage-specific eviction; IndexedDB survived. |
| `false` | `null` | `true` | `true` | **Something removes that one key alone.** Back into the code. |

The report also carries `tokenIat`, `tokenExp` and `ageSec`, recorded when the token was
*written* so they outlive the token itself. This is what finally makes "did it just expire?"
answerable — it was unanswerable on 9 Sep because the token was gone before anyone looked.

**If no beacon arrives at all**, the watchdog never saw the transition: either that tab was
running a build older than `d7270b8`, or `sendBeacon` was blocked. Check whether any
`client auth diagnostic` line exists for that session, including the `boot` event — which
fires only when a canary exists and the token does not.

## Step 3 — what `authFailure` says

Every 401 now carries the specific check that refused it. The client still sees a bare
`Unauthorized`; only the log is specific.

| `authFailure` | Means |
|---|---|
| `no authorization header` | Nothing in storage at request time. This is the disappearance, not its cause — cross-check the beacon. |
| `jwt expired` | Renewal didn't keep up. Compare `tokenIat`/`tokenExp` from the beacon, and grep for `professor token renewal failed`. |
| `jwt invalid` | Signature mismatch: `JWT_SECRET` changed. Confirm its *shape* in the Railway dashboard, never its value. |
| `role is student, not professor` | The student-route token bug regressed — see defect 3 below. |
| `professor row missing` | The row is gone from the database. |
| `professor deactivated` | `deactivatedAt` is set on the account. |

## Step 4 — only if the instruments are silent

In the browser, before reloading anything:

```js
console.log({
  token: !!localStorage.getItem('professor_token'),
  canary: localStorage.getItem('pulse_storage_canary'),
  keys: Object.keys(localStorage),
  origin: location.origin,
  modal: document.body.innerText.includes('Session expired'),
});
```

Then DevTools → Network → the failing request → **is there an `Authorization` header at
all?** That single fact splits "the token is bad" from "the token is gone", and it is the
observation that broke the case open on 9 Sep.

---

## Already ruled out — do not re-derive

Each of these cost real time on 9 Sep. All are settled with evidence:

- **`JWT_SECRET` rotating on deploy** — it is a literal string, confirmed in the dashboard.
- **The deploy invalidating tokens** — the PowerPoint add-in held a pre-deploy token and kept
  working across it.
- **Socket auth failures** — neither `SessionPage.tsx` nor `PresentResultsPage.tsx` touches
  token storage on `connect_error`.
- **`Clear-Site-Data` or a service worker** — neither exists anywhere in the codebase.
- **An origin split** — `www.pulseclassroom.com` 302s to a Porkbun parking domain and never
  serves the app.
- **localStorage not persisting, or being partitioned** — a canary written in one tab was read
  back intact from another, same origin, same profile.
- **The PowerPoint add-in clearing the browser's token** — it runs in Edge WebView2, with
  entirely separate storage.

**`ms` in the request log does not discriminate failure modes.** A role-mismatch 401 and a
no-header 401 both log `ms: 1`. An hour went into inferring from a one-millisecond difference
that turned out to mean nothing. `authFailure` exists precisely so nobody does that again.

## The unresolved contradiction

As of `d7270b8`: no application path deletes the token without a preceding 401, and production
logs show **zero** 401s between `00:59:27Z` and the first failed upload at `01:59:11Z`. One of
those two statements is false, and we do not know which. The beacon is built to say.

## The four defects that were fixed, and why none was the cause

Worth knowing, because each made the bug *harder to see* rather than causing it:

1. **`/` redirected to `/student` unconditionally**, so a signed-in professor opening the bare
   domain landed on the login page with a valid token still in storage. This was the entirety
   of "new tab, new sign in, always" — and it trained a professor to treat re-authenticating
   as routine, which is most of why a real sign-out went unnoticed for an hour.
2. **The session-expired modal rendered at `z-50`**, same as every page dialog and above
   `<Routes>`, so any open dialog painted over it. On 9 Sep the app raised the prompt the
   moment the session died and hid it under an edit-question modal for ninety minutes.
3. **The professor token was sent to student-only routes** via `readAuthToken()` precedence,
   producing a guaranteed 401 on every load with a stale `student_token`. Harmless only
   because React runs child effects first — a scheduling accident, not a design.
4. **`triggerSessionExpired()` deleted the token on a single 401**, with nothing able to
   restore it, turning any transient refusal into a real sign-out.

## Verifying the instruments still work

```bash
cd backend && npx tsx scripts/smoke-diag.ts
```

Asserts what `/api/client-diag` refuses: malformed bodies, unknown event names, oversized
strings, and more than 30 reports a minute. Needs no database and no running server.
