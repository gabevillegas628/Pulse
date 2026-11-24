#!/usr/bin/env bash
#
# Update the running app to the latest code on the current branch.
#
#   bash deploy/deploy.sh
#
# Takes a backup first, rebuilds the two local images, and restarts only what changed.
# Migrations run when the app container starts (Containerfile CMD).

set -euo pipefail
cd "$(dirname "$0")"

if command -v podman >/dev/null 2>&1; then CT=podman; else CT=docker; fi

git -C .. pull --ff-only
bash ./backup.sh
$CT compose build app vision
$CT compose up -d
$CT compose ps
