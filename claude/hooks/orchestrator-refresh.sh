#!/usr/bin/env bash
set -u

[ -z "${AGENT_HARNESS_CHILD:-}${ORCHESTRATOR_REFRESH_JOB:-}" ] || { cat >/dev/null; exit 0; }

cat >/dev/null

self="$(readlink -f "$0" 2>/dev/null || realpath "$0" 2>/dev/null || printf '%s' "$0")"
harness="$(cd "$(dirname "$self")/../.." 2>/dev/null && pwd)"
if [ ! -f "$harness/scripts/refresh-orchestrator.ts" ] && [ -n "${AGENT_HARNESS:-}" ]; then
  harness="$AGENT_HARNESS"
fi

state="${XDG_STATE_HOME:-$HOME/.local/state}/orchestrator-refresh"
log="$HOME/.claude/logs/orchestrator-refresh.log"
marker="$state/result.json"

if [ -f "$marker" ] && command -v jq >/dev/null 2>&1; then
  claimed="$state/claimed.$$.$RANDOM"
  if mv "$marker" "$claimed" 2>/dev/null; then
    if context="$(jq -ce 'select(type == "object" and (.message | type) == "string")
        | {hookSpecificOutput: {hookEventName: "SessionStart",
            additionalContext: (.message + (if .error then "\nError: \(.error)" else "" end))}}' "$claimed" 2>/dev/null)"; then
      printf '%s\n' "$context"
      rm -f "$claimed"
    fi
  fi
fi

current="$(claude --version 2>/dev/null | awk 'NR == 1 { print $1 }')"
[ -n "$current" ] || exit 0
vendored="$(awk 'NR == 1 && $1 == "claude-code" { print $2 }' "$harness/vendor/claude-code/VERSION" 2>/dev/null)"
[ "$current" != "$vendored" ] || exit 0

[ -d "$state/attempted" ] || rm -f "$state/attempted" 2>/dev/null
mkdir -p "$state/attempted" "$(dirname "$log")" 2>/dev/null || exit 0
(set -C; : > "$state/attempted/$current") 2>/dev/null || exit 0

bun="$(command -v bun 2>/dev/null)"
for candidate in "$HOME/.local/share/mise/shims/bun" "$HOME/.bun/bin/bun"; do
  if [ -z "$bun" ] && [ -x "$candidate" ]; then bun="$candidate"; fi
done
if [ -z "$bun" ]; then
  jq -n --arg v "$current" --arg old "${vendored:-unknown}" \
    '{version: $v, message: "Claude Code updated to \($v), but bun was not found, so the vendored prompt was not refreshed and the orchestrator is still on \($old)."}' \
    > "$marker.$$.tmp" 2>/dev/null && mv "$marker.$$.tmp" "$marker"
  exit 0
fi

AGENT_HARNESS_CHILD=1 nohup "$bun" "$harness/scripts/refresh-orchestrator.ts" >> "$log" 2>&1 < /dev/null &

exit 0
