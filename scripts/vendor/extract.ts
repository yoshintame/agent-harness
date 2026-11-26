import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { compareVersions, legacyOrchestratorMarker, orchestratorSentinel } from './shared'
import { readMeta, toolResults, type Transcript, type UserRecord } from './transcripts'

export const expectedCodeReviewLevels = ['minimal', 'low', 'high', 'xhigh', 'max']
export const builtinSkills = ['artifact-design', 'artifact-capabilities', 'artifact-diagramming']
export const systemPromptKey = 'system-prompt'
export const nonInteractiveSystemPromptKey = 'system-prompt:non-interactive'
const gpPrefix = 'You are an agent for Claude Code'
const securityTail = '\nReview the complete diff above.'
const quickstartDesignMarker = '## Page contract'
const quickstartDesignTail = /\n+\[Design systems [^\n]*\]\s*$/

export interface Found {
  version: string | undefined
  path: string
  text: string
}

export interface Picked {
  found: Found
  exact: boolean
}

export class Collector {
  private readonly candidates = new Map<string, Found[]>()
  constructor(readonly version: string | undefined) {}

  offer(key: string, found: Found): void {
    const list = this.candidates.get(key) ?? []
    list.push(found)
    this.candidates.set(key, list)
  }

  keys(): string[] {
    return [...this.candidates.keys()]
  }

  has(key: string): boolean {
    return this.exact(key) !== undefined
  }

  exact(key: string): Found | undefined {
    if (this.version === undefined) return undefined
    return this.candidates.get(key)?.find((found) => found.version === this.version)
  }

  pick(key: string): Picked | undefined {
    const exact = this.exact(key)
    if (exact) return { found: exact, exact: true }
    let best: Found | undefined
    for (const found of this.candidates.get(key) ?? []) {
      if (best === undefined || compareVersions(found.version, best.version) > 0) best = found
    }
    return best ? { found: best, exact: false } : undefined
  }
}

function stripTotalTokens(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/<total_tokens>.*<\/total_tokens>/.test(line))
    .join('\n')
}

function isOrchestratorPrompt(text: string): boolean {
  return text.includes(orchestratorSentinel) || text.includes(legacyOrchestratorMarker)
}

export function parseRecipe(text: string): { level: string; recipe: string } | undefined {
  const lines = text.split('\n')
  let index = 0
  if (lines[0]?.startsWith('Review target:')) index = 1
  while (index < lines.length && lines[index]!.trim() === '') index++
  const match = lines[index]?.trim().match(/^`(\S+) (?:effort|prompt) → .+`$/)
  if (!match) return undefined
  return { level: match[1]!, recipe: lines.slice(index).join('\n').trimEnd() + '\n' }
}

