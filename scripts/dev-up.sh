#!/usr/bin/env bash
# Spawns dev server + daemon + smee forwarder fully detached (new session, no
# controlling terminal). The wrapper exits immediately so the Claude Code
# harness sees a clean termination and doesn't try to lifecycle-manage the
# children. Children live until killed via scripts/dev-down.sh.
#
# Logs:
#   /tmp/gap-dev.log     (orchestrator + watch-mode rebuilds)
#   /tmp/gap-daemon.log  (daemon worker)
#   /tmp/gap-smee.log    (smee.io webhook forwarder)
#
# Pidfile: /tmp/gap-dev.pids
set -euo pipefail

cd "$(dirname "$0")/.."

PIDFILE=/tmp/gap-dev.pids
rm -f "$PIDFILE"
: > /tmp/gap-dev.log /tmp/gap-daemon.log /tmp/gap-smee.log

# Export PORT so all three children agree on it: the server binds it and
# dev:smee derives its relay target from it. Honour an externally-set PORT,
# else default to 3030.
export PORT="${PORT:-3030}"

# `nohup` detaches from the controlling terminal and starts a new session
# so SIGHUP from a dying parent shell does not propagate. `</dev/null` cuts
# stdin (otherwise the child inherits the harness's closed stdin and exits
# on first read).
nohup bun run dev </dev/null >>/tmp/gap-dev.log 2>&1 &
echo "dev=$!" >> "$PIDFILE"

nohup bun run dev:daemon </dev/null >>/tmp/gap-daemon.log 2>&1 &
echo "daemon=$!" >> "$PIDFILE"

nohup bun run dev:smee </dev/null >>/tmp/gap-smee.log 2>&1 &
echo "smee=$!" >> "$PIDFILE"

# Brief wait so the wrapper exit doesn't race with the first log lines.
sleep 1
cat "$PIDFILE"
echo "logs: /tmp/gap-{dev,daemon,smee}.log"
