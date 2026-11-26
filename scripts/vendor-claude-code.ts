#!/usr/bin/env bun
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { defineCommand, runMain } from 'citty'

const repoRoot = resolve(import.meta.dir, '..')
const outDir = join(repoRoot, 'vendor', 'claude-code')
const expectedCodeReviewLevels = ['low', 'medium', 'high', 'xhigh', 'max']
const gpPrefix = 'You are an agent for Claude Code'
const securityTail = '\nReview the complete diff above.'
const builtinSkills = ['artifact-design', 'artifact-capabilities', 'artifact-diagramming']
const quickstartDesignMarker = '## Page contract'
const quickstartDesignTail = /\n+\[Design systems [^\n]*\]\s*$/

interface Found {
  version: string | undefined
  path: string
  text: string
}

interface Slot {
  exact?: Found
  fallback?: Found
}

interface ShapeRecord {
  type: 'api-request-shape'
  version?: string
  shape?: { system?: { text?: string }[]; tools?: { name?: string }[] }
}

interface Meta {
  agentType?: string
  description?: string | null
}

class Collector {
  readonly slots = new Map<string, Slot>()
  constructor(private readonly version: string | undefined) {}

  offer(key: string, found: Found): void {
    const slot = this.slots.get(key) ?? {}
    if (this.version !== undefined && found.version === this.version) slot.exact ??= found
    else slot.fallback ??= found
    this.slots.set(key, slot)
  }

  has(key: string): boolean {
    return this.slots.get(key)?.exact !== undefined
  }

  pick(key: string): { found: Found; exact: boolean } | undefined {
    const slot = this.slots.get(key)
    if (slot?.exact) return { found: slot.exact, exact: true }
    if (slot?.fallback) return { found: slot.fallback, exact: false }
    return undefined
  }
}

class NewestCollector {
  readonly picks = new Map<string, Found>()

  offer(key: string, found: Found): void {
    const current = this.picks.get(key)
    if (current === undefined || compareVersions(found.version, current.version) > 0) this.picks.set(key, found)
  }
}

function compareVersions(a: string | undefined, b: string | undefined): number {
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

function installedVersion(): string | undefined {
  try {
    const result = Bun.spawnSync(['claude', '--version'])
    if (result.exitCode !== 0) return undefined
    return result.stdout.toString().trim().split(/\s+/)[0] || undefined
  } catch {
    return undefined
  }
}

function listTranscripts(root: string): string[] {
  const files: { path: string; mtime: number }[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push({ path, mtime: statSync(path).mtimeMs })
    }
  }
  walk(root)
  return files.sort((a, b) => b.mtime - a.mtime).map((file) => file.path)
}

function parse(line: string): any {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

function contentText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const texts = content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text)
  return texts.length > 0 ? texts.join('\n') : undefined
}

function stripTotalTokens(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/<total_tokens>.*<\/total_tokens>/.test(line))
    .join('\n')
}

function readMeta(path: string): Meta | undefined {
  const metaPath = path.replace(/\.jsonl$/, '.meta.json')
  if (!existsSync(metaPath)) return undefined
  return parse(readFileSync(metaPath, 'utf8'))
}

function parseRecipe(text: string): { level: string; recipe: string } | undefined {
  const lines = text.split('\n')
  let index = 0
  if (lines[0]?.startsWith('Review target:')) index = 1
  while (index < lines.length && lines[index]!.trim() === '') index++
  const match = lines[index]?.trim().match(/^`(\S+) (?:effort|prompt) → .+`$/)
  if (!match) return undefined
  return { level: match[1]!, recipe: lines.slice(index).join('\n').trimEnd() + '\n' }
}

