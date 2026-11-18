# Pulse VM: setup request

Everything the VM needs before handover, in order. Each step has a check; please run it and
confirm the output matches. After this nothing else needs root: the application is installed
and run by the `pulse` account.

Replace **`pulse.dls.rutgers.edu`** with the hostname you assign, everywhere below.

## 1. The VM

| | |
|---|---|
| OS | **RHEL 9** (not RHEL 8) |
| Size | M1.Medium: 2 vCPU, 8 GB RAM |
| Disk | One `/` partition, about 150 GB (no separate `/var` or `/srv` needed) |
| Management | EI Managed |
| NetBackup | Yes, including `/srv/pulse` |
| SELinux | Enforcing or permissive, either works (step 5 covers enforcing) |

## 2. Packages

```bash
dnf install -y podman git httpd mod_ssl
dnf install -y podman-compose
```

`podman-compose` is not in RHEL's own repositories; it comes from **EPEL** (it is already
installed this way on other OIT-managed VMs). On RHEL, enable EPEL the usual way for your
environment (the `epel-release` package from the EPEL project, plus the CodeReady Builder
repository), then install it.

**Check:**

```bash
podman --version            # podman version 5.x
podman-compose --version    # podman-compose version 1.x
git --version
httpd -v                    # Apache/2.4.x
```

## 3. Service account `pulse`

It **must be a regular user, not a system user** (`useradd --system` gives it no subuid/subgid
ranges, and rootless containers then fail to start). Home is `/srv/pulse`.

```bash
useradd --create-home --home-dir /srv/pulse --shell /bin/bash pulse
loginctl enable-linger pulse
```

`enable-linger` lets the account's containers keep running, and start at boot, with nobody
logged in. Without it, the application stops when the last session closes.

Then allow my NetID to switch to that account (no root needed):

```
# /etc/sudoers.d/pulse
<my NetID> ALL=(pulse) ALL
```

**Check:**

```bash
grep pulse /etc/subuid /etc/subgid      # /etc/subuid:pulse:<start>:65536  (and the same in subgid)
loginctl show-user pulse -p Linger      # Linger=yes
ls /var/lib/systemd/linger/             # pulse
ls -ld /srv/pulse                       # owned by pulse
sudo -iu pulse podman info --format '{{.Host.Security.Rootless}}'   # true
```

The last command must print `true` without errors. A `newuidmap` error means the account has
no subuid range (it was created as a system user): add one with
`usermod --add-subuids 200000-265535 --add-subgids 200000-265535 pulse`.

## 4. Apache

Certificate: an InCommon certificate for the hostname, installed as

- `/etc/pki/tls/certs/pulse.dls.rutgers.edu.crt`
- `/etc/pki/tls/private/pulse.dls.rutgers.edu.key`
- chain: `/etc/pki/tls/certs/InCommonBundle-SHA2.crt`

(or your usual paths; adjust the three `SSLCertificate…` lines below to match).

Trusted proxies: `/etc/httpd/conf/trusted-proxy.lst` must list the campus proxy / load
balancer addresses that sit in front of this VM, one per line. **It must not be empty**: with
an empty list, Apache trusts the client-address header from anyone.

Save this as **`/etc/httpd/conf.d/pulse.conf`** (the same file is in the repository as
`deploy/apache/pulse.conf`):

