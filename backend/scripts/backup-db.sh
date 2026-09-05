#!/usr/bin/env bash
#
# One encrypted copy of the database, in a bucket that is not Railway's.
#
#   DATABASE_URL=postgres://... bash backend/scripts/backup-db.sh
#
# Called on a schedule by .github/workflows/backup.yml, and runs identically by
# hand — deliberately. A backup path that exists only inside CI is a path you
# cannot exercise on the morning you actually need it.
#
# Configuration is all environment, no flags:
#
#   DATABASE_URL       the database to dump. Required.
#   AGE_PUBLIC_KEY     age recipient. Required unless BACKUP_PLAINTEXT=1.
#   R2_BUCKET          destination bucket. Unset means local-only: the files are
#                      left in ./backups and nothing is uploaded, which is how
#                      you try this before any of the accounts exist.
#   R2_ENDPOINT        https://<account-id>.r2.cloudflarestorage.com
#   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY   R2 token, scoped to that bucket.
#   HEALTHCHECK_URL    pinged on success, /fail on failure. Optional, and the
#                      only thing here that notices a backup which stopped
#                      running rather than one that ran and broke.
#
# Custom format (-Fc), because that is what lets pg_restore later be selective
# and transactional. Two decisions worth knowing about:
#
#  - Row counts are taken *before* pg_dump starts. A row written while the dump
#    runs is therefore in the restore but not in the manifest, so
#    verify-restore.ts asserts restored >= recorded rather than equality. That
#    is the direction that still catches a dump which lost data, and it does not
#    cry wolf over an answer submitted at 4am.
#  - The manifest is uploaded in the clear. It holds table names and row counts,
#    no student data, and being able to see whether backups are healthy without
#    fetching the private key out of a password manager is worth more than
#    hiding the fact that the Response table has rows in it.

set -euo pipefail

fail() {
  echo "backup-db: $*" >&2
  if [ -n "${HEALTHCHECK_URL:-}" ]; then
    curl -fsS -m 10 --retry 3 "${HEALTHCHECK_URL%/}/fail" -d "$*" >/dev/null 2>&1 || true
  fi
  exit 1
}
trap 'fail "failed at line $LINENO"' ERR

: "${DATABASE_URL:?DATABASE_URL is required}"

PLAINTEXT="${BACKUP_PLAINTEXT:-0}"
if [ "$PLAINTEXT" != "1" ]; then
  : "${AGE_PUBLIC_KEY:?AGE_PUBLIC_KEY is required (or set BACKUP_PLAINTEXT=1)}"
  command -v age >/dev/null || fail "age is not installed"
fi
command -v pg_dump >/dev/null || fail "pg_dump is not installed"
command -v psql >/dev/null || fail "psql is not installed"

# pg_dump refuses to dump a server newer than itself, and left to its own
# devices it says so only after connecting, several steps in, in the language of
# version numbers rather than of what to change. psql is the tolerant one, so it
# can be asked first. Two ways to be here: a runner where the versioned client
# is installed but not first on PATH, or a laptop whose client is simply old.
SERVER_NUM="$(psql "$DATABASE_URL" -Atq -c 'SHOW server_version_num')"
SERVER_MAJOR=$((SERVER_NUM / 10000))
CLIENT_MAJOR="$(pg_dump --version | awk '{print $3}' | cut -d. -f1)"
if [ "$CLIENT_MAJOR" -lt "$SERVER_MAJOR" ]; then
  fail "pg_dump is $CLIENT_MAJOR, the server is $SERVER_MAJOR ($(command -v pg_dump)).
  On a runner: the versioned binaries are in /usr/lib/postgresql/$SERVER_MAJOR/bin and that
  directory has to come first on PATH — installing the package does not move /usr/bin/pg_dump.
  Locally: install client tools >= $SERVER_MAJOR.
  If the server was upgraded, three pins move together — the client in backup.yml,
  the client in restore-drill.yml, and the postgres service image in restore-drill.yml."
fi
echo "backup-db: pg_dump $CLIENT_MAJOR against server $SERVER_MAJOR"

STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
MONTH="$(date -u +%Y-%m)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Exact counts, not pg_stat's estimates — an estimate cannot tell you a table
# came back short. One xpath/query_to_xml pass gets every table in a single
# round trip; at this size the sequential scans cost nothing.
COUNT_SQL="
SELECT coalesce(json_object_agg(relname, cnt), '{}'::json)::text
FROM (
  SELECT c.relname,
         (xpath('/row/c/text()',
                query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname),
                             false, true, '')))[1]::text::bigint AS cnt
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = 'r' AND n.nspname = 'public'
) s;"

