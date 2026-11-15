import { match, P } from 'ts-pattern@5.9.0'

const maxCodePoint = 0x10ffff
const replacementCharacter = '�'

const entitiesByName: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
}

export function unescapeHtml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) =>
    match(code.toLowerCase())
      .with(P.string.startsWith('#x'), (hex) => toCharacter(Number.parseInt(hex.slice(2), 16)))
      .with(P.string.startsWith('#'), (decimal) => toCharacter(Number.parseInt(decimal.slice(1), 10)))
      .otherwise((name) => entitiesByName[name] ?? entity),
  )
}

function toCharacter(codePoint: number): string {
  return codePoint <= maxCodePoint ? String.fromCodePoint(codePoint) : replacementCharacter
}

export function stripHtml(text: string | null | undefined): string {
  const withoutTags = (text ?? '').replace(/<[^>]+>/g, ' ')
  return unescapeHtml(withoutTags).replace(/\s+/g, ' ').trim()
}

interface ToOneLineInput {
  text: string
  maxLength: number
}

export function toOneLine({ text, maxLength }: ToOneLineInput): string {
  return text.replaceAll('\n', ' ').slice(0, maxLength)
}

export function toAbsoluteUrl(url: string): URL {
  return new URL(url.includes('://') ? url : `https://${url}`)
}

export function printBlock(lines: Array<string | null>): void {
  process.stdout.write(`${lines.filter((line) => line !== null).join('\n')}\n\n`)
}

interface PrintEntriesInput<T> {
  entries: T[]
  emptyMessage: string
  toBlock: (entry: T) => Array<string | null>
}

export function printEntries<T>({ entries, emptyMessage, toBlock }: PrintEntriesInput<T>): void {
  if (entries.length === 0) return console.log(emptyMessage)

  for (const entry of entries) printBlock(toBlock(entry))
}

interface PrintCommentInput {
  depth: number
  header: string
  body: string
  maxLines?: number
  maxLineLength?: number
}

export function printComment({ depth, header, body, maxLines = Number.POSITIVE_INFINITY, maxLineLength }: PrintCommentInput): void {
  const indent = '  '.repeat(depth)
  const lines = body.replaceAll('\n\n', '\n').trim().split('\n').slice(0, maxLines)
  printBlock([`${indent}${header}`, ...lines.map((line) => `${indent}  ${line.slice(0, maxLineLength)}`)])
}
