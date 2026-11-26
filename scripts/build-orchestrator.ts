#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { defineCommand, runMain } from 'citty'
import { exportDir, mainBranch, orchestratorSentinel, repoRoot, vendorBranch, vendorDir } from './vendor/shared'

const systemPromptPath = join(exportDir, 'system-prompt.md')
const rulesPath = join(repoRoot, 'claude', 'orchestrator', 'rules.md')
export const orchestratorPath = join(repoRoot, 'claude', 'agents', 'orchestrator.md')

const frontmatter = [
  '---',
  'name: orchestrator',
  'description: Main-session orchestrator — runs the conversation with the user, decides with them, records conclusions and delegates mechanical work to subagents. Selected via the `agent` setting or `claude --agent orchestrator`; not for delegation.',
  '---',
].join('\n')

export class BuildError extends Error {}

function trimBlankLines(text: string): string {
  const lines = text.split('\n')
  while (lines.length > 0 && lines[0]!.trim() === '') lines.shift()
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop()
  return lines.join('\n')
}

export function buildOrchestrator(): { path: string; bytes: number } {
  if (!existsSync(systemPromptPath)) {
    throw new BuildError(`missing ${relative(repoRoot, systemPromptPath)}: run \`bun scripts/vendor-claude-code.ts\` first`)
  }
  const branch = vendorBranch()
  if (branch !== undefined && branch !== mainBranch) {
    throw new BuildError(`${relative(repoRoot, vendorDir)} is on ${branch}: the orchestrator is built from its ${mainBranch} branch, switch back first`)
  }
  const systemPrompt = trimBlankLines(readFileSync(systemPromptPath, 'utf8'))
  const rules = trimBlankLines(readFileSync(rulesPath, 'utf8'))
  const text = `${frontmatter}\n\n${orchestratorSentinel}\n\n${systemPrompt}\n\n${rules}\n`
  mkdirSync(dirname(orchestratorPath), { recursive: true })
  writeFileSync(orchestratorPath, text)
  const bytes = Buffer.byteLength(text)
  console.log(`wrote ${relative(repoRoot, orchestratorPath)} (${bytes} bytes)`)
  return { path: orchestratorPath, bytes }
}

const main = defineCommand({
  meta: {
    name: 'build-orchestrator',
    description: 'Build the gitignored claude/agents/orchestrator.md from the vendored system prompt and claude/orchestrator/rules.md',
  },
  run() {
    try {
      buildOrchestrator()
    } catch (error) {
      if (!(error instanceof BuildError)) throw error
      console.error(error.message)
      process.exit(1)
    }
  },
})

if (import.meta.main) await runMain(main)