echo "backup-db: counting rows"
ROW_COUNTS="$(psql "$DATABASE_URL" -Atq -c "$COUNT_SQL")"
# to_json() hands back an already-quoted, already-escaped JSON string, which
# saves depending on jq being present just to quote one line of version banner.
PG_VERSION="$(psql "$DATABASE_URL" -Atq -c 'SELECT to_json(version())::text')"

echo "backup-db: dumping"
pg_dump -Fc --no-sync -f "$WORK/dump.pgc" "$DATABASE_URL"
DUMP_BYTES="$(wc -c < "$WORK/dump.pgc" | tr -d ' ')"

if [ "$PLAINTEXT" = "1" ]; then
  ARTIFACT="pulse-$STAMP.pgc"
  mv "$WORK/dump.pgc" "$WORK/$ARTIFACT"
else
  ARTIFACT="pulse-$STAMP.pgc.age"
  age -r "$AGE_PUBLIC_KEY" -o "$WORK/$ARTIFACT" "$WORK/dump.pgc"
  rm -f "$WORK/dump.pgc"
fi

ARTIFACT_BYTES="$(wc -c < "$WORK/$ARTIFACT" | tr -d ' ')"
ARTIFACT_SHA="$(sha256sum "$WORK/$ARTIFACT" | cut -d' ' -f1)"
GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"

cat > "$WORK/$ARTIFACT.manifest.json" <<JSON
{
  "takenAt": "$STAMP",
  "object": "$ARTIFACT",
  "encrypted": $([ "$PLAINTEXT" = "1" ] && echo false || echo true),
  "dumpBytes": $DUMP_BYTES,
  "artifactBytes": $ARTIFACT_BYTES,
  "artifactSha256": "$ARTIFACT_SHA",
  "gitSha": "$GIT_SHA",
  "sourceVersion": $PG_VERSION,
  "rowCounts": $ROW_COUNTS
}
JSON

if [ -z "${R2_BUCKET:-}" ]; then
  mkdir -p backups
  mv "$WORK/$ARTIFACT" "$WORK/$ARTIFACT.manifest.json" backups/
  echo "backup-db: R2_BUCKET unset — left backups/$ARTIFACT ($ARTIFACT_BYTES bytes)"
  exit 0
fi

command -v aws >/dev/null || fail "aws cli is not installed"
: "${R2_ENDPOINT:?R2_ENDPOINT is required when R2_BUCKET is set}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-auto}"
S3="aws s3 --endpoint-url $R2_ENDPOINT"

echo "backup-db: uploading daily/$ARTIFACT"
$S3 cp "$WORK/$ARTIFACT" "s3://$R2_BUCKET/daily/$ARTIFACT" --only-show-errors
$S3 cp "$WORK/$ARTIFACT.manifest.json" "s3://$R2_BUCKET/daily/$ARTIFACT.manifest.json" --only-show-errors

# The first backup that lands in a calendar month is also kept as that month's
# long-term copy. Keying off "is it the 1st" instead would mean one failed run
# on the 1st silently costs you the whole month.
EXISTING_MONTHLY="$($S3 ls "s3://$R2_BUCKET/monthly/pulse-$MONTH" 2>/dev/null || true)"
if [ -z "$EXISTING_MONTHLY" ]; then
  echo "backup-db: no monthly copy for $MONTH yet — promoting this one"
  $S3 cp "s3://$R2_BUCKET/daily/$ARTIFACT" "s3://$R2_BUCKET/monthly/$ARTIFACT" --only-show-errors
  $S3 cp "s3://$R2_BUCKET/daily/$ARTIFACT.manifest.json" "s3://$R2_BUCKET/monthly/$ARTIFACT.manifest.json" --only-show-errors
fi

if [ -n "${HEALTHCHECK_URL:-}" ]; then
  curl -fsS -m 10 --retry 3 "$HEALTHCHECK_URL" -d "$ARTIFACT $ARTIFACT_BYTES bytes" >/dev/null || true
fi

echo "backup-db: done — daily/$ARTIFACT ($ARTIFACT_BYTES bytes, sha256 ${ARTIFACT_SHA:0:12})"
