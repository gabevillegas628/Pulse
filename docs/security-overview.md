# Pulse: security overview

A plain-language description of what Pulse stores, who can see it, and how it is protected,
for Rutgers security review. It describes the app as deployed on Rutgers OIT virtual
infrastructure (`deploy/`). Where something is a known gap, it says so, with the plan.

## What Pulse is

A classroom response tool for Biochemistry 395. Students answer questions on their phones
during lecture and in take-home assignments; the instructor sees responses live, can group
them into themes, and grades. A quiz-grading module reads scanned paper quizzes so the
instructor can grade them faster. Pulse has one instructor and roughly 100–300 students a term.

## Data it stores

| Data | Sensitivity | Where |
|---|---|---|
| Student NetID and Rutgers email | FERPA (identifies the student) | PostgreSQL |
| Student password hash (bcrypt) | Credential | PostgreSQL. Removed once NetID sign-in (CAS) replaces passwords |
| Answers, scores, AI-suggested scores and their reasons | FERPA education records | PostgreSQL |
| Class enrolment and section | FERPA | PostgreSQL |
| Scanned paper quizzes (page images, answer-box crops) | FERPA; pages include the handwritten name | Files on the VM, outside the web root |
| Instructor name, email, password hash | Staff | PostgreSQL |
| Question text and images the instructor uploads | Course material, not student data | Files on the VM |

Pulse stores no student names, no RUIDs, no SSNs, no financial or health data.

## Where it runs

One Rutgers OIT VM (RHEL 9, EI Managed, NetBackup), set up like other OIT-hosted services:
OIT's Apache handles HTTPS, and a service account runs the app as four containers under
rootless Podman:

```
Internet ─▶ campus proxy ─443─▶ OIT Apache (HTTPS) ─localhost─▶ Pulse app ─private network─▶ PostgreSQL
                                                                    ├─────────────────────▶ Vision (scan processing)
                                                                    └─────────────────────▶ Indigo (chemical structures)
```

- Only OIT's Apache accepts connections from outside, on 443 (and 80, which redirects to 443).
- The app listens on localhost only. The database, vision and Indigo services have no ports
  reachable from outside the VM.
- Containers run without root on the host (rootless Podman), and the app runs as a
  non-root user inside its container. SELinux stays enforcing.
- OIT patches the operating system (EI Managed).

## Signing in, and who can see what

**Today:** students register with a NetID, a Rutgers email and a password. Instructors
register only with an invite code set on the server. Passwords are hashed with bcrypt.
Sign-in issues a signed token (JWT, 24-hour lifetime; instructor tokens renew while in use).
Failed logins are throttled per account.

**Planned:** Rutgers CAS (NetID) sign-in, which replaces Pulse passwords and the reset flow,
and proves the student owns the NetID (see Known gaps).

| Role | Can see and do |
|---|---|
| Student | Answer open questions; see their own answers and scores |
| Instructor | Their own classes only: rosters, answers, grading, quiz scans |
| Admin (an instructor flag) | Manage instructor accounts and student accounts under `/api/admin` |

- Every instructor query is scoped to classes that instructor created, through one shared
  set of ownership checks (`backend/src/utils/ownership.ts`), not ad-hoc filters per route.
- A deactivated instructor's existing tokens stop working on the next request: the account
  is re-checked on every request.
- Live updates (Socket.io) require a valid sign-in token. The instructor's live feed, which
  carries NetIDs and answers as they arrive, is joined only after checking the session is
  that instructor's.
- Quiz scans are served only through instructor-authenticated routes that check ownership;
  the scan folder is blocked on the public file route.

## In transit and at rest

