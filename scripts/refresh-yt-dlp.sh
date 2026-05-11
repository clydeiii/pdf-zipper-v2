#!/usr/bin/env bash
# Weekly yt-dlp refresh for pdfzipper-v2.
#
# Rebuilds the yt-dlp Docker layer with a cache-busting arg so curl picks up
# the latest GitHub release, then restarts the container. Other layers
# (npm install, TypeScript build) stay cached, so this typically runs in
# ~20–30 seconds.
#
# Invoked from the user crontab; logs to logs/yt-dlp-update.log.
set -euo pipefail

REPO_DIR="/home/clyde/pdf-zipper-v2"
LOG_DIR="$REPO_DIR/logs"
LOG_FILE="$LOG_DIR/yt-dlp-update.log"

mkdir -p "$LOG_DIR"

{
  echo "===== $(date -Is) refresh-yt-dlp begin ====="

  cd "$REPO_DIR"

  BEFORE="$(docker exec pdfzipper-v2 yt-dlp --version 2>/dev/null || echo unknown)"
  echo "before: $BEFORE"

  docker compose build --build-arg "YT_DLP_CACHEBUST=$(date +%Y%m%d)"
  docker compose up -d

  # Give the worker a moment to come up before probing.
  sleep 5

  AFTER="$(docker exec pdfzipper-v2 yt-dlp --version 2>/dev/null || echo unknown)"
  echo "after:  $AFTER"

  if [ "$BEFORE" = "$AFTER" ]; then
    echo "result: no change (already current)"
  else
    echo "result: bumped $BEFORE -> $AFTER"
  fi

  echo "===== $(date -Is) refresh-yt-dlp done  ====="
  echo
} >> "$LOG_FILE" 2>&1