function scrubSecurityPrompt(text: string): string | undefined {
  const tail = text.indexOf(securityTail)
  if (tail < 0) return undefined
  const head = text.slice(0, tail)
  const labels = [...head.matchAll(/\n\n([A-Z][A-Z ]+):\n\n```\n/g)]
  if (labels.length === 0) return undefined
  const intro = head.slice(0, labels[0]!.index)
  const sections = labels.map((label) => `${label[1]}:\n\n\`\`\`\n<${label[1]!.toLowerCase()}>\n\`\`\``)
  return `${intro}\n\n${sections.join('\n\n')}\n${text.slice(tail)}`.trimEnd() + '\n'
}

function scanMain(path: string, lines: string[], collector: Collector): void {
  let interactive: Found | undefined
  let other: Found | undefined
  for (const line of lines) {
    if (!line.includes('"api-request-shape"')) continue
    const record = parse(line) as ShapeRecord | undefined
    if (record?.type !== 'api-request-shape') continue
    const blocks = record.shape?.system ?? []
    if (blocks.length < 2) continue
    const text = stripTotalTokens(blocks.slice(1).map((block) => block.text ?? '').join('\n\n')).trimEnd() + '\n'
    const tools = new Set((record.shape?.tools ?? []).map((tool) => tool.name))
    const found = { version: record.version, path, text }
    if (tools.has('Agent') && tools.has('Skill')) interactive = found
    else other = found
  }
  if (interactive) collector.offer('system-prompt', interactive)
  if (other) collector.offer('system-prompt:non-interactive', other)
}

function scanSubagent(path: string, lines: string[], collector: Collector): void {
  const meta = readMeta(path)
  if (meta?.agentType !== 'general-purpose') return
  let firstUserSeen = false
  let gp: Found | undefined
  for (const line of lines) {
    if (!firstUserSeen && line.includes('"type":"user"')) {
      const record = parse(line)
      if (record?.type === 'user') {
        firstUserSeen = true
        const text = typeof record.message?.content === 'string' ? record.message.content : undefined
        const recipe = meta.description == null && text ? parseRecipe(text) : undefined
        if (recipe) {
          collector.offer(`code-review/${recipe.level}`, { version: record.version, path, text: recipe.recipe })
        }
      }
    }
    if (meta.description != null && line.includes('"api-request-shape"')) {
      const record = parse(line) as ShapeRecord | undefined
      const text = record?.shape?.system?.[1]?.text
      if (record?.type === 'api-request-shape' && text?.startsWith(gpPrefix)) {
        gp = { version: record.version, path, text: text.trimEnd() + '\n' }
      }
    }
  }
  if (gp) collector.offer('general-purpose', gp)
}

function scanSecurityReview(path: string, lines: string[], collector: Collector): void {
  const toolUseIds = new Set<string>()
  for (const line of lines) {
    if (line.includes('"skill":"security-review"') && line.includes('"type":"assistant"')) {
      const record = parse(line)
      for (const block of record?.message?.content ?? []) {
        if (block?.type === 'tool_use' && block.name === 'Skill' && block.input?.skill === 'security-review') toolUseIds.add(block.id)
      }
      continue
    }
    if (toolUseIds.size === 0 || !line.includes('"sourceToolUseID"')) continue
    const record = parse(line)
    if (record?.type !== 'user' || !toolUseIds.has(record.sourceToolUseID)) continue
    const raw = contentText(record.message?.content)
    const text = raw ? scrubSecurityPrompt(raw) : undefined
    if (text) collector.offer('security-review/prompt', { version: record.version, path, text })
  }
}

function skillBody(text: string): string | undefined {
  const body = text.replace(/^Base directory for this skill: [^\n]*\n+/, '').trimEnd()
  if (body === '' || body.startsWith('Launching skill:')) return undefined
  return body + '\n'
}

function quickstartDesign(text: string): string | undefined {
  const start = text.indexOf(quickstartDesignMarker)
  if (start < 0) return undefined
  return text.slice(start).replace(quickstartDesignTail, '').trimEnd() + '\n'
}

function scanBuiltinSkills(path: string, lines: string[], skills: NewestCollector): void {
  const skillUses = new Map<string, string>()
  const quickstartUses = new Set<string>()
  for (const line of lines) {
    if (line.includes('"type":"assistant"') && line.includes('"tool_use"')) {
      const record = parse(line)
      for (const block of record?.message?.content ?? []) {
        if (block?.type !== 'tool_use') continue
        if (block.name === 'Skill' && builtinSkills.includes(block.input?.skill)) skillUses.set(block.id, block.input.skill)
        if (block.name === 'Artifact' && block.input?.action === 'quickstart') quickstartUses.add(block.id)
      }
      continue
    }
    if ((skillUses.size === 0 && quickstartUses.size === 0) || !line.includes('"type":"user"')) continue
    const record = parse(line)
    if (record?.type !== 'user') continue
    const metaSkill = skillUses.get(record.sourceToolUseID)
    if (metaSkill !== undefined) {
      const raw = contentText(record.message?.content)
      const text = raw ? skillBody(raw) : undefined
      if (text) skills.offer(metaSkill, { version: record.version, path, text })
    }
    const content = record.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block?.type !== 'tool_result') continue
      const raw = contentText(block.content)
      if (raw === undefined) continue
      const skill = skillUses.get(block.tool_use_id)
      if (skill !== undefined) {
        const text = skillBody(raw)
        if (text) skills.offer(skill, { version: record.version, path, text })
      }
      if (quickstartUses.has(block.tool_use_id)) {
        const text = quickstartDesign(raw)
        if (text) skills.offer('artifact-design', { version: record.version, path, text })
      }
    }
  }
}

