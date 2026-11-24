# Pulse VM: setup request

A web app for Biochemistry 395. It runs in rootless Podman containers under a service account;
Apache on the host handles HTTPS and forwards to it. After handover I need no root access.

## VM

- **RHEL 9**, EI Managed, **M1.Medium** (2 vCPU, 8 GB RAM)
- One `/` partition, about **150 GB**
- **NetBackup**, including `/srv/pulse`

## Packages

- `podman` and **`podman-compose`** (from EPEL)
- `git`
- `httpd` and `mod_ssl`

## Service account

- User **`pulse`**, home **`/srv/pulse`**
- A **regular user, not a system user**: it needs subuid/subgid ranges for rootless containers,
  and `useradd --system` doesn't create them
- **Lingering enabled** (`loginctl enable-linger pulse`), so the containers run and start at boot
  with nobody logged in
- My NetID allowed to **`sudo -iu pulse`** (no root needed)

## Web

- A **public IP** and a **DNS name** (e.g. `pulse.dls.rutgers.edu`)
- An **InCommon certificate** for that name
- An **Apache vhost** for that name that:
  - redirects HTTP to HTTPS
  - proxies everything to the app on **`127.0.0.1:3001`**
  - passes **WebSockets** through (live updates in class)
  - uses a proxy timeout of at least 300 s (long-polling and large scan uploads)
  - recovers client addresses from the campus proxy (`mod_remoteip` with
    `trusted-proxy.lst`, which **must not be empty**)

  A tested config is attached (`pulse.conf`); adjust the hostname and certificate paths.
- If SELinux is enforcing: **`httpd_can_network_connect`** on, so Apache can reach the app

## Outgoing email

The app sends email (password resets now, class announcements later), and I'd like it to go
through the Rutgers mail relay instead of an outside service.

- The **SMTP relay** the app should use: host, port, and whether it needs authentication
  (and credentials if so). The app connects to it directly; no mail server on the VM.
- A **sender address** it may send as (e.g. `pulse@dls.rutgers.edu` or a no-reply address),
  set up so Rutgers and outside mail systems don't mark it as spam.
- Any **sending limits** (messages per hour or per message), since announcements would go to a
  whole class (~300 students) at once.

## Firewall

- **Inbound:** 443 and 80 from anywhere; 22 from the Rutgers VPN/campus
- **Outbound HTTPS (443):**
  - container images: `registry-1.docker.io`, `auth.docker.io`,
    `production.cloudflare.docker.com`
  - building the app: `registry.npmjs.org`, `binaries.prisma.sh`, `pypi.org`,
    `files.pythonhosted.org`
  - source code: `github.com`, `api.github.com`
  - app services: `api.anthropic.com` (to be replaced by the Rutgers Portkey gateway)
  - NetID sign-in (CAS, added later): `cas.rutgers.edu`, `test-cas.rutgers.edu`
- **Outbound SMTP:** to the mail relay above, on its port
- **Outbound SSH (22):** `github.com` (read-only deploy key)

## Not needed

No Docker, no Node.js or PostgreSQL on the host, no other open ports, no root for me.

## Please tell me

- When NetBackup runs, and how long backups are kept
- Whether SELinux is enforcing or permissive
- Whether VM storage is encrypted at rest
