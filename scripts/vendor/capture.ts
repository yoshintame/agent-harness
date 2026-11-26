import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Found, mainSessionPrompts } from './extract'
import { childEnv } from './shared'
import { readTranscript } from './transcripts'

const captureTimeoutMs = 180_000
const captureSettings = '{"agent":""}'
const capturePrompt = 'Reply OK. Do not call tools.'

function mangleProjectPath(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-')
}

function newestTranscript(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined
  return readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => ({ path: join(dir, name), mtime: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0]?.path
}

export function mainSessionModel(settingsPath = join(homedir(), '.claude', 'settings.json')): string | undefined {
  try {
    const model = JSON.parse(readFileSync(settingsPath, 'utf8'))?.model
    return typeof model === 'string' && model.trim() !== '' ? model.trim() : undefined
  } catch {
    return undefined
  }
}

export function captureCommand(model = mainSessionModel()): string[] {
  return ['claude', '-p', ...(model === undefined ? [] : ['--model', model]), '--settings', captureSettings, capturePrompt]
}

export function captureSession(): string {
  const projects = join(homedir(), '.claude', 'projects')
  const dir = mkdtempSync(join(tmpdir(), 'vendor-claude-code-'))
  try {
    const cwd = realpathSync(dir)
    const command = captureCommand()
    console.log(`capture: ${command.slice(0, -1).join(' ')}`)
    const result = Bun.spawnSync(command, {
      cwd,
      env: { ...process.env, ...childEnv },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: captureTimeoutMs,
    })
    if (result.exitCode !== 0) {
      const status = result.exitCode === null ? `killed by ${result.signalCode ?? 'a signal'}` : `exit ${result.exitCode}`
      const output = `${result.stderr.toString().trim()}\n${result.stdout.toString().trim()}`.trim()
      throw new Error(`capture session failed (${status}): ${output}`)
    }
    const candidates = [...new Set([cwd, dir])].map((path) => join(projects, mangleProjectPath(path)))
    for (const candidate of candidates) {
      const transcript = newestTranscript(candidate)
      if (transcript) return transcript
    }
    throw new Error(`capture session left no transcript in ${candidates.join(' or ')}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function captureSystemPrompt(): Found {
  const transcript = captureSession()
  console.log(`ran a capture session: ${transcript}`)
  const { interactive, other } = mainSessionPrompts(readTranscript(transcript))
  if (interactive) return interactive
  if (!other) throw new Error(`capture session transcript has no main-session system prompt: ${transcript}`)
  console.warn('warning: system-prompt.md: the capture session has no Agent and Skill tools, used its non-interactive prompt')
  return other
}
