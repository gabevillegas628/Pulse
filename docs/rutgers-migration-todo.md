# Rutgers migration: to-do

Moving Pulse onto Rutgers infrastructure so student records stay under Rutgers policy.
Deployment setup: `deploy/README.md`. AI provider switch: `backend/src/ai/llm.ts`.
Security overview for review: `docs/security-overview.md`.

**Plan:** finish this term on Railway. Set the Rutgers VM up **as new** (empty database, no
student data carried over), test it at leisure, and start spring on it. Shut Railway down over
winter break. Portkey and NetID sign-in come after the VM is running. No new features until
then.

**Order:** provisioning meeting → VM ready → install rehearsal and fresh install → winter break
shutdown of Railway → spring class on the VM.

## Now (quick hardening of the current setup)

- [ ] Two-factor login on Railway, GitHub, Anthropic and Cloudflare.
- [ ] Check the Railway Postgres has no public proxy address; remove it if nothing needs it,
      and rotate the database password if it was ever pasted anywhere.
- [ ] Rotate the Anthropic API key and set a spending limit on it.
- [ ] Put the answer scrub (`backend/src/ai/scrub.ts`) into production.
- [ ] Hold off uploading new real quiz scans until the app is on the Rutgers VM.

## UOES meeting (emergent technologies group)

- [ ] What can be sent to a model: is de-identified student work (scrubbed answer text,
      single answer-box images) OK?
- [ ] Is **Portkey** approved for that? Which Claude models are enabled, and does it pass
      through structured outputs, images and the effort setting?
- [ ] Does Rutgers' Google agreement cover the Gemini API on Vertex AI (fallback route)?
- [ ] Who handles registering an app for NetID (CAS) sign-in?
- [ ] If asked what runs today: "an outside cloud host with my own Claude API key; I'm moving
      it onto an OIT VM and a sanctioned AI provider."

## AI access: Rutgers Portkey (first choice, after the VM is running)

Portkey is Rutgers' AI gateway (KB0019477): Claude and other providers under Rutgers'
enterprise agreements, no training on inputs. Access goes through departmental IT; usage is
billed to the department monthly.

- [ ] Ask DLS IT to submit the Portkey Workspace Request form. Purpose: course app for
      Biochemistry 395; models: Claude (Haiku, Sonnet, Opus).
- [ ] Find out who in the department approves the billing.
- [ ] Monthly spending limit: start at **$50** (estimate $20–60/month for ~300 students).
      Optionally pull exact figures from Pulse's usage records first.
