# Rutgers migration: to-do

Moving Pulse onto Rutgers infrastructure so student records stay under Rutgers policy.
Deployment setup: `deploy/README.md`. AI provider switch: `backend/src/ai/llm.ts`.
Security overview for review: `docs/security-overview.md`.

**Plan:** finish this term on Railway. Set the Rutgers VM up **as new** (empty database, no
student data carried over), test it at leisure, and start spring on it. Shut Railway down over
winter break. Portkey and NetID sign-in come after the VM is running. No new features until
then.

**Order of this list:** now → the VM → install → winter break → after it's running (AI, CAS,
email) → quiz grader fix (before spring quizzes) → feature ideas → code follow-ups.

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

## Email (Rutgers relay instead of Brevo)

Email outlives passwords: CAS removes the reset flow, but announcements (a later feature) and
other notices still need to send.

- [ ] Get the relay details from OIT (requested in `deploy/OIT-REQUEST.md`).
- [ ] Add an SMTP sender behind the existing `sendEmail()` seam
      (`backend/src/services/email.service.ts`), chosen by setting, with Brevo kept until the
      relay is confirmed working. Send a test message to a Rutgers and an outside address.
- [ ] Remove Brevo (`BREVO_API_KEY`, the outbound host) once the relay works.
- [ ] Announcements depend on this (see "Feature ideas").

## Quiz grader: answers read as blank (fix before next semester's quizzes)

Written answers are coming back "read as empty" and scoring 0, often (seen on cofactors such as
NAD+/NADH and FAD/FADH2, and on intermediate names such as Citrate, Oxaloacetate, Isocitrate).

**What is known** (from the code, `backend/src/quizGrader/grade.ts` and `reader.ts`):

- "Read as empty" means the **text model** (Haiku 5.5, `effort: low`) answered "blank". The
  vision service's ink check had found writing, or the box would not have been sent
  ("empty (not sent)" is the ink check's label). So the miss is in the model reading, not
  the cropping.
- **A blank first reading always scores 0.** The second look (Sonnet) often reads it
  correctly (s6: "S-CoA → in, CoASH → out"; s7: "FAD → in, FADH2 → out") but only adds a
  review note; the score stays 0 until someone clicks.
- **Intermediate names get neither a second look nor a flag when read blank** (by design:
  their boxes hold the drawing, so they nearly always have ink). So a missed name is a
  **silent 0**.

**Likely causes, to test:**

1. All of a page's text boxes go to the model in **one request**, with a fast model at low
   effort; it skips some.
2. The prompt says to **ignore "printed labels"**: neat block handwriting, common on these
   papers, may be taken for printing.
3. Name boxes overlap the drawings, and the prompt says the name is "not the drawn
   structure"; the model may skip the whole box.
4. Haiku is simply weaker at this than Sonnet.

**Decided: these get implemented.** A blank reading of a box with writing is not acceptable.
After the migration, implement in this order, then test on this semester's quizzes. The main
fix is the stronger reader (step 2); the safety net (step 1) stays regardless, since no model
is perfect.

*1. Scoring safety net* (no model calls; protects every quiz, including ones already printed):

- [ ] **Never a silent 0 on a box with ink.** Every slot read as blank where the ink check found
      writing gets a second look, **intermediate names included** (today they get none).
- [ ] When the first reading is blank and the second look reads an answer, **score from the
      second reading** and flag it "first reader missed this" for confirmation, instead of
      scoring 0 and waiting for a click.
- [ ] When both readers say blank but there is ink, flag it (unless the ink is known to be a
      neighbouring slot's, e.g. the enzyme name in a shared cofactor box).
- [ ] Tests in `smoke-quiz-grader.ts` for each case, so it cannot regress.

*2. Stronger readers for handwriting* (decided: Haiku is not used for reading handwriting):

- [ ] First text reading: **Sonnet** instead of Haiku (`quiz.text` in `backend/src/ai/llm.ts`
      `ROLES`, and `MODEL_TEXT`). On the same boxes Sonnet read what Haiku called blank. A
      miss is a wrong grade, so a few cents a page is worth it.
- [ ] Text second look: **Opus** instead of Sonnet (`quiz.secondLook`), so the double-check
      stays a different, stronger reader, as drawings already do (Sonnet, then Opus).
- [ ] Haiku stays only where it fits: live themes (sorting short typed answers in class).
- [ ] Optional tuning, if blanks still appear after the switch: one box per request instead of
      a whole page in one request; a prompt that drops "ignore printed labels" (say the
      printed form contains no handwriting, so anything handwritten counts) and, for names,
      doesn't make the model skip the whole box.
- [ ] Update `quizGrader/pricing.ts` and the cost note in `PRODUCT_READINESS.md`.

*3. Form change for spring* (data, not code: a new layout version, since printed pages are
permanent):

- [ ] A separate, drawn **name box** beside each structure, so a name box with ink means a name
      was written and can be flagged like the enzyme boxes.
- [ ] Optional: labelled "in" and "out" spots for cofactors instead of the two ends of a curved
      arrow, to remove side guessing.

*Testing* (after the migration and steps 1–2, on the Rutgers VM through an approved AI route):

- [ ] Count, per slot type, first readings that were blank where the box had ink, before and
      after (a script on the server; nothing leaves it).
- [ ] Re-grade this semester's quizzes with `quiz-grader-spike.ts` against the hand grades:
      first with Sonnet/Opus, then with any optional tuning one change at a time. Target: no
      blank readings of boxes with writing.

## Feature ideas (after the migration)

Not started; noted so they aren't lost. Nothing here until the VM is running. Rough order of
usefulness, not commitment.

### Announcements

- [ ] Instructor writes a message; it goes to a class or a section by email (and could also
      show in Pulse). Depends on the Rutgers mail relay (see "Email").
- [ ] Send in batches within the relay's limits, and give students a way to opt out of
      non-essential mail.

### Exam management

- [ ] Scanning, grading and review for exams, building on the quiz grader (scans, layouts,
      answer keys, review by item). Likely needs: longer multi-page papers, free-response
      questions with rubrics, exam versions, and grade export.

### Student requests

- [ ] Students submit a request in Pulse (e.g. exam rescheduling), the instructor approves or
      declines, and every decision is recorded. Could fold in what exists already: deadline
      extensions (`DeadlineExtension`) and quiz excusals (`QuizExcusal`).
- [ ] Avoid collecting medical or other sensitive documentation in Pulse; point students to
      the dean's office for that.

### Study guides: any format, hosted on the server

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

### Server management tool

- [ ] Run it for a few weeks first and note what you repeat by hand.
- [ ] Then a small `pulse` command-line tool on the VM, used over SSH (not a web panel):
      `status` (containers, health, disk, last backup and its age), `deploy`, `backup`,
      `restore` (with a confirmation step), `logs <service>`.
- [ ] Optional: a read-only "last backup" line on Pulse's admin page. Nothing that can
      trigger deploys or restores from the web.

### Real roster (optional, low priority, after CAS)

Probably fine as is. CAS proves who someone is, and joining a class already needs a code the
instructor hands out (the QR or access code in class, or a class/section join code), so a
NetID alone gets nobody in. What remains is a leaked code (a QR posted in a group chat): an
outsider could join, answer, and count in participation. Removable on the Roster tab today.

- [ ] If that ever matters: upload the class roster as a CSV (Canvas/registrar export) and
      **flag** anyone who is not on it, rather than block them (add/drop week, auditors, TAs).
      The quiz grader wants the same CSV (`docs/quiz-grader/OPEN_QUESTIONS.md` #4).

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
