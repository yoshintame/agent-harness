import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface ShapeRecord {
  kind: 'shape'
  version: string | undefined
  system: string[]
  tools: Set<string>
}

export interface ToolUseRecord {
  kind: 'tool-use'
  version: string | undefined
  id: string
  name: string
  input: Record<string, unknown>
}

export interface UserRecord {
  kind: 'user'
  version: string | undefined
  content: unknown
  sourceToolUseID: string | undefined
}

export type TranscriptRecord = ShapeRecord | ToolUseRecord | UserRecord

export interface Transcript {
  path: string
  records: TranscriptRecord[]
}

export interface ToolResult {
  use: ToolUseRecord
  version: string | undefined
  text: string
}

export interface Meta {
  agentType?: string
  description?: string | null
}

function parseLine(line: string): any {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

export function listTranscripts(root: string): string[] {
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

export function parseTranscript(path: string, text: string): Transcript {
  const records: TranscriptRecord[] = []
  for (const line of text.split('\n')) {
    const shape = line.includes('"api-request-shape"')
    const assistant = line.includes('"type":"assistant"') && line.includes('"tool_use"')
    const user = line.includes('"type":"user"')
    if (!shape && !assistant && !user) continue
    const raw = parseLine(line)
    if (raw?.type === 'api-request-shape') {
      records.push({
        kind: 'shape',
        version: raw.version,
        system: (raw.shape?.system ?? []).map((block: { text?: string }) => block?.text ?? ''),
        tools: new Set((raw.shape?.tools ?? []).map((tool: { name?: string }) => tool?.name)),
      })
    } else if (raw?.type === 'assistant') {
      for (const block of raw.message?.content ?? []) {
        if (block?.type !== 'tool_use') continue
        records.push({ kind: 'tool-use', version: raw.version, id: block.id, name: block.name, input: block.input ?? {} })
      }
    } else if (raw?.type === 'user') {
      records.push({ kind: 'user', version: raw.version, content: raw.message?.content, sourceToolUseID: raw.sourceToolUseID ?? undefined })
    }
  }
  return { path, records }
}

export function readTranscript(path: string): Transcript {
  return parseTranscript(path, readFileSync(path, 'utf8'))
}

export function readMeta(path: string): Meta | undefined {
  const metaPath = path.replace(/\.jsonl$/, '.meta.json')
  if (!existsSync(metaPath)) return undefined
  return parseLine(readFileSync(metaPath, 'utf8'))
}

export function contentText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const texts = content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text)
  return texts.length > 0 ? texts.join('\n') : undefined
}

export function toolResults(records: TranscriptRecord[], match: (use: ToolUseRecord) => boolean): ToolResult[] {
  const uses = new Map<string, ToolUseRecord>()
  const results: ToolResult[] = []
  for (const record of records) {
    if (record.kind === 'tool-use') {
      if (match(record)) uses.set(record.id, record)
      continue
    }
    if (record.kind !== 'user' || uses.size === 0) continue
    const meta = record.sourceToolUseID === undefined ? undefined : uses.get(record.sourceToolUseID)
    if (meta) {
      const text = contentText(record.content)
      if (text !== undefined) results.push({ use: meta, version: record.version, text })
    }
    if (!Array.isArray(record.content)) continue
    for (const block of record.content) {
      if (block?.type !== 'tool_result') continue
      const use = uses.get(block.tool_use_id)
      const text = use ? contentText(block.content) : undefined
      if (use && text !== undefined) results.push({ use, version: record.version, text })
    }
  }
  return results
}
