#!/usr/bin/env bash
#
# Nightly database dump to local disk, for NetBackup to pick up.
#
#   bash deploy/backup.sh            (run by pulse-backup.timer)
#
# NetBackup copies the VM's disks, but copying a running Postgres's files can capture a
# half-written state that will not start. A pg_dump file is always consistent, so this
# writes one to $BACKUP_DIR and NetBackup backs that file up with everything else.
#
# Keeps the last $KEEP_DAILY dumps plus the first dump of each month (forever, until the
# retention policy says otherwise: README, "Retention"). Scans are not dumped here: they
# are ordinary files in the uploads volume, which NetBackup already copies as they are.

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-$HOME/backups}"
KEEP_DAILY="${KEEP_DAILY:-14}"
COMPOSE_DIR="$(cd "$(dirname "$0")" && pwd)"

# podman on the VM; docker where that is what's installed (testing).
if command -v podman >/dev/null 2>&1; then CT=podman; else CT=docker; fi

umask 077
mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/monthly"

STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
MONTH="$(date -u +%Y-%m)"
OUT="$BACKUP_DIR/daily/pulse-$STAMP.pgc"
TMP="$OUT.partial"
trap 'rm -f "$TMP"' EXIT

cd "$COMPOSE_DIR"
# pg_dump runs inside the db container, so its version always matches the server.
$CT compose exec -T db pg_dump -U pulse -d pulse -Fc > "$TMP"

# A dump that pg_restore cannot list is not a backup.
$CT compose exec -T db pg_restore --list < "$TMP" > /dev/null
mv "$TMP" "$OUT"
echo "backup: $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes)"

# First good dump of the month is also kept as that month's copy.
if ! ls "$BACKUP_DIR/monthly/pulse-$MONTH"* >/dev/null 2>&1; then
  cp "$OUT" "$BACKUP_DIR/monthly/"
  echo "backup: kept as the $MONTH monthly copy"
fi

# Prune dailies beyond the newest $KEEP_DAILY.
ls -1t "$BACKUP_DIR"/daily/pulse-*.pgc 2>/dev/null | tail -n +"$((KEEP_DAILY + 1))" | xargs -r rm -f