async function scan(projects: string, collector: Collector, skills: NewestCollector): Promise<number> {
  const files = listTranscripts(projects)
  for (const path of files) {
    const text = await Bun.file(path).text()
    const lines = text.split('\n')
    if (path.includes(`${sep}subagents${sep}`)) scanSubagent(path, lines, collector)
    else scanMain(path, lines, collector)
    if (text.includes('"skill":"security-review"')) scanSecurityReview(path, lines, collector)
    if (text.includes('"skill":"artifact-') || text.includes('"action":"quickstart"')) scanBuiltinSkills(path, lines, skills)
  }
  return files.length
}

function write(relPath: string, text: string): void {
  const target = join(outDir, relPath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, text)
  console.log(`  ${relPath} (${Buffer.byteLength(text)} bytes)`)
}

const main = defineCommand({
  meta: {
    name: 'vendor-claude-code',
    description: 'Vendor Claude Code prompt texts from local session transcripts into vendor/claude-code (gitignored)',
  },
  args: {
    projects: {
      type: 'string',
      description: 'Claude Code projects directory with session transcripts',
      default: join(homedir(), '.claude', 'projects'),
    },
  },
  async run({ args }) {
    const projects = resolve(args.projects)
    if (!existsSync(projects)) throw new Error(`no such directory: ${projects}`)
    const version = installedVersion()
    if (version === undefined) console.warn('warning: could not read `claude --version`; using the newest records of any version')
    const collector = new Collector(version)
    const skills = new NewestCollector()
    const count = await scan(projects, collector, skills)
    console.log(`scanned ${count} transcripts in ${projects} for Claude Code ${version ?? '(unknown)'}`)

    const warnings: string[] = []
    const missing: string[] = []
    const sources: string[] = []
    const take = (key: string, label: string): Found | undefined => {
      const picked = collector.pick(key)
      if (!picked) return undefined
      if (!picked.exact) warnings.push(`${label}: no record for ${version ?? 'the installed version'}, used ${picked.found.version ?? 'unknown version'}`)
      sources.push(`${label}\t${picked.found.version ?? 'unknown'}\t${picked.found.path}`)
      return picked.found
    }

    rmSync(outDir, { recursive: true, force: true })
    console.log(`writing ${relative(repoRoot, outDir)}/`)

    let systemPrompt: Found | undefined
    if (collector.has('system-prompt') || !collector.has('system-prompt:non-interactive')) {
      systemPrompt = take('system-prompt', 'system-prompt.md')
    }
    if (!systemPrompt) {
      systemPrompt = take('system-prompt:non-interactive', 'system-prompt.md')
      if (systemPrompt) warnings.push('system-prompt.md: no interactive main session (tools Agent and Skill) found, used a non-interactive one')
    }
    if (systemPrompt) write('system-prompt.md', systemPrompt.text)
    else missing.push('system-prompt.md')

    const gp = take('general-purpose', 'general-purpose.md')
    if (gp) write('general-purpose.md', gp.text)
    else missing.push('general-purpose.md')

    const levels = [...collector.slots.keys()]
      .filter((key) => key.startsWith('code-review/'))
      .map((key) => key.slice('code-review/'.length))
      .sort()
    for (const level of levels) {
      const found = take(`code-review/${level}`, `skills/code-review/${level}.md`)
      if (found) write(`skills/code-review/${level}.md`, found.text)
    }
    for (const level of expectedCodeReviewLevels) {
      if (!levels.includes(level)) missing.push(`skills/code-review/${level}.md`)
    }

    const security = take('security-review/prompt', 'skills/security-review/prompt.md')
    if (security) write('skills/security-review/prompt.md', security.text)
    else missing.push('skills/security-review/prompt.md')

    for (const name of builtinSkills) {
      const found = skills.picks.get(name)
      const label = `skills/${name}.md`
      if (!found) {
        missing.push(label)
        continue
      }
      if (found.version !== version) warnings.push(`${label}: newest record is ${found.version ?? 'unknown version'}, installed is ${version ?? 'unknown'}`)
      sources.push(`${label}\t${found.version ?? 'unknown'}\t${found.path}`)
      write(label, found.text)
    }

    write('VERSION', [`claude-code ${version ?? 'unknown'}`, '', ...sources, ''].join('\n'))

    for (const warning of warnings) console.warn(`warning: ${warning}`)
    if (missing.length > 0) {
      console.log('not found:')
      for (const item of missing) console.log(`  ${item}`)
    }
  },
})

await runMain(main)