- [ ] Once there is a key: add Portkey support in `backend/src/ai/llm.ts` (point the
      Anthropic client at Rutgers' Portkey gateway, send the Portkey key), then test
      structured outputs, images and effort through it.
- [ ] Add the Portkey gateway host to the VM's outbound firewall rules; drop
      `api.anthropic.com`.
- [ ] Update `docs/security-overview.md` to say AI calls go through Rutgers' Portkey.

## Gemini on Vertex AI (fallback, only if Portkey does not work out)

- [ ] Put the Vertex key in `deploy/secrets/gcp-key.json` (`podman unshare chown 1000:1000`,
      `chmod 600`); set `AI_PROVIDER=gemini` and `GOOGLE_CLOUD_PROJECT`.
- [ ] Confirm the default model IDs in `ROLES` against the live Vertex model list.
- [ ] Measure accuracy before grading real quizzes: `quiz-grader-spike.ts` with
      `AI_PROVIDER=gemini` on the Phase 0 pages; compare with the Claude baseline (enzymes 96.5%,
      cofactors 92.7%). Retune prompts if hand-drawn structures fall behind.
- [ ] Spot-check live themes and response grading on Gemini (`scripts/rehearse.ts`).
- [ ] Add Gemini prices to `backend/src/quizGrader/pricing.ts`.

Either way: use real student data with an AI provider only after Rutgers approves that route.

## OIT: VM request (VI Intake Form)

- [ ] Submit the VI Intake Form: project scope and network description as drafted; Network
      type **Restricted**; existing host `NA`; load balancing No.
- [ ] Server inventory: `pulse01`, **M1.Medium** (2 vCPU / 8 GB), **RHEL 9** (not 8: DSAP's
      RHEL 8 has podman-compose 1.0.6, untested here), one `/` partition of ~150 GB (as on
      DSAP); **EI Managed**; **NetBackup: Yes**.
- [ ] Network communication rows:
  - inbound from the Internet: 443, 80
  - inbound from the Rutgers VPN / campus: SSH 22
  - outbound 443 to: Docker Hub (`registry-1.docker.io`, `auth.docker.io`,
    `production.cloudflare.docker.com`), `registry.npmjs.org`, `binaries.prisma.sh`,
    `pypi.org`, `files.pythonhosted.org`, `github.com`, `api.github.com`,
    the Rutgers mail relay (SMTP)
  - outbound 443 for AI: Rutgers' Portkey gateway (host to be confirmed); Gemini fallback
    `aiplatform.googleapis.com` and `oauth2.googleapis.com`; `api.anthropic.com` only until
    Portkey is in place
  - outbound 22 to `github.com`, if the VM clones over SSH with a deploy key
- [ ] Ask for a public IP and a DNS name (e.g. `pulse.dls.rutgers.edu`; DLS may own that zone),
      and an InCommon certificate as for DSAP.
- [ ] Send `deploy/OIT-REQUEST.md` with the VM request, with `deploy/apache/pulse.conf`
      attached (a one-page list of what the VM needs; no "copy DSAP"). It covers: `podman`, `podman-compose`, `git`, `httpd` + `mod_ssl`; a regular (not
      `--system`) `pulse` user with home `/srv/pulse`; linger; the Apache vhost
      `deploy/apache/pulse.conf` with an InCommon certificate (+ `httpd_can_network_connect`
      if SELinux is enforcing); firewall; `sudo -iu pulse`; NetBackup of `/srv/pulse`;
      public IP + DNS; campus proxy in `trusted-proxy.lst`.

## Questions for OIT / Registrar

- [ ] Is Docker or Podman allowed on an EI Managed VM, and will I have sudo?
- [ ] Is VM storage encrypted at rest?
- [ ] Does Rutgers' AI-use policy go beyond FERPA for anonymised answer text?
- [ ] Rutgers SMTP relay details (host, port, auth), a sender address with SPF/DKIM so mail
      isn't marked as spam, and any sending limits. Asked in `deploy/OIT-REQUEST.md`.
- [ ] When does NetBackup run, and how long are backups kept?
- [ ] What retention period applies to course records (responses, scores, scans)?
- [ ] Is there a security review or questionnaire for the VM/app? (Answers are in
      `docs/security-overview.md`.)

## NetID sign-in: CAS (after the VM is running)

Rutgers' SSO decision chart: a web application, hosted internally, that supports CAS → **CAS**,
no special permission needed. (Hosted externally, CAS would need special permission; Shibboleth
is mainly for apps that can't use CAS.)


- [ ] Ask OIT to register the app with CAS: service URL
      `https://<pulse hostname>/api/auth/cas/callback`; attributes: NetID, plus email and
      name if they can be released.
- [ ] Register the service with **both** test and production CAS (KB0017659, "CAS Local
      Implementation"). Rutgers runs CAS 6.5 with Kerberos + Duo, so Duo comes for free.
- [ ] Build the CAS routes behind a setting, against `test-cas.rutgers.edu` first:
      login `/login`, validation `/p3/serviceValidate` (CAS protocol 3, which can return
      attributes such as email and name if released), sign-out `/logout`. Then switch the
      setting to `cas.rutgers.edu`.
- [ ] Outbound 443 to `cas.rutgers.edu` and `test-cas.rutgers.edu` (already in
      `deploy/OIT-REQUEST.md`).
- [ ] Then remove Pulse passwords and the reset flow. Email stays (see "Email").

## Real roster (backlog, after CAS)

CAS proves who someone is, not that they are in the course: any Rutgers NetID could sign in
and, with a join code passed around, end up on a class roster. Join codes are the only gate
today. Pulse needs to check people against the real class list.

- [ ] Decide the source. CAS releases only the NetID without extra approval, so course
      enrolment from CAS is unlikely. More practical:
  - **Roster CSV upload** per class (e.g. the Canvas or registrar export: NetID, and section
    if present). Simplest, and the quiz grader already wants one (`docs/quiz-grader/
    OPEN_QUESTIONS.md` #4), so one import can serve both.
  - Later, Canvas (its API or LTI), so the roster stays current on its own.
- [ ] Decide what happens to a NetID that is not on the roster: refused outright, or held for
      the instructor to approve (add/drop week, auditors, TAs).
- [ ] Re-uploading the roster updates it: new students allowed in, dropped students flagged
      for the instructor rather than silently deleted (their answers are course records).
- [ ] Sections from the roster can replace students choosing their own section.

## Install (once the VM is ready)

- [x] Rehearse the install on RHEL with rootless Podman (Rocky Linux 9.9, Podman 5.8), and the
      Apache vhost with RHEL's httpd. Findings are in `deploy/README.md` § 1 (what OIT sets up)
      and § 2 (steps after delivery).
- [ ] Deploy key for the repo (read-only), then clone as `pulse`.
- [ ] Follow `deploy/README.md` § 2; fresh, empty database. No student data from Railway.
- [ ] `podman login docker.io` if pulls hit the rate limit.
- [ ] Practise a restore into a scratch database.
- [ ] Move `pulse-backup.timer` if NetBackup runs before 2am Eastern.
- [ ] Recreate course content (questions, assignments) by hand; import quiz keys and layouts
      from their YAML exports. Optional: a content-only export script that refuses student data.
- [ ] Re-install the PowerPoint add-in from the new address (its manifest uses the server URL),
      and regenerate any QR codes pasted into slides as images.
- [ ] Spring: create the class on the VM and give students the new address.

## Retire the old setup (winter break)

- [ ] Final grades in Canvas (the official record).
- [ ] Export quiz keys and layouts (YAML) and anything else needed to rebuild the course.
- [ ] Take one last encrypted backup and store it on Rutgers-approved storage (Rutgers OneDrive
      or Box). Keep it until a retention period is given, then delete it.
- [ ] Then shut down Railway, the Cloudflare R2 backups and the GitHub Actions backup
      workflow, deliberately rather than in a hurry.
- [ ] Remove Brevo once the app sends through the Rutgers relay (see "Email").
- [ ] Delete the old `ccr-c2f95155-dbras2` branch on GitHub (same commits as
      `rutgers-migration`).

## Server management (after it's running)

- [ ] Run it for a few weeks first and note what you repeat by hand.
- [ ] Then a small `pulse` command-line tool on the VM, used over SSH (not a web panel):
      `status` (containers, health, disk, last backup and its age), `deploy`, `backup`,
      `restore` (with a confirmation step), `logs <service>`.
- [ ] Optional: a read-only "last backup" line on Pulse's admin page. Nothing that can
      trigger deploys or restores from the web.

## Email (Rutgers relay instead of Brevo)

Email outlives passwords: CAS removes the reset flow, but announcements (a later feature) and
other notices still need to send.

- [ ] Get the relay details from OIT (requested in `deploy/OIT-REQUEST.md`).
- [ ] Add an SMTP sender behind the existing `sendEmail()` seam
      (`backend/src/services/email.service.ts`), chosen by setting, with Brevo kept until the
      relay is confirmed working. Send a test message to a Rutgers and an outside address.
- [ ] Remove Brevo (`BREVO_API_KEY`, the outbound host) once the relay works.
- [ ] Later, with announcements: send a class in batches within the relay's limits, and give
      students a way to opt out of non-essential mail.

## Study guides (backlog, after it's running)

Today the Study Guides tab (`backend/src/routes/textbook.routes.ts`) fetches Markdown files
from a GitHub repository set per class (`textbookRepo`, `textbookPath`, `textbookBranch`) and
renders them. Neither the format nor GitHub is required.

- [ ] Host the study guides on the server itself (e.g. a folder in the uploads volume, managed
      from the class page) instead of a GitHub repository. Removes the GitHub dependency
      (`api.github.com`, `GITHUB_TOKEN`) and keeps course material on Rutgers infrastructure.
- [ ] Accept formats other than Markdown (e.g. HTML, PDF, Word), so guides can be written in
      whatever tool is convenient. Keep the current sanitising for anything rendered as HTML.
- [ ] Keep what the GitHub version does today: chapter list, in-guide search, images, and
      the per-student view tracking (`TextbookView`).

## Code follow-ups

- [x] Strip NetIDs, emails, email-derived full names, ID and phone numbers from answer text
      before any AI call (`backend/src/ai/scrub.ts`).
- [x] Security overview for review (`docs/security-overview.md`).
- [ ] Write the retention policy down, and add something that enforces it.
- [ ] Move sign-in tokens from `localStorage` to httpOnly cookies.
- [ ] A scan over the app's 300 MB limit gets a generic 500 error; return 413 "file too large"
      instead (multer's LIMIT_FILE_SIZE).
- [ ] Root `docker-compose.yml` (dev) points at `epam/indigo-service`, which no longer exists;
      switch it to `epmlsop/indigo-service:1.47.0` like `deploy/compose.yaml`.
