#!/usr/bin/env bash
# Stops the detached dev stack started by scripts/dev-up.sh.
set -euo pipefail

PIDFILE=/tmp/gap-dev.pids
if [[ -f "$PIDFILE" ]]; then
  while IFS='=' read -r name pid; do
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "stopping $name (pid $pid)"
      # Kill the whole session so children of `setsid` go down too.
      kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
    fi
  done < "$PIDFILE"
  rm -f "$PIDFILE"
fi

# Belt-and-braces: anything still bound to our dev ports.
pkill -f 'bun.*src/app|bun.*src/daemon|bun.*scripts/dev-smee|smee-client' 2>/dev/null || true
echo "done."
