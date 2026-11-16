# Deploying Pulse on a Rutgers VM

One RHEL VM (EI Managed, M1.Medium: 2 vCPU, 8 GB, `/` 50 GB + `/var` 100 GB) running five
containers under rootless Podman:

| Container | What | Reachable from |
|---|---|---|
| `caddy` | HTTPS, certificates, reverse proxy | the Internet, ports 80/443 |
| `app` | Pulse (API, frontend, add-in) | Caddy only (127.0.0.1:3001) |
| `db` | PostgreSQL 18 | the app only |
| `vision` | quiz scan processing (`vision/`) | the app only |
| `indigo` | chemical structure service | the app only |

Everything Pulse needs is inside the containers, so after the one-time setup below, deploying
and updating never needs anything installed on the host.

## 1. One-time setup by OIT

Send this to OIT once the VM exists (EI Managed means they do the root-level parts):

> For VM `<hostname>`, could you please:
>
> 1. Install `podman` and a compose provider (`podman-compose` from EPEL, or allow me to
>    use the docker-compose binary as the provider).
> 2. Create a service account `pulse` with its home directory at `/var/lib/pulse` (so
>    container storage lands on the `/var` partition), with subuid/subgid ranges for
>    rootless containers.
> 3. Run `loginctl enable-linger pulse` so its user services start at boot.
> 4. Set `net.ipv4.ip_unprivileged_port_start=80` (persisted in `/etc/sysctl.d/`) so the
>    rootless web server can bind ports 80 and 443, and open 80/443 in firewalld.
> 5. Let me `sudo -iu pulse` (or log in as it) to manage the application.
> 6. Tell me when NetBackup runs, and how long backups are kept.

The `sysctl` in step 4 is a common rootless-container setting. The alternative, forwarding
80/443 to high ports in firewalld, hides student IP addresses from the app, which breaks its
per-client rate limiting.

### Hosts the VM must reach (outbound HTTPS, 443)

For the VI form's Network Communication section. Building and running need these, and only
these:

| Purpose | Hosts |
|---|---|
| Container images | `registry-1.docker.io`, `auth.docker.io`, `production.cloudflare.docker.com` |
| App build | `registry.npmjs.org`, `binaries.prisma.sh` (Prisma's database engine) |
| Vision build | `pypi.org`, `files.pythonhosted.org` |
| Code | `github.com` |
| TLS certificate | `acme-v02.api.letsencrypt.org` (not needed if OIT supplies the certificate) |
| Running app | `api.brevo.com` (reset email), `api.github.com` (textbook) |
| AI, Gemini | `aiplatform.googleapis.com` (or `<region>-aiplatform.googleapis.com` for a regional `GOOGLE_CLOUD_LOCATION`), `oauth2.googleapis.com` (service-account sign-in) |
| AI, Claude | `api.anthropic.com` (only while `AI_PROVIDER=claude`) |

Docker Hub limits anonymous pulls per IP address, and campus traffic can share one. If a pull
fails with `429 Too Many Requests`, sign in with a free Docker Hub account:
`podman login docker.io`.

## 2. First install (as `pulse`)

If the repository is private, give the VM read access with a deploy key: `ssh-keygen -t
ed25519` as `pulse`, add the public key under the repo's Settings → Deploy keys (read-only), and
clone over SSH (`git@github.com:gabevillegas628/Pulse.git`; outbound port 22 to `github.com`
then needs to be in the firewall list too).

```bash
git clone https://github.com/gabevillegas628/Pulse.git ~/Pulse
cd ~/Pulse/deploy
cp env.example .env && chmod 600 .env
# Fill in .env: PULSE_DOMAIN, ACME_EMAIL, and the secrets (openssl rand -hex 32 each).

podman compose build
podman compose up -d
podman compose ps                       # all five Up; app shows (healthy)
curl -s https://$PULSE_DOMAIN/health    # {"status":"ok","db":"up",...}

mkdir -p ~/.config/systemd/user
cp systemd/* ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable pulse.service pulse-backup.timer
systemctl --user start pulse-backup.timer
```

The database starts empty and migrations run on first start. Register the professor account at
`/register?role=professor` with `PROFESSOR_INVITE_CODE`.

### Switching the AI to Gemini (Vertex AI)

Once Rutgers confirms which Google Cloud project covers student data:

1. In that project, enable the Vertex AI API and create a service account with the
   **Vertex AI User** role. Create a JSON key for it.
2. Copy the key to `~/Pulse/deploy/secrets/gcp-key.json` on the VM. The folder is git-ignored
   and is not part of any image. The app runs as user `node` inside its container, so hand the
   file to that user and keep it private:
   `podman unshare chown 1000:1000 deploy/secrets/gcp-key.json && chmod 600 deploy/secrets/gcp-key.json`
3. In `deploy/.env`: `AI_PROVIDER=gemini`, `GOOGLE_CLOUD_PROJECT=<project id>`.
4. `podman compose up -d app`.

Before grading real quizzes on it, measure it: run `backend/scripts/quiz-grader-spike.ts` with
`AI_PROVIDER=gemini` on the same pages as the Phase 0 baseline (docs/quiz-grader/README.md) and
compare the agreement table. Pages already graded keep their Claude readings until re-read.

## 3. Updating

```bash
bash ~/Pulse/deploy/deploy.sh
```

Pulls the branch, takes a backup, rebuilds the app and vision images, and restarts what changed.
Migrations apply on start. Expect a few seconds of downtime, so don't deploy during class.

## 4. Backups

`pulse-backup.timer` runs `backup.sh` nightly (2am Eastern). It writes a `pg_dump` file to
`~/backups/daily/` (the last 14) and `~/backups/monthly/` (the first of each month), and checks
each dump is readable before keeping it. NetBackup then copies those files, along with the scans
in the uploads volume.

Why the dump step: NetBackup copies disks, and a copy of a running database's files can be
caught mid-write and refuse to start. A dump file is always consistent.

Check it ran: `systemctl --user list-timers` and `ls -l ~/backups/daily`.

**Restore** (into the running database, replacing its contents):

```bash
cd ~/Pulse/deploy
podman compose stop app
podman compose exec -T db dropdb -U pulse pulse
podman compose exec -T db createdb -U pulse pulse
podman compose exec -T db pg_restore -U pulse -d pulse --no-owner < ~/backups/daily/<file>.pgc
podman compose start app
```

Practise it once into a scratch database (`createdb -U pulse restoretest`, restore there,
`dropdb` after) before you need it.

### Retention

Monthly dumps are kept until someone deletes them. Once Rutgers gives you a retention period
for course records, delete older monthly files to match; NetBackup's own retention is OIT's.

## Notes

- **SELinux** stays enforcing. The one host file mounted into a container (the Caddyfile)
  carries `:Z`; the volumes are named volumes, which Podman labels itself. If you add a bind
  mount, give it `:Z` too or the container gets "permission denied".
- **Why Caddy is on the host network:** with rootless Podman, a container behind a published
  port sees every client as the same internal address. On the host network Caddy sees the real
  address and passes it to the app (`X-Forwarded-For`, trusted for one hop in `app.ts`).
- **Logs:** `podman compose logs -f app` (or `caddy`, `vision`, …).
- **Student data** lives only in the `db` and `uploads` volumes and in `~/backups`. None of it
  is in the images or the repository (`.dockerignore`, `.gitignore`).
- Tested end to end with Docker on Linux (build, migrations, HTTPS through Caddy, websockets,
  vision and Indigo from the app, backup, restore). Not yet run on RHEL with Podman; expect
  the first install to surface small differences.
