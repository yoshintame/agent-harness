#!/usr/bin/env bun
import { existsSync, mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { defineCommand, runMain } from 'citty'
import { captureSystemPrompt } from './vendor/capture'
import { Collector, exportTo, type Found, nonInteractiveSystemPromptKey, scanTranscript, systemPromptKey } from './vendor/extract'
import { exportDir, GitError, installedVersion, isVendorClone } from './vendor/shared'
import { listTranscripts, readTranscript } from './vendor/transcripts'
import { gitSink, plainSink, preflight, type Report } from './vendor/vendor-branch'

export interface VendorOptions {
  projects?: string
  capture?: boolean
  dryRun?: boolean
  out?: string
}

export function collect(projects: string, version: string | undefined): Collector {
  const collector = new Collector(version)
  const files = listTranscripts(projects)
  for (const path of files) scanTranscript(readTranscript(path), collector)
  console.log(`scanned ${files.length} transcripts in ${projects} for Claude Code ${version ?? '(unknown)'}`)
  return collector
}

export async function vendorClaudeCode(options: VendorOptions = {}): Promise<Report> {
  const projects = resolve(options.projects ?? join(homedir(), '.claude', 'projects'))
  if (!existsSync(projects)) throw new Error(`no such directory: ${projects}`)
  const repo = !options.dryRun && isVendorClone()
  if (repo) preflight()
  const version = installedVersion()
  if (version === undefined) console.warn('warning: could not read `claude --version`; using the newest records of any version')
  const collector = collect(projects, version)

  const overrides = new Map<string, Found>()
  if (options.capture || ![systemPromptKey, nonInteractiveSystemPromptKey].some((key) => collector.has(key))) {
    overrides.set(systemPromptKey, captureSystemPrompt())
  }

  const exporter = (dir: string) => exportTo(dir, collector, overrides)
  if (repo) return gitSink(exporter)
  const dir = options.dryRun ? resolve(options.out ?? mkdtempSync(join(tmpdir(), 'vendor-claude-code-dry-run-'))) : exportDir
  return plainSink(dir, exporter)
}

const main = defineCommand({
  meta: {
    name: 'vendor-claude-code',
    description:
      'Vendor Claude Code prompt texts from local session transcripts into vendor/claude-code (gitignored); when vendor/ is a git clone, commit them to its upstream branch and merge into main',
  },
  args: {
    projects: {
      type: 'string',
      description: 'Claude Code projects directory with session transcripts',
      default: join(homedir(), '.claude', 'projects'),
    },
    capture: {
      type: 'boolean',
      description: 'Run a headless session without the custom agent to capture the current main-session system prompt',
      default: false,
    },
    'dry-run': {
      type: 'boolean',
      description: 'Write a plain export to --out (default: a new temp dir) and leave vendor/ untouched',
      default: false,
    },
    out: {
      type: 'string',
      description: 'Target directory of --dry-run',
    },
  },
  async run({ args }) {
    try {
      const report = await vendorClaudeCode({ projects: args.projects, capture: args.capture, dryRun: args['dry-run'], out: args.out })
      if (args['dry-run']) console.log(`dry run: wrote ${report.dir}`)
      if (report.merge === 'conflict') process.exit(1)
    } catch (error) {
      if (!(error instanceof GitError)) throw error
      console.error(error.message)
      process.exit(1)
    }
  },
})

if (import.meta.main) await runMain(main)
