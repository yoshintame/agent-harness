#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { defineCommand, runMain } from 'citty'

const repoRoot = resolve(import.meta.dir, '..')
const vendorDir = join(repoRoot, 'vendor')
const systemPromptPath = join(vendorDir, 'claude-code', 'system-prompt.md')
const rulesPath = join(repoRoot, 'claude', 'orchestrator', 'rules.md')
const outPath = join(repoRoot, 'claude', 'agents', 'orchestrator.md')

const frontmatter = [
  '---',
  'name: orchestrator',
  'description: Main-session orchestrator — runs the conversation with the user, decides with them, records conclusions and delegates mechanical work to subagents. Selected via the `agent` setting or `claude --agent orchestrator`; not for delegation.',
  '---',
].join('\n')

function trimBlankLines(text: string): string {
  const lines = text.split('\n')
  while (lines.length > 0 && lines[0]!.trim() === '') lines.shift()
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop()
  return lines.join('\n')
}

function vendorBranch(): string | undefined {
  if (!existsSync(join(vendorDir, '.git'))) return undefined
  const result = Bun.spawnSync(['git', '-C', vendorDir, 'rev-parse', '--abbrev-ref', 'HEAD'], { stdout: 'pipe', stderr: 'pipe' })
  return result.exitCode === 0 ? result.stdout.toString().trim() : 'unknown'
}

const main = defineCommand({
  meta: {
    name: 'build-orchestrator',
    description: 'Build the gitignored claude/agents/orchestrator.md from the vendored system prompt and claude/orchestrator/rules.md',
  },
  run() {
    if (!existsSync(systemPromptPath)) {
      console.error(`missing ${relative(repoRoot, systemPromptPath)}: run \`bun scripts/vendor-claude-code.ts\` first`)
      process.exit(1)
    }
    const branch = vendorBranch()
    if (branch !== undefined && branch !== 'main') {
      console.error(`${relative(repoRoot, vendorDir)} is on ${branch}: the orchestrator is built from its main branch, switch back first`)
      process.exit(1)
    }
    const systemPrompt = trimBlankLines(readFileSync(systemPromptPath, 'utf8'))
    const rules = trimBlankLines(readFileSync(rulesPath, 'utf8'))
    const text = `${frontmatter}\n\n${systemPrompt}\n\n${rules}\n`
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, text)
    console.log(`wrote ${relative(repoRoot, outPath)} (${Buffer.byteLength(text)} bytes)`)
  },
})

await runMain(main)
