# agent-harness

Personal cross-provider skill package (Claude Code, Codex, Cursor), distributed
by APM. Source of truth is `.apm/skills/<name>/`. The trees under
`.claude/skills`, `.agents/skills`, `.cursor/skills` and `apm_modules` are
generated copies — never edit them.

## Before creating or changing any skill — mandatory

Invoke `/skill-dev` (via the Skill tool) and follow it. It owns editing the
canonical source, authoring content through `/create-skill`, and testing the
change as a global `dev-<name>` copy. This is required: the default agent habit
of editing a materialized copy, or installing the package globally to try a
change, corrupts this repo's source-of-truth and global state.

## Layout

The repo also holds the agent configuration of this Mac. Dotfiles only link it
into place through the `agent-harness` nixLink root; the originals live here.

- `apm.yml`, `.apm/skills/<name>/`, `.apm/prompts/` — the APM skill package.
- `shared/` — used by both Claude Code and Codex: `apm/` (global APM manifest
  and lock), `hooks/`, `tools/`.
- `claude/` — Claude Code only: `settings.json` (main session runs as the
  `orchestrator` agent), `agent.gitconfig`, `agents/` (`general-purpose`
  overrides the built-in default subagent), `orchestrator/rules.md`,
  `instructions/dev-profile.md`, `hooks/` (with `hooks/lib/`), `tools/`.
  There is no global `CLAUDE.md`: orchestrator rules live in its agent,
  executor rules in `general-purpose`.
- `codex/` — Codex only: `config.toml`, `rules/`, `instructions/AGENTS.md`
  (linked as `~/.codex/AGENTS.md`).
- `scripts/`, `tests/`, `package.json` — repo-level tooling and tests.

Vendor dirs (`claude/`, `codex/`, `shared/`) sit at the top. A script used by
one skill lives in that skill's `scripts/`; `tools/` is only for things shared by
several skills, hooks or services.

`vendor/claude-code/` is generated from local Claude Code session transcripts by
`bun scripts/vendor-claude-code.ts` (system prompt, built-in general-purpose
subagent prompt, `/code-review` and `/security-review` recipes, the built-in
`artifact-*` skill texts) for reference and diffing. `vendor/` is gitignored
because the texts are Anthropic's proprietary content: never commit them here.

On this Mac `vendor/` is a clone of the private `yoshintame/claude-code-vendor`
(vendor-branch scheme). Branch `upstream` holds one commit per Claude Code
version with the export as is; branch `main` — the checked-out one — holds my
edits to `claude-code/system-prompt.md`, made as ordinary commits. The script
writes the export onto `upstream` through a temporary worktree, commits
`upstream: Claude Code <version>` if anything changed and merges `upstream` into
`main`; on a conflict it aborts the merge, leaves `main` untouched and exits
non-zero — resolve with `git -C vendor merge upstream`. Without the clone (any
other install) the script just writes a plain upstream export into
`vendor/claude-code/`.

`scripts/build-orchestrator.ts` builds the gitignored `claude/agents/orchestrator.md`
from `vendor/claude-code/system-prompt.md` (the `main` branch when `vendor/` is a
clone) and `claude/orchestrator/rules.md`. The `SessionStart` hook
`claude/hooks/orchestrator-refresh.sh` notices a new `claude --version`, runs
`vendor-claude-code.ts --capture` and `build-orchestrator.ts` in the background
(log: `~/.claude/logs/orchestrator-refresh.log`) and reports the result in the
next session. After a rules change run `build-orchestrator.ts` by hand.
