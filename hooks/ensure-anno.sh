#!/bin/sh
# Pre-install the anno CLI in the background on the first session after the
# plugin is installed, so the first /review-md doesn't stall on the ~200MB
# Electron download. One attempt only (stamp-gated) — if it fails, the
# review-md skill's interactive install offer is the fallback.
command -v anno >/dev/null 2>&1 && exit 0
command -v npm >/dev/null 2>&1 || exit 0

STATE_DIR="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/anno}"
STAMP="$STATE_DIR/install-attempted"
[ -f "$STAMP" ] && exit 0
mkdir -p "$STATE_DIR" 2>/dev/null || exit 0
touch "$STAMP"

# stderr (not stdout) so this reaches the user, not Claude's context.
echo "anno: installing the anno CLI in the background (one-time, ~1 min)…" >&2
nohup npm install -g anno-md@0.3.0 \
  >"$STATE_DIR/install.log" 2>&1 &
exit 0
