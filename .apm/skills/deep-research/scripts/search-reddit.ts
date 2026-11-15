#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { defineCommand } from 'citty@0.2.2'
import { orderBy, retry, take } from 'es-toolkit@1.52.0'
import { match, P } from 'ts-pattern@5.9.0'
import { z } from 'zod@4.6.5'
import {
  ChromeUnavailableError,
  closePage,
  describeError,
  evaluateInPage,
  fail,
  HttpError,
  jsonArg,
  limitArg,
  openPage,
  parseCount,
  printBlock,
  printJson,
  requestJson,
  runCli,
  toOneLine,
} from './lib'

const wwwBase = 'https://www.reddit.com'
const arcticBase = 'https://arctic-shift.photon-reddit.com/api'
const arcticUserAgent = 'search-reddit/2.0 (personal research CLI)'
const arcticTimeoutMs = 30_000
const maxRetryWaitSeconds = 10
const minRequestGapMs = 5500
const maxScrolls = 12
const scrollSettleMs = 1500
const maxCommentDepth = 2
const maxCommentsPerLevel = 10
const lastRequestPath = join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'search-reddit', 'last-request')
const booleanOperators = new Set(['AND', 'OR', 'NOT'])
const daysByTimeRange = { hour: 1, day: 1, week: 7, month: 31, year: 366 } as const

enum Stage {
  Browser = 'browser',
  Arctic = 'arctic',
}

enum PageRefusal {
  Blocked = 'blocked',
  Challenge = 'challenge',
  Unexpected = 'unexpected',
}

const searchNotes = {
  [Stage.Browser]: 'Reddit via the chrome-cdp Chrome session',
  [Stage.Arctic]: 'Arctic Shift archive: title-only match, newest first regardless of --sort, scores are archive snapshots',
} as const satisfies Record<Stage, string>

const fetchNotes = {
  [Stage.Browser]: 'Reddit via the chrome-cdp Chrome session',
  [Stage.Arctic]: 'Arctic Shift archive, scores are archive snapshots',
} as const satisfies Record<Stage, string>

const noArchiveHint = 'No archive fallback without --sub: Arctic Shift title search is subreddit-scoped, and its full-text search times out.'

const Post = z.object({
  title: z.string().nullish(),
  subreddit: z.string().nullish(),
  score: z.number().nullish(),
  num_comments: z.number().nullish(),
  created_utc: z.number().nullish(),
  permalink: z.string().nullish(),
  selftext: z.string().nullish(),
  author: z.string().nullish(),
})
type Post = z.infer<typeof Post>

const ThreadResponse = z.tuple([
  z.object({ data: z.object({ children: z.array(z.object({ data: Post })).min(1) }) }),
  z.object({ data: z.object({ children: z.array(z.unknown()) }) }),
])

const CommentThing = z.object({
  kind: z.literal('t1'),
  data: z.object({
    author: z.string().nullish(),
    score: z.number().nullish(),
    body: z.string().nullish(),
    replies: z.unknown().optional(),
  }),
})
type CommentThing = z.infer<typeof CommentThing>

const RepliesListing = z.object({ data: z.object({ children: z.array(z.unknown()) }) })

const RefusedPage = z.object({ kind: z.literal('refused'), title: z.string(), text: z.string() })

const SearchPage = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('results'),
    units: z.array(
      z.object({
        title: z.string(),
        subreddit: z.string().nullish(),
        author: z.string().nullish(),
        permalink: z.string(),
        created: z.string().nullish(),
        votes: z.number().nullish(),
        comments: z.number().nullish(),
        snippet: z.string().nullish(),
      }),
    ),
  }),
  RefusedPage,
])
type SearchUnit = Extract<z.infer<typeof SearchPage>, { kind: 'results' }>['units'][number]

const JsonPage = z.discriminatedUnion('kind', [z.object({ kind: z.literal('json'), body: z.string() }), RefusedPage])

interface PostSummary {
  title: string
  subreddit: string
  score: number | null
  num_comments: number | null
  created_utc: number
  url: string
  selftext: string
  author: string
}

interface Comment {
  author: string | null
  score: number | null
  body: string
  depth: number
}

