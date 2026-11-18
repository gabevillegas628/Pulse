# Deploying Pulse on a Rutgers VM

One RHEL 9 VM (EI Managed, M1.Medium: 2 vCPU, 8 GB, one `/` partition of about 150 GB) set up
the way OIT set up the DSAP server: OIT's Apache on the host handles HTTPS with an InCommon
certificate and passes requests to the app, and a service account runs everything else as
four containers under rootless Podman:

| Container | What | Reachable from |
|---|---|---|
| `app` | Pulse (API, frontend, add-in) | OIT's Apache only (127.0.0.1:3001) |
| `db` | PostgreSQL 18 | the app only |
| `vision` | quiz scan processing (`vision/`) | the app only |
| `indigo` | chemical structure service | the app only |

Everything Pulse needs is inside the containers, so after the one-time setup below, deploying
and updating never needs anything installed on the host.

## 1. One-time setup by OIT

Rehearsed on Rocky Linux 9.9 (a rebuild of RHEL 9) with Podman 5.8 and RHEL's own Apache, so
the list is complete: after this, nothing else needs installing as root. Send it with the VM
request (EI Managed means OIT does the root-level parts). Most of it is what OIT already did
for the `dsap` account on the DSAP server:

> For the Pulse VM (RHEL 9), could you please set it up like the DSAP server:
>
> 1. **Packages:** `podman`, `podman-compose` (as on DSAP), `git`, `httpd` and `mod_ssl`.
> 2. **Service account `pulse`**, like `dsap`: a regular (not `--system`) user with home
>    `/srv/pulse`, so it gets subuid/subgid ranges for rootless containers:
>    `useradd --create-home --home-dir /srv/pulse --shell /bin/bash pulse`
> 3. **Linger**, like `dsap`: `loginctl enable-linger pulse`.
> 4. **Apache vhost** for the Pulse hostname with your InCommon certificate, proxying to the
>    app on `127.0.0.1:3001`: the attached `pulse.conf` (`deploy/apache/pulse.conf`), modelled
>    on DSAP's vhost, plus `setsebool -P httpd_can_network_connect 1` if SELinux is
>    enforcing. It needs WebSockets (`mod_proxy_wstunnel`, loaded by default).
> 5. **Firewall:** 443 and 80 from anywhere, 22 from the Rutgers VPN/campus, and the outbound
>    hosts listed below.
> 6. **Access:** let my NetID `sudo -iu pulse` (only that; I do not need root).
> 7. **Backups:** include `/srv/pulse` in NetBackup. When does it run, and how long are backups
>    kept?
> 8. **Network:** a public IP and a DNS name (e.g. `pulse.dls.rutgers.edu`), and the campus
>    proxy in `trusted-proxy.lst` as for DSAP.

Why each one, from the rehearsal and the DSAP server:

- **`podman-compose` is not in RHEL 9's own repositories** (it comes from EPEL), but OIT
  already installs it on managed VMs. If it were ever refused, Docker's compose tool works as
  a single file inside the account with no root (section 2); both were tested end to end.
- **A `--system` account gets no subuid ranges**, and rootless Podman then fails with a
  `newuidmap` error. A regular account, like `dsap`, gets them automatically.
- **Linger** is what lets the account's containers run, and start at boot, with nobody logged
  in. It was the sticking point on DSAP.
- **Apache instead of a web server in a container:** it is how DSAP is served, OIT manages the
  certificate, and nothing in Pulse then needs ports below 1024. Tested with RHEL's httpd
  2.4.62: HTTP→HTTPS redirect, HTTPS, the web app, WebSockets (101), large scan uploads, and
  real client addresses through the campus proxy (a forged `X-Forwarded-For` from anywhere
  else is ignored).
- **`/srv/pulse`** follows DSAP's convention. On a single `/` partition the location does not
  matter for space.

### Hosts the VM must reach (outbound HTTPS, 443)

For the VI form's Network Communication section. Building and running need these, and only
these:

| Purpose | Hosts |
|---|---|
| Container images | `registry-1.docker.io`, `auth.docker.io`, `production.cloudflare.docker.com` |
| App build | `registry.npmjs.org`, `binaries.prisma.sh` (Prisma's database engine) |
| Vision build | `pypi.org`, `files.pythonhosted.org` |
| Code | `github.com` |
| Compose fallback only (no EPEL) | `github.com`, `release-assets.githubusercontent.com` (one download) |
| Running app | `api.brevo.com` (reset email), `api.github.com` (textbook) |
| AI, Gemini | `aiplatform.googleapis.com` (or `<region>-aiplatform.googleapis.com` for a regional `GOOGLE_CLOUD_LOCATION`), `oauth2.googleapis.com` (service-account sign-in) |
| AI, Claude | `api.anthropic.com` (only while `AI_PROVIDER=claude`) |

Docker Hub limits anonymous pulls per IP address, and campus traffic can share one. If a pull
fails with `429 Too Many Requests`, sign in with a free Docker Hub account:
`podman login docker.io`.

## 2. After delivery: first install (as `pulse`)

Rehearsed step by step. About an hour, most of it the first image build.

**Get in:** `sudo -iu pulse` (lands in `/srv/pulse`).

**Only if OIT could not install `podman-compose`:** put Docker's compose tool where Podman finds
it even from systemd (not `~/.local/bin`, which systemd's PATH does not include), and start the
Podman socket it talks to:

```bash
mkdir -p ~/.docker/cli-plugins
curl -fsSL -o ~/.docker/cli-plugins/docker-compose \
  https://github.com/docker/compose/releases/download/v2.39.2/docker-compose-linux-x86_64
chmod +x ~/.docker/cli-plugins/docker-compose
systemctl --user enable --now podman.socket
```

**Code:** if the repository is private, give the VM read access with a deploy key:
`ssh-keygen -t ed25519`, add `~/.ssh/id_ed25519.pub` under the repo's Settings → Deploy keys
(read-only), and clone over SSH (outbound port 22 to `github.com`).

```bash
git clone --branch rutgers-migration git@github.com:gabevillegas628/Pulse.git ~/Pulse
cd ~/Pulse/deploy
cp env.example .env && chmod 600 .env
# Fill in .env: PULSE_DOMAIN, PROFESSOR_INVITE_CODE, and the secrets
# (POSTGRES_PASSWORD, JWT_SECRET, VISION_TOKEN: `openssl rand -hex 32` each).
```

**Build and start:**

```bash
podman login docker.io                  # optional; avoids Docker Hub's anonymous pull limit
podman compose build                    # the app image takes the longest
podman compose up -d
podman compose ps                       # four services Up; db and app "(healthy)"
curl -s http://127.0.0.1:3001/health    # {"status":"ok","db":"up",...}
curl -s https://$PULSE_DOMAIN/health    # the same, through OIT's Apache, once the vhost is in
```

**Start at boot, and nightly backups:**

```bash
mkdir -p ~/.config/systemd/user
cp systemd/* ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable pulse.service pulse-backup.timer
systemctl --user start pulse-backup.timer
systemctl --user list-timers            # pulse-backup: next run 07:00 UTC (2am Eastern)
```

**Check backups and restore before trusting them:**

```bash
systemctl --user start pulse-backup.service && ls -l ~/backups/daily
# Then the restore drill in section 4, into a scratch database.
```

**Use it:** register the professor account at `/register?role=professor` with
`PROFESSOR_INVITE_CODE`. The database starts empty; migrations run on first start.

### What the rehearsal covered, and what it could not

Passed on Rocky Linux 9 / Podman 5.8 as a rootless `pulse` user: both images build (with
`podman build`; `podman compose build` runs the same steps but could not finish behind the
sandbox's proxy); the containers start and pass health checks; the app reaches the vision and
Indigo services; backup and a restore drill; start at boot after a simulated reboot; the
nightly backup job under systemd. All of it with `podman-compose` and again with the Docker
compose fallback. Separately, RHEL's httpd 2.4.62 with `deploy/apache/pulse.conf` in front of
the app: see "Why each one" above. (The first rehearsal used a Caddy container for HTTPS;
it was dropped to match DSAP.)

Not covered, because the sandbox could not: **SELinux** (the sandbox has none; DSAP's server
runs it in Permissive mode; the one bind mount carries `:Z`, and Podman labels the volumes),
OIT's **real certificate** and campus proxy, and **cgroups v2** (the sandbox has v1; RHEL 9
uses v2, which is Podman's normal case). If something breaks on day one with SELinux
enforcing, `sudo ausearch -m avc -ts recent` (OIT) shows what was denied.

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

- **SELinux:** works enforcing or permissive. The one bind mount (`deploy/secrets`) carries
  `:Z`; the volumes are named volumes, which Podman labels itself. If you add a bind mount,
  give it `:Z` too or the container gets "permission denied".
- **Real client addresses:** the campus proxy and Apache pass them in `X-Forwarded-For`; the
  app trusts exactly one hop (`app.ts`), which is Apache.
- **Logs:** `podman compose logs -f app` (or `vision`, `db`, `indigo`); Apache's are in
  `/var/log/httpd/` (OIT).
- **Student data** lives only in the `db` and `uploads` volumes and in `~/backups`. None of it
  is in the images or the repository (`.dockerignore`, `.gitignore`).
