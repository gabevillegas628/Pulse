#!/usr/bin/env bash
#
# Put a backup back. Used two ways, and they are not the same operation:
#
#   The drill (monthly, .github/workflows/restore-drill.yml):
#     bash backend/scripts/restore-db.sh --latest --into "$DRILL_URL" --work-dir ./restore --yes
#
#   The morning something is actually wrong:
#     see BACKUP_AND_RESTORE.md. The short version is that you do not point this
#     at the broken production database. You provision an empty one, restore into
#     that, and move DATABASE_URL. A --clean restore that dies halfway leaves you
#     holding neither the old data nor the new, and it dies halfway at exactly
#     the moment you can least afford it.
#
# Options:
#   --into <url>       target database. Required.
#   --from <src>       s3://bucket/key, or a local path. Mutually exclusive with --latest.
#   --latest           newest object under daily/ in $R2_BUCKET.
#   --work-dir <dir>   where the fetched dump and manifest land. Default: a temp dir.
#   --identity <file>  age identity. Default: $AGE_IDENTITY_FILE.
#   --yes              skip the confirmation prompt (required in CI).
#   --force-into-source  allow --into to be the same database as $DATABASE_URL.
#
# --single-transaction is what makes a failed drill harmless: the restore either
# lands whole or the target is untouched, so a bad dump does not also cost you
# whatever was in the target.

set -euo pipefail

INTO=""; FROM=""; LATEST=0; WORK=""; IDENTITY="${AGE_IDENTITY_FILE:-}"; YES=0; FORCE_SOURCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --into) INTO="$2"; shift 2 ;;
    --from) FROM="$2"; shift 2 ;;
    --latest) LATEST=1; shift ;;
    --work-dir) WORK="$2"; shift 2 ;;
    --identity) IDENTITY="$2"; shift 2 ;;
    --yes) YES=1; shift ;;
    --force-into-source) FORCE_SOURCE=1; shift ;;
    *) echo "restore-db: unknown option $1" >&2; exit 1 ;;
  esac
done

die() { echo "restore-db: $*" >&2; exit 1; }

[ -n "$INTO" ] || die "--into <url> is required"
[ -n "$FROM" ] || [ "$LATEST" = "1" ] || die "one of --from <src> or --latest is required"
[ -z "$FROM" ] || [ "$LATEST" = "0" ] || die "--from and --latest are mutually exclusive"
command -v pg_restore >/dev/null || die "pg_restore is not installed"

# Host and database only — never echo a URL, it carries the password.
where() { sed -E 's#^[a-z+]+://([^@/]*@)?([^/?]+)/?([^?]*).*#\2/\3#' <<<"$1"; }
if [ "$FORCE_SOURCE" = "0" ] && [ -n "${DATABASE_URL:-}" ] && [ "$(where "$INTO")" = "$(where "$DATABASE_URL")" ]; then
  die "--into is the same database as DATABASE_URL. Restore into an empty database and move the URL; pass --force-into-source only if you are certain."
fi

if [ -z "$WORK" ]; then
  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT
fi
mkdir -p "$WORK"

if [ "$LATEST" = "1" ]; then
  : "${R2_BUCKET:?R2_BUCKET is required with --latest}"
  : "${R2_ENDPOINT:?R2_ENDPOINT is required with --latest}"
  export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-auto}"
  # Keys are UTC-stamped, so lexical order is chronological order.
  # `|| true` so that an empty bucket reaches the message below rather than
  # dying inside pipefail with grep's exit status and nothing to read.
  KEY="$(aws s3 ls "s3://$R2_BUCKET/daily/" --endpoint-url "$R2_ENDPOINT" \
         | awk '{print $4}' | grep -v '\.manifest\.json$' | sort | tail -1 || true)"
  [ -n "$KEY" ] || die "no objects under daily/ in $R2_BUCKET"
  FROM="s3://$R2_BUCKET/daily/$KEY"
  echo "restore-db: latest is $KEY"
fi

case "$FROM" in
  s3://*)
    : "${R2_ENDPOINT:?R2_ENDPOINT is required to fetch from s3}"
    export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-auto}"
    ARTIFACT="$WORK/$(basename "$FROM")"
    aws s3 cp "$FROM" "$ARTIFACT" --endpoint-url "$R2_ENDPOINT" --only-show-errors
    aws s3 cp "$FROM.manifest.json" "$WORK/manifest.json" --endpoint-url "$R2_ENDPOINT" --only-show-errors \
      || echo "restore-db: no manifest alongside the dump — verify-restore.ts will have nothing to check against" >&2
    ;;
  *)
    [ -f "$FROM" ] || die "no such file: $FROM"
    ARTIFACT="$WORK/$(basename "$FROM")"
    cp "$FROM" "$ARTIFACT"
    # An `&&` one-liner here would be a false statement under `set -e`: no
    # sidecar is a missing check, not a failed restore.
    if [ -f "$FROM.manifest.json" ]; then cp "$FROM.manifest.json" "$WORK/manifest.json"; fi
    ;;
esac

# The manifest records the sha of the artifact as uploaded. Checking it here is
# how a truncated download is told apart from a bad backup, which are otherwise
# the same red X.
if [ -f "$WORK/manifest.json" ]; then
  EXPECTED="$(sed -n 's/.*"artifactSha256": *"\([0-9a-f]*\)".*/\1/p' "$WORK/manifest.json")"
  if [ -n "$EXPECTED" ]; then
    ACTUAL="$(sha256sum "$ARTIFACT" | cut -d' ' -f1)"
    [ "$EXPECTED" = "$ACTUAL" ] || die "sha256 mismatch: manifest says ${EXPECTED:0:12}, file is ${ACTUAL:0:12}"
    echo "restore-db: sha256 matches the manifest"
  fi
fi

DUMP="$WORK/dump.pgc"
case "$ARTIFACT" in
  *.age)
    [ -n "$IDENTITY" ] || die "the artifact is encrypted; pass --identity <file> or set AGE_IDENTITY_FILE"
    [ -f "$IDENTITY" ] || die "no such identity file: $IDENTITY"
    command -v age >/dev/null || die "age is not installed"
    age -d -i "$IDENTITY" -o "$DUMP" "$ARTIFACT"
    ;;
  *) cp "$ARTIFACT" "$DUMP" ;;
esac

echo "restore-db: about to --clean and restore into $(where "$INTO")"
if [ "$YES" = "0" ]; then
  read -r -p "Everything in that database is replaced. Type 'restore' to continue: " CONFIRM
  [ "$CONFIRM" = "restore" ] || die "aborted"
fi

pg_restore --clean --if-exists --no-owner --no-privileges --single-transaction \
  -d "$INTO" "$DUMP"

echo "restore-db: restored. Work dir: $WORK"
echo "restore-db: next, prove it — DATABASE_URL=<target> npx tsx scripts/verify-restore.ts --manifest $WORK/manifest.json"
