#!/usr/bin/env bash
set -u

[ -z "${ORCHESTRATOR_REFRESH_JOB:-}" ] || { cat >/dev/null; exit 0; }

self="$(readlink -f "$0" 2>/dev/null || realpath "$0" 2>/dev/null || printf '%s' "$0")"
harness="$(cd "$(dirname "$self")/../.." 2>/dev/null && pwd)"
if [ ! -f "$harness/scripts/vendor-claude-code.ts" ] && [ -n "${AGENT_HARNESS:-}" ]; then
  harness="$AGENT_HARNESS"
fi

state="${XDG_STATE_HOME:-$HOME/.local/state}/orchestrator-refresh"
log="$HOME/.claude/logs/orchestrator-refresh.log"
marker="$state/result"
attempted="$state/attempted"
lock="$state/lock"
version_file="$harness/vendor/claude-code/VERSION"

vendored_version() {
  awk 'NR == 1 && $1 == "claude-code" { print $2 }' "$version_file" 2>/dev/null
}

find_bun() {
  local candidate
  if command -v bun 2>/dev/null; then return 0; fi
  for candidate in "$HOME/.local/share/mise/shims/bun" "$HOME/.bun/bin/bun"; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

take_lock() {
  local pid
  if mkdir "$lock" 2>/dev/null; then
    printf '%s\n' "$$" > "$lock/pid"
    return 0
  fi
  pid="$(cat "$lock/pid" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    return 1
  fi
  rm -rf "$lock"
  mkdir "$lock" 2>/dev/null || return 1
  printf '%s\n' "$$" > "$lock/pid"
}

write_marker() {
  printf '%s\n' "$1" > "$marker.tmp" && mv "$marker.tmp" "$marker"
}

run_job() {
  local target="$1" old report bun changed conflicts mode
  export ORCHESTRATOR_REFRESH_JOB=1
  mkdir -p "$state"
  printf '=== %s refresh to Claude Code %s ===\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$target"
  if ! take_lock; then
    printf 'another refresh is running; skipping\n'
    return 0
  fi
  trap 'rm -rf "$lock"' EXIT
  old="$(vendored_version)"
  [ -n "$old" ] || old="unknown"
  report="$state/report.json"
  rm -f "$report"
  if ! bun="$(find_bun)"; then
    write_marker "Claude Code updated to $target, but bun was not found, so the vendored prompt was not refreshed; orchestrator still on $old. See $log."
    return 1
  fi
  cd "$harness" || return 1

  if "$bun" scripts/vendor-claude-code.ts --capture --report "$report"; then
    mode="$(jq -r '.mode // empty' "$report" 2>/dev/null)"
    changed="$(jq -r '[.changed[]? | sub("^[A-Z0-9]+\t"; "")] | join(", ")' "$report" 2>/dev/null)"
    if [ "$mode" = "plain" ]; then
      changed="not tracked (vendor/ is not a git clone)"
    elif [ -z "$changed" ]; then
      changed="nothing"
    fi
    if "$bun" scripts/build-orchestrator.ts; then
      write_marker "Claude Code updated to $target; upstream changed: $changed; orchestrator rebuilt."
    else
      write_marker "Claude Code updated to $target; upstream changed: $changed; vendor/main merged, but bun scripts/build-orchestrator.ts failed, so the orchestrator is still on $old. See $log."
    fi
  elif [ "$(jq -r '.merge // empty' "$report" 2>/dev/null)" = "conflict" ]; then
    conflicts="$(jq -r '.conflicts | join(", ")' "$report" 2>/dev/null)"
    write_marker "Claude Code updated to $target: merge conflict in vendor/main (${conflicts:-see log}) — resolve manually with git -C $harness/vendor merge upstream, then run bun scripts/build-orchestrator.ts; orchestrator still on $old."
  else
    write_marker "Claude Code updated to $target, but bun scripts/vendor-claude-code.ts --capture failed; orchestrator still on $old. See $log."
  fi
  printf '=== %s done ===\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

if [ "${1:-}" = "--job" ]; then
  run_job "${2:-unknown}"
  exit $?
fi

cat >/dev/null

if [ -f "$marker" ]; then
  message="$(cat "$marker" 2>/dev/null || true)"
  rm -f "$marker"
  if [ -n "$message" ]; then
    jq -n --arg ctx "$message" '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $ctx}}'
  fi
fi

current="$(claude --version 2>/dev/null | awk 'NR == 1 { print $1 }')"
[ -n "$current" ] || exit 0
[ "$current" != "$(vendored_version)" ] || exit 0
[ "$(cat "$attempted" 2>/dev/null)" != "$current" ] || exit 0

mkdir -p "$state" "$(dirname "$log")" 2>/dev/null || exit 0
printf '%s\n' "$current" > "$attempted"
nohup "$self" --job "$current" >> "$log" 2>&1 < /dev/null &

exit 0
