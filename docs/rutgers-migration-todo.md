# Rutgers migration: to-do

Moving Pulse onto Rutgers infrastructure so student records stay under Rutgers policy.
Deployment setup: `deploy/README.md`. AI provider switch: `backend/src/ai/llm.ts`.

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
  - outbound 443 for AI: `aiplatform.googleapis.com` and `oauth2.googleapis.com` (Gemini);
    `api.anthropic.com` only while still on Claude
  - outbound 22 to `github.com`, if the VM clones over SSH with a deploy key
- [ ] After the VM exists, send the one-time setup email in `deploy/README.md` § 1 (Podman and
      compose, the `pulse` account with home `/var/lib/pulse`, linger, the low-ports sysctl,
      sudo access).

## Questions for OIT / Registrar

- [ ] Is Docker or Podman allowed on an EI Managed VM, and will I have sudo?
- [ ] Which Google Cloud project covers student data on Vertex AI / the Gemini API (not just the
      Workspace Gemini app)? How do I get access and a service-account key?
- [ ] Does Rutgers' AI-use policy go beyond FERPA for anonymised answer text?
- [ ] Is there a Rutgers SMTP relay to replace Brevo for password-reset email?
- [ ] When does NetBackup run, and how long are backups kept?
- [ ] What retention period applies to course records (responses, scores, scans)?
- [ ] TLS: Let's Encrypt OK, or does OIT issue the certificate?

## Install (once the VM is ready)

- [ ] Deploy key for the repo (read-only), then clone as `pulse`.
- [ ] Follow `deploy/README.md` § 2; start with a fresh database.
- [ ] `podman login docker.io` if pulls hit the rate limit.
- [ ] Practise a restore into a scratch database.
- [ ] Move `pulse-backup.timer` if NetBackup runs before 2am Eastern.

## Gemini

- [ ] Put the Vertex key in `deploy/secrets/gcp-key.json` (`podman unshare chown 1000:1000`,
      `chmod 600`); set `AI_PROVIDER=gemini` and `GOOGLE_CLOUD_PROJECT`.
- [ ] Confirm the default model IDs in `ROLES` against the live Vertex model list.
- [ ] Measure accuracy before grading real quizzes: `quiz-grader-spike.ts` with
      `AI_PROVIDER=gemini` on the Phase 0 pages; compare with the Claude baseline (enzymes 96.5%,
      cofactors 92.7%). Retune prompts if hand-drawn structures fall behind.
- [ ] Spot-check live themes and response grading on Gemini (`scripts/rehearse.ts`).
- [ ] Add Gemini prices to `backend/src/quizGrader/pricing.ts`.
- [ ] Use real student data with an AI provider only after Rutgers approves that route.

## Retire the old setup

- [ ] Make sure the grades that are needed are in Canvas (or exported somewhere approved).
- [ ] Then shut down Railway, the Cloudflare R2 backups and the GitHub Actions backup
      workflow, deliberately rather than in a hurry.
- [ ] Remove Brevo once a Rutgers mail route (or NetID SSO) replaces it.

## Code follow-ups

- [ ] Optional: strip roster names, NetIDs and emails from answer text before any AI call.
- [ ] Write the retention policy down, and add something that enforces it.
- [ ] Root `docker-compose.yml` (dev) points at `epam/indigo-service`, which no longer exists;
      switch it to `epmlsop/indigo-service:1.47.0` like `deploy/compose.yaml`.
- [ ] Later: NetID SSO (removes the password-reset flow entirely).