interface Thread {
  title: string | null
  subreddit: string | null
  score: number | null
  num_comments: number | null
  url: string
  author: string | null
  selftext: string
  top_comments: Comment[]
}

interface StageFailure {
  stage: Stage
  reason: string
}

interface StageAttempt<T> {
  stage: Stage
  run: () => Promise<T>
}

type StageOutcome<T> = { ok: true; value: T; stage: Stage; failures: StageFailure[] } | { ok: false; failures: StageFailure[] }
type StageSuccess<T> = Extract<StageOutcome<T>, { ok: true }>

interface SearchQuery {
  query: string
  sub: string | undefined
  sort: string
  timeRange: string
  limit: number
  strict: boolean
}

class RedditPageError extends Error {
  public constructor(
    public readonly refusal: PageRefusal,
    detail: string,
  ) {
    super(detail)
  }
}

class ChannelFailure extends Error {
  public constructor(operation: string, failures: StageFailure[], hint?: string) {
    super(
      [`search-reddit ${operation}: every stage failed`, ...failures.map(({ stage, reason }) => `  ${stage}: ${reason}`), ...(hint ? [hint] : [])].join(
        '\n',
      ),
    )
  }
}

const search = defineCommand({
  meta: { name: 'search', description: 'Search Reddit posts' },
  args: {
    query: { type: 'positional', required: true, description: 'Search query' },
    sub: { type: 'string', description: 'Restrict to subreddit (e.g. typescript, selfhosted); enables the Arctic Shift fallback' },
    sort: { type: 'enum', options: ['relevance', 'top', 'new', 'comments', 'hot'], default: 'relevance', description: 'Sort order' },
    time: { type: 'enum', options: ['hour', 'day', 'week', 'month', 'year', 'all'], default: 'all', description: 'Time range' },
    limit: limitArg(20),
    loose: { type: 'boolean', description: "Skip auto '+word' AND-wrapping; pass the raw query to Reddit" },
    json: jsonArg,
  },
  async run({ args }) {
    const outcome = await searchPosts({
      query: args.query,
      sub: args.sub,
      sort: args.sort,
      timeRange: args.time,
      limit: parseCount({ flag: 'limit', value: args.limit }),
      strict: !args.loose,
    })
    reportFallback(outcome, searchNotes)
    if (args.json) return printJson(outcome.value)
    printPosts(outcome.value)
  },
})

const fetchCommand = defineCommand({
  meta: { name: 'fetch', description: 'Fetch a specific thread with top comments' },
  args: {
    url: { type: 'positional', required: true, description: 'Thread URL (reddit.com or redd.it)' },
    json: jsonArg,
  },
  async run({ args }) {
    const outcome = await fetchThread(args.url)
    reportFallback(outcome, fetchNotes)
    if (args.json) return printJson(outcome.value)
    printThread(outcome.value)
  },
})

const arcticCommand = defineCommand({
  meta: { name: 'arctic', description: 'List a subreddit chronologically via the Arctic Shift archive (no auth)' },
  args: {
    subreddit: { type: 'positional', required: true, description: 'Subreddit name (e.g. rust, ClaudeAI)' },
    title: { type: 'string', description: 'Only posts whose title matches these words (archive-side title search)' },
    after: { type: 'string', description: 'Only posts on/after this date (YYYY-MM-DD)' },
    before: { type: 'string', description: 'Only posts before this date (YYYY-MM-DD)' },
    sort: { type: 'enum', options: ['desc', 'asc'], default: 'desc', description: 'desc = newest first, asc = oldest first' },
    limit: limitArg(25),
    json: jsonArg,
  },
  async run({ args }) {
    const posts = await listArcticPosts({
      subreddit: args.subreddit,
      title: args.title,
      after: args.after,
      before: args.before,
      sort: args.sort,
      limit: parseCount({ flag: 'limit', value: args.limit }),
    }).catch((error: unknown) => fail(`search-reddit arctic: ${describeFailure(error)}`))
    if (args.json) return printJson(posts)
    printPosts(posts)
  },
})

const main = defineCommand({
  meta: {
    name: 'search-reddit',
    description: 'Reddit search and thread fetch through the signed-in chrome-cdp Chrome, with the Arctic Shift archive as fallback',
  },
  subCommands: { search, fetch: fetchCommand, arctic: arcticCommand },
})

