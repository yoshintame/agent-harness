# shellcheck shell=bash
# Shared glue for the Claude Code session hardlink router.
# Sourced by worktree-create.sh / session-start.sh.

_cc_self="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || realpath "${BASH_SOURCE[0]}" 2>/dev/null || printf '%s' "${BASH_SOURCE[0]}")"
_CC_LINKER="$(dirname "$_cc_self")/../../tools/link-session/src/cli.ts"
[ -f "$_CC_LINKER" ] || [ -z "${AGENT_HARNESS:-}" ] || _CC_LINKER="$AGENT_HARNESS/claude/tools/link-session/src/cli.ts"
_CC_LOG="$HOME/.claude/logs/link-session.hook.log"

_cc_ensure_logdir() {
  mkdir -p "$HOME/.claude/logs" 2>/dev/null || true
}

_cc_log() {
  _cc_ensure_logdir
  printf '%s cc-link: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$_CC_LOG" 2>/dev/null || true
}

_cc_bun() {
  if command -v bun >/dev/null 2>&1; then command -v bun; return 0; fi
  if [ -x "$HOME/.local/share/mise/shims/bun" ]; then printf '%s' "$HOME/.local/share/mise/shims/bun"; return 0; fi
  return 1
}

# cc_link_session <session-id> <src-cwd> <dst-cwd> [extra cli args...]
cc_link_session() {
  local bun
  bun="$(_cc_bun)" || { _cc_log "bun-not-found (link $1)"; return 0; }
  [ -f "$_CC_LINKER" ] || { _cc_log "linker-missing $_CC_LINKER"; return 0; }
  _cc_ensure_logdir
  "$bun" "$_CC_LINKER" link "$@" >/dev/null 2>>"$_CC_LOG" || _cc_log "link-failed: $*"
  return 0
}