- **In transit:** HTTPS only (TLS from OIT's Apache with an InCommon certificate).
  HSTS is set. Inside the VM, traffic between containers stays on a private network.
- **At rest:** the database and scans are on the VM's disk. Encryption at rest is whatever
  OIT's VI storage provides; Pulse adds none of its own. *Question for OIT.*
- **Browser hardening:** a Content Security Policy, frame restrictions and other standard
  headers (helmet). Rate limits on login and the structure service.

## Backups

- Nightly `pg_dump` of the database to the VM's disk (last 14 days, plus one per month),
  checked to be readable before it is kept. Files are readable by the service account only.
- OIT NetBackup copies the VM, including those dumps and the scans.
- Restore procedure: `deploy/README.md` § 4.

## Outside services

| Service | What it receives | Why |
|---|---|---|
| AI model: Google Gemini on Vertex AI (Rutgers project), or Anthropic Claude until then | Answer **text** with no names or IDs; crops of single answer boxes from quizzes | Group answers into themes, suggest scores, read handwriting |
| Brevo (email) | A student's email address and a reset link | Password reset. Removed when CAS replaces passwords |
| GitHub | Nothing about students | Course textbook pages; code |

### What the AI sees, and what it does not

- **Answers only, by number.** Answers go to the model as a numbered list. Which student
  wrote which answer stays on the server.
- **Scrubbed first.** Before any answer leaves the server, NetIDs and emails of everyone in
  the class, any email address, names spelled out by `first.last` emails, nine-digit ID
  numbers and phone numbers are replaced with placeholders (`backend/src/ai/scrub.ts`).
- **Quiz scans: one answer box at a time.** Only crops of single answer blanks are sent.
  Name and NetID boxes are never sent: the code refuses them, and refuses any quiz layout
  where an answer box overlaps the name box.
- **The model reads; the instructor decides.** For quizzes, the model only transcribes and
  answers yes/no questions; scores come from the instructor's answer key in code, and every
  automated verdict can be overridden, with overrides logged. For free-text answers the AI
  suggests a score with a reason, and the instructor can change any of them.
- Which provider is used is a server setting (`AI_PROVIDER`). The intent is Gemini on the
  Vertex AI project Rutgers' Google agreement covers.

## Logging

- Requests are logged only when they fail or are slow: method, path (no query string),
  status, timing, and the NetID or instructor id of whoever made it. Answer text is not logged.
- Logs stay on the VM (container logs).

## Retention and deletion

- Removing a student from a class keeps their answers (so a mistaken removal can be undone).
- Deactivating an instructor keeps their classes, deliberately: deleting would take a
  semester of records with it.
- **No retention period is enforced yet.** See Known gaps.

## Known gaps, and the plan

| Gap | Risk | Plan |
|---|---|---|
| Students type their own NetID at sign-up; nothing checks they own it | One student could register as another | Rutgers CAS sign-in. Requested from OIT |
| Sign-in token kept in browser storage (`localStorage`), not an httpOnly cookie | A script injected into the page could read it | Move to httpOnly cookies (`docs/production-hardening.md` § 6). The strict CSP limits the exposure meanwhile |
| CSP allows `unsafe-eval` | Weakens script-injection protection | Required by the molecule editor (Ketcher); waiting on an upstream fix (`docs/security-findings.md` #2) |
| No enforced retention period | Records kept indefinitely | Adopt Rutgers' retention period for course records and add a scheduled clean-up |
| Password reset email goes through Brevo | Student email addresses to a third party | Remove with CAS, or switch to a Rutgers mail relay |
| Encryption at rest depends on VM storage | — | Confirm with OIT |

## Earlier review work

- `docs/security-findings.md`: a code security review. Critical and high findings fixed
  (June 2026): the structure-service proxy now requires sign-in and is rate-limited;
  textbook HTML is sanitised; inline scripts are blocked; the JWT secret has no insecure
  default in production. One item accepted as a risk, one waiting upstream.
- `docs/production-hardening.md`: login throttling, socket authentication, graceful
  shutdown, AI grading reliability.

## Contact

Course instructor, Biochemistry 395 (owner and maintainer).
