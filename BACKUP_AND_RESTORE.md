# Backing Pulse up, and putting it back

Written September 2026, against the register row in `PRODUCT_READINESS.md` that
says *untested backups, no retention policy*. Railway takes its own backups and
those stay on — this is the second copy, held by a different company, in a form
that is useless to whoever gets the bucket, and restored on a schedule so that
"we have backups" is a thing somebody has checked rather than a thing somebody
assumes.

Three pieces:

| Piece | Where | When |
|---|---|---|
| Dump, encrypt, upload | `.github/workflows/backup.yml` → `backend/scripts/backup-db.sh` | Daily, 08:00 UTC (4am Eastern) |
| Restore into a throwaway and check it | `.github/workflows/restore-drill.yml` → `restore-db.sh` + `verify-restore.ts` | Monthly, the 1st |
| Restore into the Railway scratch database | By hand, this document | Once a term, and after any change to the above |

The monthly drill deliberately restores into a Postgres container inside the
runner rather than into anything on Railway: it clobbers nothing anyone might be
using, and rebuilding from empty is a stronger claim than overwriting a database
that already has the right shape. What it does not exercise is Railway itself —
provisioning, connecting, migrating — which is why the by-hand restore stays on
the list.

**The window.** Backups are daily, so a disaster costs up to 24 hours of
answers. On a lecture day that is the wrong number, and the fix is free: run the
Backup workflow by hand (Actions → Backup → Run workflow) before class.

---

## One-time setup

Nothing below is done yet; the scripts and workflows are in place waiting on it.

### 1. A bucket

Cloudflare R2, a new bucket — `pulse-backups`. Then an R2 API token scoped to
**that bucket only**, with object read and write. Keep the account ID: the
endpoint is `https://<account-id>.r2.cloudflarestorage.com`.

### 2. Retention, as lifecycle rules

Set these on the bucket rather than deleting things from the script. Pruning
logic is where retention policies go wrong, and a rule that expires objects
cannot itself have a bug that expires the wrong ones.

| Prefix | Expire after | Holds |
|---|---|---|
| `daily/` | 35 days | Every night's backup |
| `monthly/` | 400 days | The first successful backup of each calendar month |

The script promotes the first backup of a month into `monthly/` by checking
whether one is already there — not by checking whether today is the 1st, which
would mean one failed run costing the whole month.

### 3. A key

```
age-keygen -o pulse-backup.key
```

It prints the public key (`age1…`) and writes the private key
(`AGE-SECRET-KEY-1…`) to the file. **Before the first backup runs, put that file
in two places** — the password manager and one other — because every backup
taken after this point is scrap without it.

On Windows: `winget install FiloSottile.age`.

### 4. A dead-man's switch

A check at healthchecks.io, period 1 day, grace 6 hours. Copy the ping URL.

This matters more than it sounds. A backup that *fails* emails you. A backup
that *stopped being scheduled* does not — and GitHub disables scheduled
workflows in a repository after 60 days without activity, which is roughly the
shape of a summer.

### 5. Repository secrets

Settings → Secrets and variables → Actions:

| Secret | What it is |
|---|---|
| `PROD_DATABASE_URL` | The production Postgres URL from Railway |
| `AGE_PUBLIC_KEY` | The `age1…` line from step 3 |
| `AGE_IDENTITY` | The full contents of `pulse-backup.key`. Used only by the drill |
| `R2_BUCKET` | `pulse-backups` |
| `R2_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` |
| `R2_ACCESS_KEY_ID` | From the R2 token |
| `R2_SECRET_ACCESS_KEY` | From the R2 token |
| `BACKUP_HEALTHCHECK_URL` | The ping URL from step 4 |

`AGE_IDENTITY` is the uncomfortable one and it should be uncomfortable
deliberately: the drill cannot restore what it cannot decrypt, so the private
key lives in Actions secrets as well as in your password manager. Encryption
here buys you that a leaked R2 token is worthless and that "encrypted at rest
under a key we hold" is a true sentence on a security questionnaire. It does not
buy you protection from your own GitHub account. If that trade stops looking
right, the alternative is dropping the drill to quarterly-by-hand and keeping
the key off CI entirely.

### 6. The server version, and the three places it is pinned

Production was **PostgreSQL 18.6** in September 2026. `pg_dump` refuses to dump
a server newer than itself, so the client major is pinned rather than left to
whatever a runner happens to ship, and three places have to move together when
Railway upgrades:

- `postgresql-client-18` in `.github/workflows/backup.yml`
- `postgresql-client-18` in `.github/workflows/restore-drill.yml`
- `image: postgres:18` in `.github/workflows/restore-drill.yml`

Miss the third and the drill fails restoring an 18 dump into a 17 container, for
a reason that has nothing to do with the backup. Confirm the current version
with `psql "$PROD_DATABASE_URL" -c 'select version()'`.

### 7. Run both by hand, in order

Actions → Backup → Run workflow. Then Actions → Restore drill → Run workflow.
Green on both is the moment the register row can be marked closed — not before.

