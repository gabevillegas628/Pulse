# Rutgers migration: to-do

Moving Pulse onto Rutgers infrastructure so student records stay under Rutgers policy.
Deployment setup: `deploy/README.md`. AI provider switch: `backend/src/ai/llm.ts`.
Security overview for review: `docs/security-overview.md`.

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

## AI access: Rutgers Portkey (first choice)

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

## NetID sign-in (CAS)

- [ ] Ask OIT to register the app with CAS (or Shibboleth/SAML if they prefer): service URL
      `https://<pulse hostname>/api/auth/cas/callback`; attributes: NetID, plus email and
      name if they can be released.
- [ ] Build the CAS routes behind a setting; add outbound 443 to `cas.rutgers.edu`.
- [ ] Then remove Pulse passwords and the reset flow (and with them, Brevo).

## Install (once the VM is ready)

- [ ] Deploy key for the repo (read-only), then clone as `pulse`.
- [ ] Follow `deploy/README.md` § 2; start with a fresh database.
- [ ] `podman login docker.io` if pulls hit the rate limit.
- [ ] Practise a restore into a scratch database.
- [ ] Move `pulse-backup.timer` if NetBackup runs before 2am Eastern.

## Retire the old setup

- [ ] Make sure the grades that are needed are in Canvas (or exported somewhere approved).
- [ ] Then shut down Railway, the Cloudflare R2 backups and the GitHub Actions backup
      workflow, deliberately rather than in a hurry.
- [ ] Remove Brevo once a Rutgers mail route (or NetID SSO) replaces it.
- [ ] Delete the old `ccr-c2f95155-dbras2` branch on GitHub (same commits as
      `rutgers-migration`).

## Code follow-ups

- [x] Strip NetIDs, emails, email-derived full names, ID and phone numbers from answer text
      before any AI call (`backend/src/ai/scrub.ts`).
- [x] Security overview for review (`docs/security-overview.md`).
- [ ] Write the retention policy down, and add something that enforces it.
- [ ] Move sign-in tokens from `localStorage` to httpOnly cookies.
- [ ] Root `docker-compose.yml` (dev) points at `epam/indigo-service`, which no longer exists;
      switch it to `epmlsop/indigo-service:1.47.0` like `deploy/compose.yaml`.
