---
name: artifact
description: Publish a page as a claude.ai Artifact.
---

The built-in `Artifact` tool is disabled in this session. Publish through `artifact-publish`: it runs a narrow headless child session that has the tool and does nothing but publish your file.

An Artifact is a private web page on claude.ai, up to 16MB, that the user opens in a browser. Make one for anything to look at or use rather than read in the terminal: a diagram, a comparison table, a report for someone else, an interactive tool.

## Author

1. Read `$AGENT_HARNESS/vendor/claude-code/skills/artifact-design.md` — the built-in page contract and design guidance. If it is missing, run `bun $AGENT_HARNESS/scripts/vendor-claude-code.ts` and read it then.
2. Write one self-contained `.html` file in the session scratchpad following it. Publish Markdown only when another skill tells you to.

## Publish

Write a spec next to the page and run, with `dangerouslyDisableSandbox: true` (the child needs the network and `~/.claude`):

```bash
~/.claude/skills/artifact/scripts/artifact-publish <scratchpad>/spec.json
```

```json
{
  "file": "/abs/path/index.html",
  "title": "Release checklist",
  "icon": "checklist",
  "description": "One sentence for the gallery card.",
  "files": { "data.json": "/abs/path/data.json" }
}
```

- `file` — required, absolute.
- `icon` — one generic word (`chart`, `map`, `code`), never a brand; required on the first publish, omit it on updates.
- `title`, `description` — optional; keep `title` the same across updates.
- `files` — supporting files: published path (as the HTML references it) → absolute source path.
- `url` — an existing artifact to update in place. Updating is the same spec plus `url`.

stdout is only the artifact URL; give it to the user. On failure the script exits non-zero and prints the child's output. `--dry-run` prints the child command without running it.

The user can open and list their artifacts with `/artifacts` in the terminal.
