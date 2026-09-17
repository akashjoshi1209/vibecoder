#!/usr/bin/env bash
# Run the VibeCoder task queue daemon in the background.
# Uses bun so it handles ESM and async properly.
# On exit, run `kill $(cat ~/.vibecoder/queue-daemon.pid)` or `kill <pid>`.

set -eu
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

LOG="${HOME}/.vibecoder/queue-daemon.log"
mkdir -p "$(dirname "$LOG")"

echo "[queue] starting daemon … (log → ${LOG})"
nohup bun src/daemon.ts start >> "$LOG" 2>&1 &
PID=$!
echo "[queue] daemon running (pid ${PID}) — status: 'bun src/daemon.ts status' · stop: 'bun src/daemon.ts stop'"
