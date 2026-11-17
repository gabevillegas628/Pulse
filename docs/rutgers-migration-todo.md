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
- [ ] Server inventory: `pulse01`, **M1.Medium** (2 vCPU / 8 GB), **RHEL**, `/` 50 GB +
      `/var` 100 GB; **EI Managed**; **NetBackup: Yes**.
- [ ] Network communication rows:
  - inbound from the Internet: 443, 80
  - inbound from the Rutgers VPN / campus: SSH 22
  - outbound 443 to: Docker Hub (`registry-1.docker.io`, `auth.docker.io`,
    `production.cloudflare.docker.com`), `registry.npmjs.org`, `binaries.prisma.sh`,
    `pypi.org`, `files.pythonhosted.org`, `github.com`, `api.github.com`,
    `acme-v02.api.letsencrypt.org`, `api.brevo.com`
  - outbound 443 for AI: Rutgers' Portkey gateway (host to be confirmed); Gemini fallback
    `aiplatform.googleapis.com` and `oauth2.googleapis.com`; `api.anthropic.com` only until
    Portkey is in place
  - outbound 22 to `github.com`, if the VM clones over SSH with a deploy key
- [ ] Ask for a public IP and a DNS name (e.g. `pulse.dls.rutgers.edu`; DLS may own that zone)
      and whether a Let's Encrypt certificate is OK.
- [ ] After the VM exists, send the one-time setup email in `deploy/README.md` § 1 (Podman and
      compose, the `pulse` account with home `/var/lib/pulse`, linger, the low-ports sysctl,
      sudo access).

## Questions for OIT / Registrar

- [ ] Is Docker or Podman allowed on an EI Managed VM, and will I have sudo?
- [ ] Is VM storage encrypted at rest?
- [ ] Does Rutgers' AI-use policy go beyond FERPA for anonymised answer text?
- [ ] Is there a Rutgers SMTP relay to replace Brevo for password-reset email?
- [ ] When does NetBackup run, and how long are backups kept?
- [ ] What retention period applies to course records (responses, scores, scans)?
- [ ] Is there a security review or questionnaire for the VM/app? (Answers are in
      `docs/security-overview.md`.)

## NetID sign-in (CAS or Shibboleth, after the VM is running)

- [ ] Ask OIT to register the app with CAS (or Shibboleth/SAML if they prefer): service URL
      `https://<pulse hostname>/api/auth/cas/callback`; attributes: NetID, plus email and
      name if they can be released.
- [ ] Build the CAS routes behind a setting; add outbound 443 to `cas.rutgers.edu`.
- [ ] Then remove Pulse passwords and the reset flow (and with them, Brevo).

## Install (once the VM is ready)

- [ ] Rehearse the install on RHEL with rootless Podman first (so far only tested with
      Docker). Set aside time for it; not before.
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
- [ ] Remove Brevo once a Rutgers mail route (or NetID SSO) replaces it.
- [ ] Delete the old `ccr-c2f95155-dbras2` branch on GitHub (same commits as
      `rutgers-migration`).

## Server management (after it's running)

- [ ] Run it for a few weeks first and note what you repeat by hand.
- [ ] Then a small `pulse` command-line tool on the VM, used over SSH (not a web panel):
      `status` (containers, health, disk, last backup and its age), `deploy`, `backup`,
      `restore` (with a confirmation step), `logs <service>`.
- [ ] Optional: a read-only "last backup" line on Pulse's admin page. Nothing that can
      trigger deploys or restores from the web.

## Code follow-ups

- [x] Strip NetIDs, emails, email-derived full names, ID and phone numbers from answer text
      before any AI call (`backend/src/ai/scrub.ts`).
- [x] Security overview for review (`docs/security-overview.md`).
- [ ] Write the retention policy down, and add something that enforces it.
- [ ] Move sign-in tokens from `localStorage` to httpOnly cookies.
- [ ] Root `docker-compose.yml` (dev) points at `epam/indigo-service`, which no longer exists;
      switch it to `epmlsop/indigo-service:1.47.0` like `deploy/compose.yaml`.
