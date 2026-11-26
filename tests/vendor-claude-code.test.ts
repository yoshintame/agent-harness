import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Collector, exportTable, parseRecipe, scanTranscript } from '../scripts/vendor/extract'
import { readTranscript } from '../scripts/vendor/transcripts'
import { preflight } from '../scripts/vendor/vendor-branch'

const fixtures = resolve(import.meta.dir, 'fixtures', 'vendor-claude-code')
const projects = join(fixtures, 'projects')
const mainTranscript = join(projects, '-proj-main', 'main.jsonl')
const subagents = join(projects, '-proj-main', 's1', 'subagents')
const cli = resolve(import.meta.dir, '..', 'scripts', 'vendor-claude-code.ts')

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'vendor-claude-code-test-'))
})

afterEach(() => {
  rmSync(tmp, { force: true, recursive: true })
})

function scan(...paths: string[]): Collector {
  const collector = new Collector('2.1.322')
  for (const path of paths) scanTranscript(readTranscript(path), collector)
  return collector
}

test('main-session prompt skips orchestrator prompts and splits interactive from headless', () => {
  const collector = scan(mainTranscript)
  expect(collector.pick('system-prompt')?.found.text).toBe('You are the main prompt.\n\nSecond block.\nTail line.\n')
  expect(collector.pick('system-prompt:non-interactive')?.found.text).toBe('Headless prompt.\n')
})

test('general-purpose prompt comes from a described general-purpose subagent', () => {
  const collector = scan(join(subagents, 'agent-gp.jsonl'), join(subagents, 'agent-review-minimal.jsonl'))
  expect(collector.pick('general-purpose')?.found.text).toBe("You are an agent for Claude Code, Anthropic's official CLI.\n\nDo the task.\n")
})

test('code-review recipes are keyed by their level, including minimal', () => {
  expect(parseRecipe('`minimal prompt → single pass → ≤15 findings`\n\nBody')?.level).toBe('minimal')
  const collector = scan(join(subagents, 'agent-review-minimal.jsonl'), join(subagents, 'agent-review-high.jsonl'), join(subagents, 'agent-gp.jsonl'))
  expect(collector.pick('code-review/minimal')?.found.text).toBe(
    '`minimal prompt → single careful diff pass → ≤15 findings`\n\nYou are reviewing a pull request.\n',
  )
  expect(collector.pick('code-review/high')).toMatchObject({ exact: false, found: { version: '2.1.280' } })
  expect(collector.keys().filter((key) => key.startsWith('code-review/')).sort()).toEqual(['code-review/high', 'code-review/minimal'])
})

test('security-review prompt has its live sections replaced by placeholders', () => {
  expect(scan(mainTranscript).pick('security-review/prompt')?.found.text).toBe(
    [
      'You are a senior security engineer.',
      '',
      'GIT STATUS:',
      '',
      '```',
      '<git status>',
      '```',
      '',
      'DIFF CONTENT:',
      '',
      '```',
      '<diff content>',
      '```',
      '',
      'Review the complete diff above. This contains all code changes.',
      '',
      'OBJECTIVE:',
      'Find bugs.',
      '',
    ].join('\n'),
  )
})

test('artifact-design comes from the Skill result and from the Artifact quickstart', () => {
  expect(scan(mainTranscript).pick('artifact-design')?.found.text).toBe('## Page contract\n\nDesign from the skill.\n')
  expect(scan(join(fixtures, 'quickstart', '-proj-qs', 'qs.jsonl')).pick('artifact-design')?.found.text).toBe(
    '## Page contract\n\nDesign from quickstart.\n',
  )
})

test('pick prefers the installed version, else the highest one', () => {
  const collector = new Collector('2.1.322')
  collector.offer('k', { version: '2.1.9', path: 'a', text: 'a' })
  collector.offer('k', { version: '2.1.300', path: 'b', text: 'b' })
  collector.offer('k', { version: '2.1.40', path: 'c', text: 'c' })
  expect(collector.pick('k')).toMatchObject({ exact: false, found: { path: 'b' } })
  collector.offer('k', { version: '2.1.322', path: 'd', text: 'd' })
  collector.offer('k', { version: '2.1.322', path: 'e', text: 'e' })
  expect(collector.pick('k')).toMatchObject({ exact: true, found: { path: 'd' } })
})

test('export table requires every expected code-review level', () => {
  const files = exportTable(new Collector('2.1.322'))
    .filter((entry) => entry.required)
    .map((entry) => entry.file)
  expect(files).toEqual([
    'system-prompt.md',
    'general-purpose.md',
    'skills/code-review/high.md',
    'skills/code-review/low.md',
    'skills/code-review/max.md',
    'skills/code-review/minimal.md',
    'skills/code-review/xhigh.md',
    'skills/security-review/prompt.md',
    'skills/artifact-design.md',
    'skills/artifact-capabilities.md',
    'skills/artifact-diagramming.md',
  ])
})

test('dry run writes a plain export without touching vendor/', () => {
  const bin = join(tmp, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\n[ "$1" = --version ] && echo "2.1.322 (Claude Code)" && exit 0\nexit 3\n')
  chmodSync(join(bin, 'claude'), 0o755)
  const out = join(tmp, 'out')
  const result = Bun.spawnSync(['bun', cli, '--dry-run', '--projects', projects, '--out', out], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(result.exitCode).toBe(0)
  expect(readFileSync(join(out, 'system-prompt.md'), 'utf8')).toBe('You are the main prompt.\n\nSecond block.\nTail line.\n')
  expect(readFileSync(join(out, 'VERSION'), 'utf8')).toBe(
    [
      'claude-code 2.1.322',
      '',
      'system-prompt.md\t2.1.322',
      'general-purpose.md\t2.1.322',
      'skills/code-review/high.md\t2.1.280',
      'skills/code-review/minimal.md\t2.1.322',
      'skills/security-review/prompt.md\t2.1.322',
      'skills/artifact-design.md\t2.1.322',
      '',
    ].join('\n'),
  )
})

test('preflight refuses an upstream branch checked out in another worktree', () => {
  const repo = join(tmp, 'repo')
  const git = (...args: string[]) => Bun.spawnSync(['git', '-C', repo, ...args], { stdout: 'pipe', stderr: 'pipe' })
  mkdirSync(repo)
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a'), 'a\n')
  git('add', 'a')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', 'a')
  git('branch', 'upstream')
  expect(() => preflight(repo)).not.toThrow()
  git('worktree', 'add', '-q', join(tmp, 'wt'), 'upstream')
  expect(() => preflight(repo)).toThrow(/checked out in another worktree/)
})
