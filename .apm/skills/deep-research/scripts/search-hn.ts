#!/usr/bin/env bun
import { defineCommand } from 'citty@0.2.2'
import { take } from 'es-toolkit@1.52.0'
import { z } from 'zod@4.6.5'
import { jsonArg, limitArg, parseCount, parseOptionalCount, printBlock, printJson, requestJson, runCli, toOneLine, unescapeHtml } from './lib'

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
type ItemNode = z.infer<typeof ItemNode>

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
      limit: parseCount({ flag: 'limit', value: args.limit }),
      byDate: args['by-date'] ?? false,
    })
    if (args.json) return printJson(stories)
    printStories(stories)
  },
})

const fetchCommand = defineCommand({
  meta: { name: 'fetch', description: 'Fetch a story with its comment tree' },
  args: {
    id: { type: 'positional', required: true, description: 'HN item id' },
    json: jsonArg,
  },
  async run({ args }) {
    const thread = await fetchThread(args.id)
    if (args.json) return printJson(thread)
    printThread(thread)
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
  const pointFilters = [
    minPoints === undefined ? null : `points>${minPoints}`,
    maxPoints === undefined ? null : `points<${maxPoints}`,
  ].filter((filter) => filter !== null)
  const params = new URLSearchParams({ query, tags, hitsPerPage: String(limit) })
  if (pointFilters.length > 0) params.set('numericFilters', pointFilters.join(','))
  const endpoint = byDate ? 'search_by_date' : 'search'

  const response = await requestJson({ url: `${apiBase}/${endpoint}?${params}` }, SearchResponse)
  return response.hits.map(toStory)
}

function toStory(hit: z.infer<typeof SearchHit>): Story {
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
  const item = await requestJson({ url: `${apiBase}/items/${encodeURIComponent(id)}` }, ItemNode)
  return {
    id: item.id,
    title: item.title ? unescapeHtml(item.title) : null,
    url: item.url ?? null,
    points: item.points ?? null,
    author: item.author ?? null,
    created_at: item.created_at ?? null,
    text: item.text ? unescapeHtml(item.text) : null,
    comments: take(item.children ?? [], maxCommentsPerLevel).flatMap((child) => collectComments(child, 0)),
  }
}

function collectComments(raw: unknown, depth: number): Comment[] {
  const parsed = ItemNode.safeParse(raw)
  if (!parsed.success) return []

  const node: ItemNode = parsed.data
  const own = node.type === 'comment' && node.text
    ? [{ author: node.author ?? null, points: node.points ?? null, depth, text: unescapeHtml(node.text) }]
    : []
  const replies = depth < maxCommentDepth
    ? take(node.children ?? [], maxCommentsPerLevel).flatMap((child) => collectComments(child, depth + 1))
    : []

  return [...own, ...replies]
}

function itemUrl(id: string | number): string {
  return `https://news.ycombinator.com/item?id=${id}`
}

function printStories(stories: Story[]): void {
  if (stories.length === 0) return console.log('No results.')

  for (const story of stories) {
    const hnUrl = itemUrl(story.id)
    printBlock([
      `[${String(story.points).padStart(4)} pts | ${story.num_comments} cmts] ${story.title}`,
      `  ${hnUrl}`,
      story.url !== hnUrl ? `  -> ${story.url}` : null,
      story.story_text ? `  ${toOneLine(story.story_text, 200)}` : null,
    ])
  }
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
    const indent = '  '.repeat(comment.depth)
    const lines = comment.text.replaceAll('\n\n', '\n').trim().split('\n')
    printBlock([
      `${indent}[${comment.points === null ? '-' : `${comment.points} pts`}] ${comment.author ?? '?'}:`,
      ...take(lines, 10).map((line) => `${indent}  ${line.slice(0, 300)}`),
    ])
  }
}

await runCli(main)