async function searchPosts(query: SearchQuery): Promise<StageSuccess<PostSummary[]>> {
  const outcome = await runStages<PostSummary[]>([
    { stage: Stage.Browser, run: () => searchViaBrowser(query) },
    ...(query.sub ? [{ stage: Stage.Arctic, run: () => searchViaArctic(query) }] : []),
  ])
  if (!outcome.ok) throw new ChannelFailure('search', outcome.failures, query.sub ? undefined : noArchiveHint)
  return outcome
}

async function fetchThread(url: string): Promise<StageSuccess<Thread>> {
  const postId = threadPostId(url)
  const outcome = await runStages<Thread>([
    { stage: Stage.Browser, run: () => fetchViaBrowser(postId) },
    { stage: Stage.Arctic, run: () => fetchViaArctic(postId) },
  ])
  if (!outcome.ok) throw new ChannelFailure('fetch', outcome.failures)
  return outcome
}

async function runStages<T>(attempts: Array<StageAttempt<T>>): Promise<StageOutcome<T>> {
  const failures: StageFailure[] = []

  for (const { stage, run } of attempts) {
    try {
      return { ok: true, value: await run(), stage, failures }
    } catch (error) {
      failures.push({ stage, reason: describeFailure(error) })
    }
  }

  return { ok: false, failures }
}

interface ReportFallbackInput {
  stage: Stage
  failures: StageFailure[]
}

function reportFallback({ stage, failures }: ReportFallbackInput, notes: Record<Stage, string>): void {
  if (failures.length === 0) return

  process.stderr.write(
    `${[`note: served by ${stage} (${notes[stage]}); earlier stages failed:`, ...failures.map(({ stage: failed, reason }) => `  ${failed}: ${reason}`)].join('\n')}\n`,
  )
}

async function searchViaBrowser(query: SearchQuery): Promise<PostSummary[]> {
  const page = await withRedditPage(browserSearchUrl(query), (pageId) => evaluateInPage(pageId, searchPageScript(query.limit), SearchPage))
  if (page.kind === 'refused') throw toPageError(page)
  return page.units.map(toSearchSummary)
}

async function fetchViaBrowser(postId: string): Promise<Thread> {
  const url = `${wwwBase}/comments/${postId}/.json?limit=100&sort=top&raw_json=1`
  const page = await withRedditPage(url, (pageId) => evaluateInPage(pageId, jsonPageScript, JsonPage))
  if (page.kind === 'refused') throw toPageError(page)

  const [post, comments] = ThreadResponse.parse(JSON.parse(page.body))
  return toThread(post.data.children[0].data, extractComments({ items: comments.data.children, depth: 0, byScore: false }), postId)
}

async function withRedditPage<T>(url: string, read: (pageId: number) => Promise<T>): Promise<T> {
  await waitForRequestSlot()
  const pageId = await openPage(url)

  try {
    return await read(pageId)
  } finally {
    await closePage(pageId)
  }
}

async function waitForRequestSlot(): Promise<void> {
  const waitMs = readLastRequestAt() + minRequestGapMs - Date.now()
  if (waitMs > 0) await Bun.sleep(waitMs)

  try {
    mkdirSync(dirname(lastRequestPath), { recursive: true })
    writeFileSync(lastRequestPath, String(Date.now()))
  } catch {
    return
  }
}

function readLastRequestAt(): number {
  try {
    return Number(readFileSync(lastRequestPath, 'utf8')) || 0
  } catch {
    return 0
  }
}

function browserSearchUrl({ query, sub, sort, timeRange, strict }: SearchQuery): string {
  const params = new URLSearchParams({ q: strict ? toStrictAnd(query) : query, type: 'posts', sort, t: timeRange })
  if (sub) params.set('restrict_sr', '1')
  return sub ? `${wwwBase}/r/${normalizeSubreddit(sub)}/search/?${params}` : `${wwwBase}/search/?${params}`
}

