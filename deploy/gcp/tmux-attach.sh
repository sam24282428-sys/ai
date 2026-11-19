#!/usr/bin/env bash
set -euo pipefail

SESSION_NAME="${1:-companion}"
STACK_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  exec tmux attach-session -t "$SESSION_NAME"
else
  exec tmux new-session -s "$SESSION_NAME" -c "$STACK_DIR" "npm run shared:open; exec bash"
fi
