import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const repoRoot = resolve(import.meta.dir, '..', '..')
export const vendorDir = join(repoRoot, 'vendor')
export const exportSubdir = 'claude-code'
export const exportDir = join(vendorDir, exportSubdir)
export const upstreamBranch = 'upstream'
export const mainBranch = 'main'
export const orchestratorSentinel = '<!-- agent-harness:orchestrator -->'
export const legacyOrchestratorMarker = '# Правила оркестратора'
export const childEnv = { AGENT_HARNESS_CHILD: '1' }

export class GitError extends Error {}

export interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
}

export function git(cwd: string, args: string[]): GitResult {
  const result = Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' })
  return { ok: result.exitCode === 0, stdout: result.stdout.toString(), stderr: result.stderr.toString().trim() }
}

export function gitOk(cwd: string, args: string[]): string {
  const result = git(cwd, args)
  if (!result.ok) throw new GitError(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`)
  return result.stdout
}

export function isVendorClone(): boolean {
  return existsSync(join(vendorDir, '.git'))
}

export function vendorBranch(): string | undefined {
  if (!isVendorClone()) return undefined
  const result = git(vendorDir, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return result.ok ? result.stdout.trim() : 'unknown'
}

export function nonEmptyLines(text: string): string[] {
  return text.split('\n').filter((line) => line.trim() !== '')
}

export function versionOf(text: string | undefined): string | undefined {
  return text?.match(/^claude-code (\S+)/)?.[1]
}

export function exportedVersion(dir = exportDir): string | undefined {
  const path = join(dir, 'VERSION')
  return existsSync(path) ? versionOf(readFileSync(path, 'utf8')) : undefined
}

export function compareVersions(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0
  if (a === undefined) return -1
  if (b === undefined) return 1
  const left = a.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const right = b.split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

export function installedVersion(): string | undefined {
  try {
    const result = Bun.spawnSync(['claude', '--version'], { stdout: 'pipe', stderr: 'pipe' })
    if (result.exitCode !== 0) return undefined
    return result.stdout.toString().trim().split(/\s+/)[0] || undefined
  } catch {
    return undefined
  }
}