function searchPageScript(limit: number): string {
  return `async () => {
    const limit = ${limit}
    const units = () => [...document.querySelectorAll('[data-testid=search-post-unit]')]
    const pageText = document.body.innerText
    if (units().length === 0 && /blocked by network security|Prove your humanity/.test(document.title + ' ' + pageText)) {
      return { kind: 'refused', title: document.title, text: pageText.slice(0, 300) }
    }
    let previous = -1
    for (let i = 0; i < ${maxScrolls} && units().length < limit && units().length !== previous; i++) {
      previous = units().length
      window.scrollTo(0, document.body.scrollHeight)
      await new Promise((resolve) => setTimeout(resolve, ${scrollSettleMs}))
    }
    return {
      kind: 'results',
      units: units().slice(0, limit).map((unit) => {
        const tracker = unit.querySelector('[data-faceplate-tracking-context]')
        let context = {}
        try { context = JSON.parse(tracker?.getAttribute('data-faceplate-tracking-context') ?? '{}') } catch {}
        const titleLink = unit.querySelector('a[data-testid=post-title]')
        const snippetLink = [...unit.querySelectorAll('a[href*="/comments/"]')].find((link) => link !== titleLink && link.innerText.trim() !== '' && link.innerText.trim() !== titleLink?.innerText.trim())
        const numbers = [...unit.querySelectorAll('faceplate-number')].map((node) => Number(node.getAttribute('number')))
        return {
          title: context.post?.title ?? titleLink?.innerText.trim() ?? '',
          subreddit: context.subreddit?.name ?? null,
          author: context.profile?.name ?? null,
          permalink: titleLink?.getAttribute('href') ?? '',
          created: unit.querySelector('faceplate-timeago')?.getAttribute('ts') ?? null,
          votes: Number.isFinite(numbers[0]) ? numbers[0] : null,
          comments: Number.isFinite(numbers[1]) ? numbers[1] : null,
          snippet: snippetLink?.innerText.trim() ?? null,
        }
      }),
    }
  }`
}

const jsonPageScript = `() => {
  const text = document.body.innerText
  try {
    JSON.parse(text)
    return { kind: 'json', body: text }
  } catch {
    return { kind: 'refused', title: document.title, text: text.slice(0, 300) }
  }
}`

function toPageError({ title, text }: z.infer<typeof RefusedPage>): RedditPageError {
  const refusal = match(`${title} ${text}`)
    .with(P.string.includes('blocked by network security'), () => PageRefusal.Blocked)
    .with(P.string.includes('Prove your humanity'), () => PageRefusal.Challenge)
    .otherwise(() => PageRefusal.Unexpected)

  const detail = match(refusal)
    .with(PageRefusal.Blocked, () => 'Reddit blocked the chrome-cdp Chrome ("blocked by network security"): sign in to Reddit in its window (`chrome-cdp up` opens it)')
    .with(PageRefusal.Challenge, () => 'Reddit asks for a human check ("Prove your humanity"): pass it in the chrome-cdp Chrome window')
    .with(PageRefusal.Unexpected, () => `unexpected page "${title}": ${toOneLine(text, 120)}`)
    .exhaustive()

  return new RedditPageError(refusal, detail)
}

function toSearchSummary(unit: SearchUnit): PostSummary {
  return {
    title: unit.title,
    subreddit: unit.subreddit ?? '',
    score: unit.votes ?? null,
    num_comments: unit.comments ?? null,
    created_utc: unit.created ? Math.floor(Date.parse(unit.created) / 1000) : 0,
    url: wwwBase + unit.permalink,
    selftext: (unit.snippet ?? '').slice(0, 300),
    author: unit.author ?? '',
  }
}

async function searchViaArctic({ query, sub, timeRange, limit }: SearchQuery): Promise<PostSummary[]> {
  const words = toArcticTitleWords(query)
  if (!words) throw new Error('nothing left to match on titles after stripping Reddit syntax')

  return listArcticPosts({ subreddit: sub ?? '', title: words, after: sinceDate(timeRange), before: undefined, sort: 'desc', limit })
}

