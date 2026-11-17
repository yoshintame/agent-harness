import { match, P } from 'ts-pattern@5.9.0'

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
      .with(P.string.startsWith('#x'), (hex) => String.fromCodePoint(Number.parseInt(hex.slice(2), 16)))
      .with(P.string.startsWith('#'), (decimal) => String.fromCodePoint(Number.parseInt(decimal.slice(1), 10)))
      .otherwise((name) => entitiesByName[name] ?? entity),
  )
}

export function stripHtml(text: string | null | undefined): string {
  const withoutTags = (text ?? '').replace(/<[^>]+>/g, ' ')
  return unescapeHtml(withoutTags).replace(/\s+/g, ' ').trim()
}

export function toOneLine(text: string, maxLength: number): string {
  return text.replaceAll('\n', ' ').slice(0, maxLength)
}

export function printBlock(lines: Array<string | null>): void {
  process.stdout.write(`${lines.filter((line) => line !== null).join('\n')}\n\n`)
}