---

## What the machine you are restoring from needs

Nothing, for the routine path. The daily backup and the monthly drill install
their own tools on a GitHub runner, so no personal machine is part of either,
and everything they need lives in this repository.

The laptop only matters when you are restoring by hand, and in a disaster that
may well not be this laptop. What that machine needs:

| | |
|---|---|
| `git clone` of this repository | The scripts and this document |
| PostgreSQL client tools, major **≥ 18** | `pg_restore`, `psql`. Client 17 cannot read an 18 server |
| `age` | `winget install FiloSottile.age`, or a release binary from github.com/FiloSottile/age |
| AWS CLI | `winget install Amazon.AWSCLI`. R2 speaks S3 |
| `pulse-backup.key` | From the password manager. Nothing works without it |
| The R2 token | `R2_BUCKET`, `R2_ENDPOINT`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` |

Git Bash, not PowerShell — these are `sh` scripts.

---

## Trying it by hand

Same script, run the same way it runs in CI; with no bucket configured it leaves
the files in `backups/` (gitignored). **This needs client tools ≥ the server's
major** — see the table above. If the machine has only an older client,
`pg_dump` stops before writing anything, and the honest alternative is to let
the CI drill be the first restore instead.

```
DATABASE_URL='<the scratch database>' BACKUP_PLAINTEXT=1 bash backend/scripts/backup-db.sh
```

Then put it back somewhere harmless and check it:

```
bash backend/scripts/restore-db.sh --into '<an empty database>' --from ./backups/pulse-<stamp>.pgc --work-dir ./restore
cd backend && DATABASE_URL='<that same empty database>' npx tsx scripts/verify-restore.ts --manifest ../restore/manifest.json
```

`BACKUP_PLAINTEXT=1` is for this and only this. It leaves student names, NetIDs,
email addresses and every answer anyone has written unencrypted on the disk of
whatever machine you ran it on. Delete it afterwards.

---

## When something has actually gone wrong

Read this whole section before typing anything.

**Do not restore over the broken database.** A `--clean` restore that dies
halfway leaves you holding neither the old data nor the new, and it will die
halfway at precisely the moment you can least afford it. Restore into a new
empty database and move `DATABASE_URL` across. The script refuses to target the
same database as `DATABASE_URL` for this reason, and the override flag exists so
that saying yes is deliberate.

1. **Write down the time.** Everything after the last backup's `takenAt` is
   gone, and knowing the boundary is what lets you tell students what to redo.
2. **Leave the broken database alone.** Do not delete it, do not "just try"
   anything on it. It is evidence, and it may still hold data no backup does.
3. **Provision an empty Postgres** on Railway, in the same project. Copy its
   connection URL.
4. **Restore into it:**
   ```
   bash backend/scripts/restore-db.sh --latest --into '<new url>' \
     --identity ./pulse-backup.key --work-dir ./restore
   ```
   Needs `R2_BUCKET`, `R2_ENDPOINT`, `AWS_ACCESS_KEY_ID` and
   `AWS_SECRET_ACCESS_KEY` in the environment. The script checks the dump's
   sha256 against the manifest before it decrypts, so a truncated download
   reports as a truncated download rather than as a bad backup.
5. **Check it came back whole:**
   ```
   cd backend && DATABASE_URL='<new url>' npx tsx scripts/verify-restore.ts --manifest ../restore/manifest.json
   ```
6. **Check the schema is current:**
   ```
   cd backend && DATABASE_URL='<new url>' npx prisma migrate status
   ```
   If the checkout is ahead of the backup, `npx prisma migrate deploy`. The
   verifier will already have said so as a note.
7. **Move the app across.** Set `DATABASE_URL` on the backend service and
   redeploy. `/health` answers `db: "up"` when it has landed — that path does a
   real `SELECT 1`, so it is a genuine answer.
8. **Then say what was lost**, to whoever lost it, with the boundary from step 1.

At current size a restore is a few minutes, most of it provisioning. Put the
real number here after the first drill.

---

## What this does not cover

**Uploads.** `UPLOAD_DIR` points at a Railway volume, and a volume attaches to
one service — neither Actions nor a second Railway service can read it. So a
restored database has questions referring to images that are gone. The clean fix
is moving uploads into the same R2 bucket, which would also retire the
one-instance caveat in `PRODUCT_READINESS.md`; until then it is a known hole,
and a manual `railway ssh` + `tar` is the stopgap.

**Retention of the live data.** Lifecycle rules expire *copies*. They say
nothing about how long the responses themselves are kept, and that is the part
the register actually calls out: education records, at least one set of them
under an account nobody was tracking, with no defined end of life. That needs a
written policy — responses deleted N years after the class's term ends — and
something that enforces it. It is a decision, not a script, and it should not
wait on this.

**Railway's own backups.** Still on, still the fastest way back from a bad
migration. This is the copy that survives losing the Railway account itself,
which is a different failure and the one Railway cannot help with.