function toStrictAnd(query: string): string {
  const tokens = query.split(/\s+/).filter(Boolean)
  const keepRaw = [/[+\-":()]/.test(query), tokens.length <= 1, tokens.some((token) => booleanOperators.has(token.toUpperCase()))].some(Boolean)
  return keepRaw ? query : tokens.map((token) => `+${token}`).join(' ')
}

function toArcticTitleWords(query: string): string {
  return query
    .replace(/\b(?:author|subreddit|self|site|url|flair|nsfw):\S+/g, ' ')
    .replace(/\b\w+:/g, ' ')
    .replace(/[+"()]/g, ' ')
    .split(/\s+/)
    .filter((word) => word !== '' && !word.startsWith('-') && !booleanOperators.has(word.toUpperCase()))
    .join(' ')
}

function sinceDate(timeRange: string): string | undefined {
  const days = match(timeRange)
    .with(P.union('hour', 'day', 'week', 'month', 'year'), (range) => daysByTimeRange[range])
    .otherwise(() => null)
  return days === null ? undefined : new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

function normalizeSubreddit(sub: string): string {
  return sub.trim().replace(/^r\//i, '').replace(/^\/+|\/+$/g, '')
}

async function fetchViaArctic(postId: string): Promise<Thread> {
  const [post] = await getArcticData('posts/ids', { ids: postId }, z.array(Post))
  if (post === undefined) throw new Error(`post ${postId} is not in the archive`)

  const tree = await getArcticData('comments/tree', { link_id: postId, limit: '500' }, z.array(z.unknown()))
  return toThread(post, extractComments({ items: tree, depth: 0, byScore: true }), postId)
}

function threadPostId(url: string): string {
  const path = new URL(url.includes('://') ? url : `https://${url}`).pathname.replace(/\/+$/, '')
  const postId = (path.match(/\/comments\/([a-z0-9]+)/) ?? path.match(/^\/([a-z0-9]+)$/))?.[1]
  if (postId === undefined) fail(`search-reddit fetch: not a thread URL (no /comments/<id> or redd.it/<id>): ${url}`)
  return postId
}

function toThread(post: Post, comments: Comment[], postId: string): Thread {
  return {
    title: post.title ?? null,
    subreddit: post.subreddit ?? null,
    score: post.score ?? null,
    num_comments: post.num_comments ?? null,
    url: wwwBase + (post.permalink ?? `/comments/${postId}/`),
    author: post.author ?? null,
    selftext: post.selftext ?? '',
    top_comments: comments,
  }
}

interface ExtractCommentsInput {
  items: unknown[]
  depth: number
  byScore: boolean
}

function extractComments({ items, depth, byScore }: ExtractCommentsInput): Comment[] {
  const comments = items.flatMap((item) => {
    const parsed = CommentThing.safeParse(item)
    return parsed.success ? [parsed.data.data] : []
  })
  const ranked = byScore ? orderBy(comments, [(comment) => comment.score ?? 0], ['desc']) : comments

  return take(ranked, maxCommentsPerLevel).flatMap((comment) => toCommentWithReplies({ comment, depth, byScore }))
}

interface ToCommentWithRepliesInput {
  comment: CommentThing['data']
  depth: number
  byScore: boolean
}

function toCommentWithReplies({ comment, depth, byScore }: ToCommentWithRepliesInput): Comment[] {
  const body = comment.body ?? ''
  if (['', '[deleted]', '[removed]'].includes(body)) return []

  const replies = RepliesListing.safeParse(comment.replies)
  const nested = replies.success && depth < maxCommentDepth ? extractComments({ items: replies.data.data.children, depth: depth + 1, byScore }) : []
  return [{ author: comment.author ?? null, score: comment.score ?? null, body, depth }, ...nested]
}

interface ListArcticPostsInput {
  subreddit: string
  title: string | undefined
  after: string | undefined
  before: string | undefined
  sort: string
  limit: number
}

async function listArcticPosts({ subreddit, title, after, before, sort, limit }: ListArcticPostsInput): Promise<PostSummary[]> {
  const name = normalizeSubreddit(subreddit)
  if (!name) throw new Error('arctic requires a subreddit')

  const optional = Object.entries({ title, after, before }).filter((entry): entry is [string, string] => Boolean(entry[1]))
  const posts = await getArcticData('posts/search', { subreddit: name, sort, limit: String(limit), ...Object.fromEntries(optional) }, z.array(Post))
  return posts.map(toPostSummary)
}

function toPostSummary(post: Post): PostSummary {
  return {
    title: post.title ?? '',
    subreddit: post.subreddit ?? '',
    score: post.score ?? null,
    num_comments: post.num_comments ?? null,
    created_utc: post.created_utc ?? 0,
    url: wwwBase + (post.permalink ?? ''),
    selftext: (post.selftext ?? '').slice(0, 300),
    author: post.author ?? '',
  }
}

async function getArcticData<T>(path: string, params: Record<string, string>, schema: z.ZodType<T>): Promise<T> {
  const envelope = z.object({ data: schema.nullish(), error: z.string().nullish() })
  const payload = await retry(
    () => requestJson({ url: `${arcticBase}/${path}?${new URLSearchParams(params)}`, headers: { 'User-Agent': arcticUserAgent }, timeoutMs: arcticTimeoutMs }, envelope),
    arcticRetry,
  )
  if (payload.error) throw new Error(`Arctic Shift: ${payload.error}`)
  return payload.data ?? schema.parse([])
}

const arcticRetry = {
  retries: 2,
  shouldRetry: (error: unknown) =>
    match(error)
      .with(P.intersection(P.instanceOf(HttpError), { status: P.union(400, 404) }), () => false)
      .with(P.instanceOf(HttpError), () => true)
      .with({ name: P.union('TimeoutError', 'TypeError') }, () => true)
      .otherwise(() => false),
  delay: (attempt: number, error: unknown) => {
    const backoff = 2 * (attempt + 1)
    const retryAfter = error instanceof HttpError ? retryAfterSeconds(error) : null
    return Math.min(Math.max(backoff, retryAfter ?? 0), maxRetryWaitSeconds) * 1000
  },
}

function describeFailure(error: unknown): string {
  return match(error)
    .with(P.instanceOf(RedditPageError), (failure) => failure.message)
    .with(P.instanceOf(ChromeUnavailableError), (failure) => `${failure.message} — run search-reddit outside the sandbox; \`chrome-cdp up\` starts the Chrome`)
    .with(P.instanceOf(HttpError), describeHttpError)
    .otherwise(describeError)
}

function describeHttpError(error: HttpError): string {
  const reason = error.body.match(/"error"\s*:\s*"([^"]+)"/)?.[1] ?? error.statusText
  const wait = retryAfterSeconds(error)
  return `HTTP ${error.status} ${reason}${wait === null ? '' : `, retry after ${wait}s`}`
}

function retryAfterSeconds(error: HttpError): number | null {
  const value = error.headers.get('retry-after') ?? error.headers.get('x-ratelimit-reset')
  const seconds = Math.floor(Number(value))
  return [value !== null, Number.isFinite(seconds), seconds > 0].every(Boolean) ? seconds : null
}

function formatScore(score: number | null, width: number): string {
  return score === null ? `${'?'.padStart(width)} pts` : `${String(score).padStart(width)} pts`
}

function printPosts(posts: PostSummary[]): void {
  if (posts.length === 0) return console.log('No results.')

  for (const post of posts) {
    printBlock([
      `[${formatScore(post.score, 5)} | ${post.num_comments ?? '?'} cmts | r/${post.subreddit}] ${post.title}`,
      `  ${post.url}`,
      post.selftext ? `  ${toOneLine(post.selftext, 200)}` : null,
    ])
  }
}

function printThread(thread: Thread): void {
  printBlock([
    `# ${thread.title ?? ''}`,
    `r/${thread.subreddit ?? ''} · ${thread.score ?? '?'} pts · ${thread.num_comments ?? '?'} comments · by u/${thread.author ?? ''}`,
    thread.url,
  ])
  if (thread.selftext) printBlock([thread.selftext])
  printBlock([`## Top comments (${thread.top_comments.length})`])

  for (const comment of thread.top_comments) {
    const indent = '  '.repeat(comment.depth)
    const lines = comment.body.replaceAll('\n\n', '\n').trim().split('\n')
    printBlock([`${indent}[${formatScore(comment.score, 4)}] u/${comment.author ?? ''}:`, ...lines.map((line) => `${indent}  ${line}`)])
  }
}

await runCli(main)