export function scrubSecurityPrompt(text: string): string | undefined {
  const tail = text.indexOf(securityTail)
  if (tail < 0) return undefined
  const head = text.slice(0, tail)
  const labels = [...head.matchAll(/\n\n([A-Z][A-Z ]+):\n\n```\n/g)]
  if (labels.length === 0) return undefined
  const intro = head.slice(0, labels[0]!.index)
  const sections = labels.map((label) => `${label[1]}:\n\n\`\`\`\n<${label[1]!.toLowerCase()}>\n\`\`\``)
  return `${intro}\n\n${sections.join('\n\n')}\n${text.slice(tail)}`.trimEnd() + '\n'
}

export function skillBody(text: string): string | undefined {
  const body = text.replace(/^Base directory for this skill: [^\n]*\n+/, '').trimEnd()
  if (body === '' || body.startsWith('Launching skill:')) return undefined
  return body + '\n'
}

export function quickstartDesign(text: string): string | undefined {
  const start = text.indexOf(quickstartDesignMarker)
  if (start < 0) return undefined
  return text.slice(start).replace(quickstartDesignTail, '').trimEnd() + '\n'
}

export function mainSessionPrompts(transcript: Transcript): { interactive?: Found; other?: Found } {
  let interactive: Found | undefined
  let other: Found | undefined
  for (const record of transcript.records) {
    if (record.kind !== 'shape' || record.system.length < 2) continue
    const joined = record.system.slice(1).join('\n\n')
    if (isOrchestratorPrompt(joined)) continue
    const found = { version: record.version, path: transcript.path, text: stripTotalTokens(joined).trimEnd() + '\n' }
    if (record.tools.has('Agent') && record.tools.has('Skill')) interactive = found
    else other = found
  }
  return { interactive, other }
}

function scanMain(transcript: Transcript, collector: Collector): void {
  const { interactive, other } = mainSessionPrompts(transcript)
  if (interactive) collector.offer(systemPromptKey, interactive)
  if (other) collector.offer(nonInteractiveSystemPromptKey, other)
}

function scanSubagent(transcript: Transcript, collector: Collector): void {
  const meta = readMeta(transcript.path)
  if (meta?.agentType !== 'general-purpose') return
  if (meta.description == null) {
    const first = transcript.records.find((record): record is UserRecord => record.kind === 'user')
    const recipe = typeof first?.content === 'string' ? parseRecipe(first.content) : undefined
    if (recipe) collector.offer(`code-review/${recipe.level}`, { version: first!.version, path: transcript.path, text: recipe.recipe })
    return
  }
  let gp: Found | undefined
  for (const record of transcript.records) {
    if (record.kind === 'shape' && record.system[1]?.startsWith(gpPrefix)) {
      gp = { version: record.version, path: transcript.path, text: record.system[1].trimEnd() + '\n' }
    }
  }
  if (gp) collector.offer('general-purpose', gp)
}

function scanSecurityReview(transcript: Transcript, collector: Collector): void {
  const results = toolResults(transcript.records, (use) => use.name === 'Skill' && use.input.skill === 'security-review')
  for (const result of results) {
    const text = scrubSecurityPrompt(result.text)
    if (text) collector.offer('security-review/prompt', { version: result.version, path: transcript.path, text })
  }
}

function scanBuiltinSkills(transcript: Transcript, collector: Collector): void {
  const results = toolResults(
    transcript.records,
    (use) =>
      (use.name === 'Skill' && builtinSkills.includes(use.input.skill as string)) ||
      (use.name === 'Artifact' && use.input.action === 'quickstart'),
  )
  for (const result of results) {
    const quickstart = result.use.name === 'Artifact'
    const text = quickstart ? quickstartDesign(result.text) : skillBody(result.text)
    const key = quickstart ? 'artifact-design' : (result.use.input.skill as string)
    if (text) collector.offer(key, { version: result.version, path: transcript.path, text })
  }
}

export function scanTranscript(transcript: Transcript, collector: Collector): void {
  if (transcript.path.includes(`${sep}subagents${sep}`)) scanSubagent(transcript, collector)
  else scanMain(transcript, collector)
  scanSecurityReview(transcript, collector)
  scanBuiltinSkills(transcript, collector)
}

export interface ExportEntry {
  keys: string[]
  file: string
  required: boolean
}

export interface ExportResult {
  version: string | undefined
  warnings: string[]
  missing: string[]
  sources: string[]
}

export function exportTable(collector: Collector): ExportEntry[] {
  const levels = [
    ...new Set([
      ...collector
        .keys()
        .filter((key) => key.startsWith('code-review/'))
        .map((key) => key.slice('code-review/'.length)),
      ...expectedCodeReviewLevels,
    ]),
  ].sort()
  return [
    { keys: [systemPromptKey, nonInteractiveSystemPromptKey], file: 'system-prompt.md', required: true },
    { keys: ['general-purpose'], file: 'general-purpose.md', required: true },
    ...levels.map((level) => ({
      keys: [`code-review/${level}`],
      file: `skills/code-review/${level}.md`,
      required: expectedCodeReviewLevels.includes(level),
    })),
    { keys: ['security-review/prompt'], file: 'skills/security-review/prompt.md', required: true },
    ...builtinSkills.map((name) => ({ keys: [name], file: `skills/${name}.md`, required: true })),
  ]
}

function pickEntry(collector: Collector, keys: string[]): (Picked & { key: string }) | undefined {
  for (const key of keys) {
    const found = collector.exact(key)
    if (found) return { key, found, exact: true }
  }
  for (const key of keys) {
    const picked = collector.pick(key)
    if (picked) return { key, ...picked }
  }
  return undefined
}

export function exportTo(dir: string, collector: Collector, overrides: Map<string, Found> = new Map()): ExportResult {
  const version = collector.version
  const result: ExportResult = { version, warnings: [], missing: [], sources: [] }
  const versions: string[] = []
  rmSync(dir, { recursive: true, force: true })
  console.log(`writing ${dir}/`)

  for (const entry of exportTable(collector)) {
    const override = overrides.get(entry.keys[0]!)
    const picked = override ? { key: entry.keys[0]!, found: override, exact: true } : pickEntry(collector, entry.keys)
    if (!picked) {
      if (entry.required) result.missing.push(entry.file)
      continue
    }
    const { found } = picked
    if (!picked.exact) {
      result.warnings.push(`${entry.file}: no record for ${version ?? 'the installed version'}, used ${found.version ?? 'unknown version'}`)
    }
    if (picked.key !== entry.keys[0]) result.warnings.push(`${entry.file}: no record under ${entry.keys[0]}, used ${picked.key}`)
    result.sources.push(`${entry.file}\t${found.version ?? 'unknown'}\t${found.path}`)
    versions.push(`${entry.file}\t${found.version ?? 'unknown'}`)
    write(dir, entry.file, found.text)
  }

  write(dir, 'VERSION', [`claude-code ${version ?? 'unknown'}`, '', ...versions, ''].join('\n'))
  return result
}

function write(dir: string, relPath: string, text: string): void {
  const target = join(dir, relPath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, text)
  console.log(`  ${relPath} (${Buffer.byteLength(text)} bytes)`)
}

export function printExport(result: ExportResult): void {
  console.log('sources:')
  for (const source of result.sources) console.log(`  ${source}`)
  for (const warning of result.warnings) console.warn(`warning: ${warning}`)
  if (result.missing.length > 0) {
    console.log('not found:')
    for (const item of result.missing) console.log(`  ${item}`)
  }
}
