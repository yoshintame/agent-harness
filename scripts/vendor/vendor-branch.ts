import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ExportResult, printExport } from './extract'
import { exportedVersion, exportSubdir, git, GitError, gitOk, mainBranch, nonEmptyLines, upstreamBranch, vendorDir, versionOf } from './shared'

export interface Report {
  mode: 'repo' | 'plain'
  dir: string
  version: string | undefined
  previous: string | undefined
  changed: string[]
  committed: boolean
  merge: 'clean' | 'up-to-date' | 'conflict' | 'none'
  conflicts: string[]
}

export type Exporter = (dir: string) => ExportResult

export function preflight(repo = vendorDir): void {
  const branch = gitOk(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
  if (branch !== mainBranch) throw new GitError(`${repo} is on ${branch}, expected ${mainBranch}; switch it back before vendoring`)
  if (git(repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).ok) throw new GitError(`${repo} has a merge in progress; finish or abort it first`)
  if (nonEmptyLines(gitOk(repo, ['status', '--porcelain', '--untracked-files=no'])).length > 0) {
    throw new GitError(`${repo} has uncommitted changes on ${mainBranch}; commit or discard them first`)
  }
  if (!git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${upstreamBranch}`]).ok) throw new GitError(`${repo} has no ${upstreamBranch} branch`)
  git(repo, ['worktree', 'prune'])
  const occupied = nonEmptyLines(gitOk(repo, ['worktree', 'list', '--porcelain'])).includes(`branch refs/heads/${upstreamBranch}`)
  if (occupied) throw new GitError(`${upstreamBranch} is checked out in another worktree of ${repo}; remove it first (git -C ${repo} worktree list)`)
}

export function plainSink(dir: string, exporter: Exporter): Report {
  const previous = exportedVersion(dir)
  const result = exporter(dir)
  printExport(result)
  return { mode: 'plain', dir, version: result.version, previous, changed: [], committed: false, merge: 'none', conflicts: [] }
}

export function gitSink(exporter: Exporter, repo = vendorDir): Report {
  preflight(repo)
  const previousVersion = git(repo, ['show', `${upstreamBranch}:${exportSubdir}/VERSION`])
  const report: Report = {
    mode: 'repo',
    dir: join(repo, exportSubdir),
    version: undefined,
    previous: previousVersion.ok ? versionOf(previousVersion.stdout) : undefined,
    changed: [],
    committed: false,
    merge: 'none',
    conflicts: [],
  }

  const tmp = mkdtempSync(join(tmpdir(), 'vendor-claude-code-upstream-'))
  const worktree = join(tmp, upstreamBranch)
  gitOk(repo, ['worktree', 'add', '--quiet', worktree, upstreamBranch])
  try {
    const result = exporter(join(worktree, exportSubdir))
    printExport(result)
    report.version = result.version
    gitOk(worktree, ['add', '-A', '--', exportSubdir])
    report.changed = nonEmptyLines(gitOk(worktree, ['diff', '--cached', '--name-status', '--', exportSubdir]))
    if (report.changed.length > 0) {
      gitOk(worktree, ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '--no-verify', '-m', `upstream: Claude Code ${report.version ?? 'unknown'}`])
      report.committed = true
    }
  } finally {
    git(repo, ['worktree', 'remove', '--force', worktree])
    rmSync(tmp, { recursive: true, force: true })
  }

  if (report.committed) {
    console.log(`committed to ${upstreamBranch} (${report.previous ?? 'unknown'} -> ${report.version ?? 'unknown'}):`)
    for (const line of report.changed) console.log(`  ${line}`)
  } else {
    console.log(`${upstreamBranch}: no changes against ${report.previous ?? 'the previous export'}`)
  }

  if (git(repo, ['merge-base', '--is-ancestor', upstreamBranch, 'HEAD']).ok) {
    report.merge = 'up-to-date'
    console.log(`${mainBranch}: already contains ${upstreamBranch}`)
    return report
  }

  const merge = git(repo, ['-c', 'commit.gpgsign=false', 'merge', '--no-edit', '--no-verify', upstreamBranch])
  if (!merge.ok) {
    report.merge = 'conflict'
    report.conflicts = nonEmptyLines(git(repo, ['diff', '--name-only', '--diff-filter=U']).stdout)
    git(repo, ['merge', '--abort'])
    console.error(`merge of ${upstreamBranch} into ${mainBranch} stopped on a conflict and was aborted; ${mainBranch} is unchanged`)
    for (const path of report.conflicts) console.error(`  conflict: ${path}`)
    if (report.conflicts.length === 0 && merge.stderr) console.error(merge.stderr)
    console.error(`resolve by hand: git -C ${repo} merge ${upstreamBranch}`)
    return report
  }
  report.merge = 'clean'
  console.log(`merged ${upstreamBranch} into ${mainBranch} cleanly:`)
  for (const path of nonEmptyLines(gitOk(repo, ['diff', '--name-only', 'ORIG_HEAD', 'HEAD']))) console.log(`  ${path}`)
  return report
}