```apache
<VirtualHost *:80>
  ServerName pulse.dls.rutgers.edu
  RewriteEngine On
  RewriteCond %{HTTPS} !=on
  RewriteRule ^/?(.*) https://%{SERVER_NAME}/$1 [R=301,L]
</VirtualHost>

<VirtualHost *:443>
  ServerName pulse.dls.rutgers.edu

  SSLEngine on
  SSLProtocol all -SSLv3 -TLSv1 -TLSv1.1
  SSLHonorCipherOrder On
  SSLCompression off
  SSLCertificateFile /etc/pki/tls/certs/pulse.dls.rutgers.edu.crt
  SSLCertificateKeyFile /etc/pki/tls/private/pulse.dls.rutgers.edu.key
  SSLCertificateChainFile /etc/pki/tls/certs/InCommonBundle-SHA2.crt

  # Real client addresses through the campus proxy.
  RemoteIPHeader X-Forwarded-For
  RemoteIPInternalProxyList conf/trusted-proxy.lst
  RequestHeader set X-Forwarded-Proto "https"
  RequestHeader set X-Forwarded-Port 443

  LogFormat "%a %l %u %t \"%r\" %>s %b \"%{Referer}i\" \"%{User-Agent}i\"" proxy
  CustomLog "/var/log/httpd/pulse.dls.rutgers.edu_access_log" proxy
  ErrorLog "/var/log/httpd/pulse.dls.rutgers.edu_error_log"

  # WebSockets (live updates in class).
  RewriteEngine On
  RewriteCond %{HTTP:Upgrade} websocket [NC]
  RewriteCond %{HTTP:Connection} upgrade [NC]
  RewriteRule ^/?(.*) "ws://127.0.0.1:3001/$1" [P,L]

  # Everything else, to the application on this VM.
  ProxyPreserveHost On
  ProxyRequests Off
  ProxyPass        / http://127.0.0.1:3001/ timeout=300
  ProxyPassReverse / http://127.0.0.1:3001/
</VirtualHost>
```

Every module this uses (`ssl`, `proxy`, `proxy_http`, `proxy_wstunnel`, `rewrite`, `remoteip`,
`headers`) is loaded by default on RHEL. No upload size limit is set here on purpose: the
application enforces its own.

```bash
systemctl enable --now httpd
```

**Check:**

```bash
httpd -t                                         # Syntax OK
systemctl is-active httpd                        # active
curl -sI http://pulse.dls.rutgers.edu/ | head -2   # 301, Location: https://pulse.dls.rutgers.edu/
curl -sI https://pulse.dls.rutgers.edu/ | head -1  # 503 until the app is installed (expected)
```

A **503** on HTTPS at this stage is correct: Apache and the certificate work, and the app it
forwards to is not installed yet. A certificate error or a connection refused is not.

## 5. SELinux (only if enforcing)

Apache must be allowed to connect to the application:

```bash
setsebool -P httpd_can_network_connect 1
```

**Check:** `getsebool httpd_can_network_connect` → `on`

## 6. Network

- A **public IP** and a **DNS record** for `pulse.dls.rutgers.edu`.
- **Inbound:** TCP 443 and 80 from anywhere; TCP 22 from the Rutgers VPN/campus only.
- **Outbound HTTPS (443)** to:

| Purpose | Hosts |
|---|---|
| Container images | `registry-1.docker.io`, `auth.docker.io`, `production.cloudflare.docker.com` |
| Building the application | `registry.npmjs.org`, `binaries.prisma.sh`, `pypi.org`, `files.pythonhosted.org` |
| Source code | `github.com`, `api.github.com` |
| Application services | `api.brevo.com`, `api.anthropic.com` (later replaced by the Rutgers Portkey gateway) |

- **Outbound SSH (22)** to `github.com` (read-only deploy key for the source code).

**Check** (as `pulse`):

```bash
curl -sI https://registry-1.docker.io/v2/ | head -1   # HTTP/... 401 (reachable; 401 is normal)
curl -sI https://registry.npmjs.org/ | head -1         # HTTP/... 200
ssh -T git@github.com    # "Permission denied (publickey)" is fine: it means GitHub is reachable
```

## 7. Please tell me

- When NetBackup runs, and how long backups are kept.
- Whether SELinux is enforcing or permissive.
- Whether VM storage is encrypted at rest.

## Not needed

So nothing extra gets set up: no Docker, no Node.js or PostgreSQL on the host, no ports other
than 80/443/22, no root access for me, no change to `net.ipv4.ip_unprivileged_port_start`.
Everything else runs in rootless containers under `pulse`.
