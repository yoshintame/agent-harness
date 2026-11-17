#!/usr/bin/env bun
import { defineCommand } from 'citty@0.2.2'
import { compact, take } from 'es-toolkit@1.52.0'
import { match, P } from 'ts-pattern@5.9.0'
import { z } from 'zod@4.6.5'
import { emit, jsonArg, limitArg, parseOptionalCount, printBlock, printComment, printEntries, readLimit, requestJson, runCli, toOneLine, unescapeHtml } from './lib'

const apiBase = 'https://hn.algolia.com/api/v1'
const maxCommentDepth = 2
const maxCommentsPerLevel = 15

const SearchHit = z.object({
  objectID: z.string(),
  title: z.string().nullish(),
  story_title: z.string().nullish(),
  url: z.string().nullish(),
  points: z.number().nullish(),
  num_comments: z.number().nullish(),
  author: z.string().nullish(),
  created_at: z.string().nullish(),
  _tags: z.array(z.string()).optional(),
  story_text: z.string().nullish(),
  comment_text: z.string().nullish(),
})
type SearchHit = z.infer<typeof SearchHit>

const SearchResponse = z.object({ hits: z.array(SearchHit) })

const ItemNode = z.object({
  id: z.number(),
  type: z.string().nullish(),
  title: z.string().nullish(),
  url: z.string().nullish(),
  points: z.number().nullish(),
  author: z.string().nullish(),
  created_at: z.string().nullish(),
  text: z.string().nullish(),
  children: z.array(z.unknown()).nullish(),
})

interface Story {
  id: string
  title: string
  url: string
  points: number
  num_comments: number
  author: string | null
  created_at: string | null
  tags: string[]
  story_text: string
}

interface Comment {
  author: string | null
  points: number | null
  depth: number
  text: string
}

interface Thread {
  id: number
  title: string | null
  url: string | null
  points: number | null
  author: string | null
  created_at: string | null
  text: string | null
  comments: Comment[]
}

const search = defineCommand({
  meta: { name: 'search', description: 'Search HN stories' },
  args: {
    query: { type: 'positional', required: true, description: 'Search query' },
    tags: { type: 'string', default: 'story', description: 'story | show_hn | ask_hn | comment (comma-separated)' },
    'min-points': { type: 'string', description: 'Only stories above N points' },
    'max-points': { type: 'string', description: 'Only stories below N points: surfaces low-score announcements' },
    limit: limitArg(20),
    'by-date': { type: 'boolean', description: 'Sort chronologically instead of by relevance' },
    json: jsonArg,
  },
  async run({ args }) {
    const stories = await searchStories({
      query: args.query,
      tags: args.tags,
      minPoints: parseOptionalCount({ flag: 'min-points', value: args['min-points'] }),
      maxPoints: parseOptionalCount({ flag: 'max-points', value: args['max-points'] }),
      limit: readLimit(args.limit),
      byDate: args['by-date'] ?? false,
    })
    emit({ value: stories, json: args.json, printMarkdown: printStories })
  },
})

const fetchCommand = defineCommand({
  meta: { name: 'fetch', description: 'Fetch a story with its comment tree' },
  args: {
    id: { type: 'positional', required: true, description: 'HN item id' },
    json: jsonArg,
  },
  async run({ args }) {
    emit({ value: await fetchThread(args.id), json: args.json, printMarkdown: printThread })
  },
})

const main = defineCommand({
  meta: { name: 'search-hn', description: 'Hacker News search and fetch (Algolia API, no auth)' },
  subCommands: { search, fetch: fetchCommand },
})

interface SearchStoriesInput {
  query: string
  tags: string
  minPoints: number | undefined
  maxPoints: number | undefined
  limit: number
  byDate: boolean
}

async function searchStories({ query, tags, minPoints, maxPoints, limit, byDate }: SearchStoriesInput): Promise<Story[]> {
  const pointFilters = compact([minPoints === undefined ? null : `points>${minPoints}`, maxPoints === undefined ? null : `points<${maxPoints}`])
  const params = new URLSearchParams({ query, tags, hitsPerPage: String(limit) })
  if (pointFilters.length > 0) params.set('numericFilters', pointFilters.join(','))

  const endpoint = byDate ? 'search_by_date' : 'search'
  const response = await requestJson({ url: `${apiBase}/${endpoint}?${params}`, schema: SearchResponse })
  return response.hits.map(toStory)
}

function toStory(hit: SearchHit): Story {
  const body = hit.story_text ?? hit.comment_text ?? ''
  return {
    id: hit.objectID,
    title: unescapeHtml(hit.title ?? hit.story_title ?? ''),
    url: hit.url ?? itemUrl(hit.objectID),
    points: hit.points ?? 0,
    num_comments: hit.num_comments ?? 0,
    author: hit.author ?? null,
    created_at: hit.created_at ?? null,
    tags: hit._tags ?? [],
    story_text: unescapeHtml(body.slice(0, 300)),
  }
}

async function fetchThread(id: string): Promise<Thread> {
  const item = await requestJson({ url: `${apiBase}/items/${encodeURIComponent(id)}`, schema: ItemNode })
  return {
    id: item.id,
    title: item.title ? unescapeHtml(item.title) : null,
    url: item.url ?? null,
    points: item.points ?? null,
    author: item.author ?? null,
    created_at: item.created_at ?? null,
    text: item.text ? unescapeHtml(item.text) : null,
    comments: take(item.children ?? [], maxCommentsPerLevel).flatMap((raw) => collectComments({ raw, depth: 0 })),
  }
}

interface CollectCommentsInput {
  raw: unknown
  depth: number
}

function collectComments({ raw, depth }: CollectCommentsInput): Comment[] {
  const parsed = ItemNode.safeParse(raw)
  if (!parsed.success) return []

  const node = parsed.data
  const own = match(node)
    .with({ type: 'comment', text: P.string.minLength(1) }, ({ author, points, text }) => [
      { author: author ?? null, points: points ?? null, depth, text: unescapeHtml(text) },
    ])
    .otherwise(() => [])
  const replies = depth < maxCommentDepth ? take(node.children ?? [], maxCommentsPerLevel).flatMap((child) => collectComments({ raw: child, depth: depth + 1 })) : []

  return [...own, ...replies]
}

function itemUrl(id: string | number): string {
  return `https://news.ycombinator.com/item?id=${id}`
}

function printStories(stories: Story[]): void {
  printEntries({
    entries: stories,
    emptyMessage: 'No results.',
    toBlock: (story) => {
      const hnUrl = itemUrl(story.id)
      return [
        `[${String(story.points).padStart(4)} pts | ${story.num_comments} cmts] ${story.title}`,
        `  ${hnUrl}`,
        story.url === hnUrl ? null : `  -> ${story.url}`,
        story.story_text ? `  ${toOneLine({ text: story.story_text, maxLength: 200 })}` : null,
      ]
    },
  })
}

function printThread(thread: Thread): void {
  printBlock([
    `# ${thread.title ?? ''}`,
    `${thread.points ?? '?'} pts · by ${thread.author ?? '?'}`,
    itemUrl(thread.id),
    thread.url ? `-> ${thread.url}` : null,
  ])
  if (thread.text) printBlock([thread.text.slice(0, 1000)])
  printBlock([`## Comments (${thread.comments.length})`])

  for (const comment of thread.comments) {
    printComment({
      depth: comment.depth,
      header: `[${comment.points === null ? '-' : `${comment.points} pts`}] ${comment.author ?? '?'}:`,
      body: comment.text,
      maxLines: 10,
      maxLineLength: 300,
    })
  }
}

await runCli(main)
