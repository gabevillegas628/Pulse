# Production Hardening Plan

Addressing security and reliability gaps before Pulse is used by anyone beyond the original author.
UX improvements, bug fixes, and feature work are out of scope here.

---

## Status Legend
- [ ] Pending
- [~] In progress
- [x] Done

---

## 1. Rate Limiting on Auth Endpoints ✅
- [x] Rate limit professor + student login (10 req / 15 min per IP, 429 with Retry-After)
- [ ] Rate limit professor register (invite code brute-force) — low priority, deferred

---

## 2. Socket.io Authentication ✅
- [x] Require JWT on connection handshake; disconnect unauthenticated sockets
- [x] Split session rooms: `new_response` → professor-only room; `run_status` → everyone
- [x] Frontend passes token in `auth: { token }` on all three socket pages

---

## 3. Graceful Shutdown ✅
- [x] SIGTERM/SIGINT handlers — stops accepting connections, drains in-flight requests, closes socket.io + Prisma before exit

---

## 4. AI Grading Reliability ✅
- [x] Batch grading (25 responses per Claude call) — scales to 200+, better quality per batch
- [x] Async session grading — 202 immediately, progress via `grade_progress` / `grade_complete` socket events
- [x] Failed batches skipped and counted, not abort-everything
- [x] Progress bar + success/error banner in SessionPage
- [x] Two-button UI: "Grade all with AI" (re-grades) and "Grade ungraded (N)" (retry failures / new responses)
- [x] AssignmentDetailPage: same two-button UI + banner; sync batched (no socket progress bar yet)
- [x] dotenv/config loaded at startup — fixes env vars in local dev (Railway unaffected)

---

## 5. GitHub API Rate Limits ✅
- [x] `GITHUB_TOKEN` in config, passed as `Authorization: Bearer` on all textbook GitHub fetches
- [x] Raises limit from 60 → 5,000 req/hr; gracefully omitted if token not set
- [ ] Add `GITHUB_TOKEN` to Railway env vars (manual step)

---

## 6. Token Security (localStorage → httpOnly Cookies)
**Status:** Deferred — revisit before any public launch.

**Risk:** JWTs in localStorage are readable by any JS on the page (XSS). No revocation — stolen token works for its full 24-hour lifetime.

**When addressed:**
- Switch to httpOnly, Secure, SameSite=Strict cookies
- Token versioning in DB (increment on logout to invalidate)
- Update all frontend auth logic and axios client

---

## Out of Scope
- Soft deletes — accidental deletion risk mitigated by confirmation dialogs in UI
- Audit logs
- ~~Database backups (Railway handles this)~~ — no longer out of scope, and the
  parenthetical was the wrong reason: Railway's backups live in the account they
  protect and nobody had restored one. See `BACKUP_AND_RESTORE.md`.
- CORS in production — non-issue, frontend served from same Express server
- `unsafe-eval` in CSP — required by Ketcher, acceptable tradeoff
