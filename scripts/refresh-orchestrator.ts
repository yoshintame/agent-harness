#!/usr/bin/env bun
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defineCommand, runMain } from 'citty'
import { buildOrchestrator } from './build-orchestrator'
import { vendorClaudeCode } from './vendor-claude-code'
import { exportedVersion, installedVersion, isVendorClone, mainBranch, upstreamBranch, vendorDir } from './vendor/shared'
import { preflight, type Report } from './vendor/vendor-branch'

export const stateDir = join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'orchestrator-refresh')
export const logPath = join(homedir(), '.claude', 'logs', 'orchestrator-refresh.log')
const staleLockMs = 15 * 60_000

export interface Marker {
  version: string
  message: string
  error?: string
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, path)
}

export function writeMarker(state: string, marker: Marker): void {
  mkdirSync(state, { recursive: true })
  atomicWrite(join(state, 'result.json'), JSON.stringify(marker) + '\n')
}

export function takeLock(lockDir: string, staleMs = staleLockMs): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lockDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let age: number
      try {
        age = Date.now() - statSync(lockDir).mtimeMs
      } catch {
        continue
      }
      if (age < staleMs) return false
      const stale = `${lockDir}.stale.${process.pid}.${Date.now()}`
      try {
        renameSync(lockDir, stale)
      } catch {
        return false
      }
      rmSync(stale, { recursive: true, force: true })
      continue
    }
    atomicWrite(join(lockDir, 'pid'), `${process.pid}\n`)
    return true
  }
  return false
}

export function releaseLock(lockDir: string): void {
  let owner: string | undefined
  try {
    owner = readFileSync(join(lockDir, 'pid'), 'utf8').trim()
  } catch {
    return
  }
  if (owner === String(process.pid)) rmSync(lockDir, { recursive: true, force: true })
}

function changeSummary(report: Report): string {
  if (report.mode === 'plain') return 'vendor/claude-code re-exported (vendor/ is not a git clone, so upstream changes are not tracked)'
  const files = report.changed.map((line) => line.replace(/^[A-Z0-9]+\t/, '')).join(', ')
  return `vendor ${upstreamBranch} changed: ${files || 'nothing'}; merged into vendor/${mainBranch}`
}

export async function refresh(): Promise<Marker> {
  const target = installedVersion() ?? 'unknown'
  const old = exportedVersion() ?? 'unknown'
  const still = `the orchestrator is still on ${old}`

  if (isVendorClone()) {
    try {
      preflight()
    } catch (error) {
      return {
        version: target,
        message: `Claude Code updated to ${target}, but vendor/ is not ready for a refresh, so nothing was captured and ${still}. Fix it, then run bun scripts/refresh-orchestrator.ts.`,
        error: errorText(error),
      }
    }
  }

  let report: Report
  try {
    report = await vendorClaudeCode({ capture: true })
  } catch (error) {
    return {
      version: target,
      message: `Claude Code updated to ${target}, but bun scripts/vendor-claude-code.ts --capture failed, so ${still}. See ${logPath}.`,
      error: errorText(error),
    }
  }

  if (report.merge === 'conflict') {
    return {
      version: target,
      message: `Claude Code updated to ${target}: merging vendor ${upstreamBranch} into ${mainBranch} stopped on a conflict (${report.conflicts.join(', ') || 'see the log'}) and was aborted. Resolve with git -C ${vendorDir} merge ${upstreamBranch}, then run bun scripts/build-orchestrator.ts; ${still}.`,
    }
  }

  const summary = changeSummary(report)
  try {
    buildOrchestrator()
  } catch (error) {
    return {
      version: target,
      message: `Claude Code updated to ${target}; ${summary}; but bun scripts/build-orchestrator.ts failed, so ${still}. See ${logPath}.`,
      error: errorText(error),
    }
  }
  return { version: target, message: `Claude Code updated to ${target}; ${summary}; orchestrator rebuilt.` }
}

const main = defineCommand({
  meta: {
    name: 'refresh-orchestrator',
    description: 'Capture the new Claude Code system prompt, merge it into vendor/ and rebuild the orchestrator; leave a result marker for the next session',
  },
  async run() {
    mkdirSync(stateDir, { recursive: true })
    const lockDir = join(stateDir, 'lock')
    console.log(`=== ${new Date().toISOString()} orchestrator refresh ===`)
    if (!takeLock(lockDir)) {
      console.log('another refresh is running; skipping')
      return
    }
    try {
      const marker = await refresh()
      writeMarker(stateDir, marker)
      console.log(marker.message)
      if (marker.error) console.error(`error: ${marker.error}`)
    } finally {
      releaseLock(lockDir)
      console.log(`=== ${new Date().toISOString()} done ===`)
    }
  },
})

if (import.meta.main) await runMain(main)
