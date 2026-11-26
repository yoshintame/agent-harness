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
  and lock), `instructions/AGENTS.md`, `hooks/`, `tools/`.
- `claude/` — Claude Code only: `settings.json`, `agent.gitconfig`, `agents/`,
  `instructions/dev-profile.md`, `hooks/` (with `hooks/lib/`), `tools/`.
- `codex/` — Codex only: `config.toml`, `rules/`.
- `scripts/`, `tests/`, `package.json` — repo-level tooling and tests.

Vendor dirs (`claude/`, `codex/`, `shared/`) sit at the top. A script used by
one skill lives in that skill's `scripts/`; `tools/` is only for things shared by
several skills, hooks or services.

`vendor/claude-code/` is generated from local Claude Code session transcripts by
`bun scripts/vendor-claude-code.ts` (system prompt, built-in general-purpose
subagent prompt, `/code-review` and `/security-review` recipes, the built-in
`artifact-*` skill texts) for reference and diffing. It is gitignored because the
texts are Anthropic's proprietary content: never commit them. Re-run the script after a Claude Code update.
`scripts/build-orchestrator.ts` builds the gitignored `claude/agents/orchestrator.md`
from the vendored system prompt and `claude/orchestrator/rules.md`; re-run both
after a Claude Code update or a rules change.
