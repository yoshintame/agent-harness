#!/usr/bin/env bun
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { defineCommand } from 'citty@0.2.2'
import { orderBy, randomInt, retry, sample, take } from 'es-toolkit@1.52.0'
import { match, P } from 'ts-pattern@5.9.0'
import { z } from 'zod@4.6.5'
import {
  describeError,
  fail,
  HttpError,
  jsonArg,
  limitArg,
  parseCount,
  printBlock,
  printJson,
  type RequestInput,
  requestJson,
  requestText,
  runCli,
  stripHtml,
  toOneLine,
  unescapeHtml,
} from './lib'

const clientId = 'ohXpoqrZYub1kg'
const tokenUrl = 'https://www.reddit.com/api/v1/access_token'
const oauthBase = 'https://oauth.reddit.com'
const wwwBase = 'https://www.reddit.com'
const arcticBase = 'https://arctic-shift.photon-reddit.com/api'
const arcticUserAgent = 'search-reddit/1.1 (personal research CLI)'
const arcticTimeoutMs = 30_000
const maxRetryWaitSeconds = 10
const tokenExpiryMarginSeconds = 120
const maxCommentDepth = 2
const maxCommentsPerLevel = 10
const tokenCachePath = join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'search-reddit', 'token.json')
const deviceIdAlphabet = [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789']
const booleanOperators = new Set(['AND', 'OR', 'NOT'])
const daysByTimeRange = { hour: 1, day: 1, week: 7, month: 31, year: 366 } as const

enum Stage {
  OAuth = 'oauth',
  Json = 'json',
  Rss = 'rss',
  Arctic = 'arctic',
}

enum RefusalKind {
  EdgeBlock = 'edge-block',
  RateLimit = 'rate-limit',
  Other = 'other',
}

const searchNotes = {
  [Stage.OAuth]: 'Reddit API',
  [Stage.Json]: 'anonymous .json endpoint',
  [Stage.Rss]: 'RSS feed, no scores or comment counts',
  [Stage.Arctic]: 'Arctic Shift archive: title-only match, newest first regardless of --sort, scores are archive snapshots',
} as const satisfies Record<Stage, string>

const fetchNotes = {
  [Stage.OAuth]: 'Reddit API',
  [Stage.Json]: 'anonymous .json endpoint',
  [Stage.Rss]: 'RSS feed, no scores, comments flattened',
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

const PostListing = z.object({ data: z.object({ children: z.array(z.object({ data: Post })) }) })
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
const TokenResponse = z.object({ access_token: z.string(), expires_in: z.number().optional() })
const TokenCache = z.object({ access_token: z.string(), expires_at: z.number() })

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

interface Refusal {
  kind: RefusalKind
  status: number
  retryAfterSeconds: number | null
  detail: string
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

interface SearchQuery {
  query: string
  sub: string | undefined
  sort: string
  timeRange: string
  limit: number
  strict: boolean
}

class TokenRequestError extends Error {
  public constructor(public override readonly cause: unknown) {
    super('token request failed')
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

const session = { token: null as string | null, userAgent: androidUserAgent() }

const search = defineCommand({
  meta: { name: 'search', description: 'Search Reddit posts' },
  args: {
    query: { type: 'positional', required: true, description: 'Search query' },
    sub: { type: 'string', description: 'Restrict to subreddit (e.g. typescript, selfhosted); enables the Arctic Shift fallback' },
    sort: { type: 'enum', options: ['relevance', 'top', 'new', 'comments', 'hot'], default: 'relevance', description: 'Sort order' },
    time: { type: 'enum', options: ['hour', 'day', 'week', 'month', 'year', 'all'], default: 'all', description: 'Time range' },
    limit: limitArg(20),
    loose: { type: 'boolean', description: "Skip auto '+word' AND-wrapping; pass raw query to Reddit" },
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
    description: 'Reddit search and fetch with no app registration; falls back to RSS and the Arctic Shift archive and names every failed stage',
  },
  subCommands: { search, fetch: fetchCommand, arctic: arcticCommand },
})

async function searchPosts(query: SearchQuery): Promise<Extract<StageOutcome<PostSummary[]>, { ok: true }>> {
  const attempts: Array<StageAttempt<PostSummary[]>> = [
    { stage: Stage.OAuth, run: () => searchViaOAuth(query) },
    { stage: Stage.Json, run: () => searchViaJson(query) },
    { stage: Stage.Rss, run: () => searchViaRss(query) },
    ...(query.sub ? [{ stage: Stage.Arctic, run: () => searchViaArctic(query) }] : []),
  ]
  const outcome = await runStages(attempts)
  if (!outcome.ok) throw new ChannelFailure('search', outcome.failures, query.sub ? undefined : noArchiveHint)
  return outcome
}

async function fetchThread(url: string): Promise<Extract<StageOutcome<Thread>, { ok: true }>> {
  const { path, postId } = threadPath(url)
  const outcome = await runStages<Thread>([
    { stage: Stage.OAuth, run: () => fetchViaOAuth(path) },
    { stage: Stage.Json, run: () => fetchViaJson(path) },
    { stage: Stage.Arctic, run: () => fetchViaArctic(path, postId) },
    { stage: Stage.Rss, run: () => fetchViaRss(path) },
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

async function searchViaOAuth(query: SearchQuery): Promise<PostSummary[]> {
  const listing = await getOAuthJson(`${oauthBase}${searchPath(query, '')}&raw_json=1`, PostListing)
  return listing.data.children.map(({ data }) => toPostSummary(data))
}

async function searchViaJson(query: SearchQuery): Promise<PostSummary[]> {
  const listing = await requestRedditJson({ url: `${wwwBase}${searchPath(query, '.json')}&raw_json=1`, headers: { 'User-Agent': androidUserAgent() } }, PostListing)
  return listing.data.children.map(({ data }) => toPostSummary(data))
}

async function searchViaRss(query: SearchQuery): Promise<PostSummary[]> {
  const entries = await getAtomEntries(`${wwwBase}${searchPath(query, '.rss')}`)
  return entries.map((entry) => ({
    title: entry.title,
    subreddit: entry.category,
    score: null,
    num_comments: null,
    created_utc: 0,
    url: entry.link,
    selftext: entry.content.slice(0, 300),
    author: entry.author,
  }))
}

async function searchViaArctic({ query, sub, timeRange, limit }: SearchQuery): Promise<PostSummary[]> {
  const words = toArcticTitleWords(query)
  if (!words) throw new Error('nothing left to match on titles after stripping Reddit syntax')

  return listArcticPosts({ subreddit: sub ?? '', title: words, after: sinceDate(timeRange), before: undefined, sort: 'desc', limit })
}

function searchPath({ query, sub, sort, timeRange, limit, strict }: SearchQuery, suffix: '' | '.json' | '.rss'): string {
  const params = new URLSearchParams({ q: strict ? toStrictAnd(query) : query })
  if (sub) params.set('restrict_sr', 'on')
  params.set('sort', sort)
  params.set('t', timeRange)
  params.set('limit', String(limit))

  return sub ? `/r/${normalizeSubreddit(sub)}/search${suffix}?${params}` : `/search${suffix}?${params}`
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

async function fetchViaOAuth(path: string): Promise<Thread> {
  const [post, comments] = await getOAuthJson(`${oauthBase}${path}?raw_json=1&limit=100`, ThreadResponse)
  return toThread(post.data.children[0].data, extractComments({ items: comments.data.children, depth: 0, byScore: false }))
}

async function fetchViaJson(path: string): Promise<Thread> {
  const [post, comments] = await requestRedditJson(
    { url: `${wwwBase}${path}.json?raw_json=1&limit=100`, headers: { 'User-Agent': androidUserAgent() } },
    ThreadResponse,
  )
  return toThread(post.data.children[0].data, extractComments({ items: comments.data.children, depth: 0, byScore: false }))
}

async function fetchViaArctic(path: string, postId: string): Promise<Thread> {
  const [post] = await getArcticData('posts/ids', { ids: postId }, z.array(Post))
  if (post === undefined) throw new Error(`post ${postId} is not in the archive`)

  const tree = await getArcticData('comments/tree', { link_id: postId, limit: '500' }, z.array(z.unknown()))
  return toThread(post, extractComments({ items: tree, depth: 0, byScore: true }), path)
}

async function fetchViaRss(path: string): Promise<Thread> {
  const [post, ...replies] = await getAtomEntries(`${wwwBase}${path}/.rss?limit=25`)
  if (post === undefined) throw new Error('empty RSS feed')

  return {
    title: post.title,
    subreddit: post.category,
    score: null,
    num_comments: null,
    url: post.link || `${wwwBase}${path}`,
    author: post.author,
    selftext: '',
    top_comments: replies
      .filter((entry) => entry.content !== '' && entry.content !== '[link] [comments]')
      .map((entry) => ({ author: entry.author, score: null, body: entry.content, depth: 0 })),
  }
}

function threadPath(url: string): { path: string; postId: string } {
  const path = new URL(url.includes('://') ? url : `https://${url}`).pathname.replace(/\/+$/, '')
  const postId = (path.match(/\/comments\/([a-z0-9]+)/) ?? path.match(/^\/([a-z0-9]+)$/))?.[1]
  if (postId === undefined) fail(`search-reddit fetch: not a thread URL (no /comments/<id> or redd.it/<id>): ${url}`)
  return { path, postId }
}

function toThread(post: Post, comments: Comment[], fallbackPath = ''): Thread {
  return {
    title: post.title ?? null,
    subreddit: post.subreddit ?? null,
    score: post.score ?? null,
    num_comments: post.num_comments ?? null,
    url: wwwBase + (post.permalink ?? fallbackPath),
    author: post.author ?? null,
    selftext: post.selftext ?? '',
    top_comments: comments,
  }
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

interface AtomEntry {
  title: string
  link: string
  category: string
  author: string
  content: string
}

async function getAtomEntries(url: string): Promise<AtomEntry[]> {
  const xml = await retry(() => requestText({ url, headers: { 'User-Agent': androidUserAgent() } }), redditRetry)
  if (!xml.includes('<feed')) throw new Error('non-Atom response')

  return [...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/g)].map(([, entry = '']) => ({
    title: stripHtml(unescapeHtml(atomText(entry, 'title'))),
    link: unescapeHtml(entry.match(/<link\b[^>]*\bhref="([^"]*)"/)?.[1] ?? ''),
    category: unescapeHtml(entry.match(/<category\b[^>]*\bterm="([^"]*)"/)?.[1] ?? ''),
    author: stripHtml(unescapeHtml(atomText(entry, 'name'))).replace('/u/', ''),
    content: stripHtml(unescapeHtml(atomText(entry, 'content'))),
  }))
}

function atomText(entry: string, tag: string): string {
  return entry.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`))?.[1] ?? ''
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

async function getArcticData<T>(path: string, params: Record<string, string>, schema: z.ZodType<T>): Promise<T> {
  const envelope = z.object({ data: schema.nullish(), error: z.string().nullish() })
  const payload = await retry(
    () => requestJson({ url: `${arcticBase}/${path}?${new URLSearchParams(params)}`, headers: { 'User-Agent': arcticUserAgent }, timeoutMs: arcticTimeoutMs }, envelope),
    arcticRetry,
  )
  if (payload.error) throw new Error(`Arctic Shift: ${payload.error}`)
  return payload.data ?? schema.parse([])
}

const redditRetry = {
  retries: 1,
  shouldRetry: (error: unknown) => rateLimitWaitSeconds(error) !== null,
  delay: (_attempt: number, error: unknown) => ((rateLimitWaitSeconds(error) ?? 0) + 1) * 1000,
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
    const retryAfter = error instanceof HttpError ? classifyRefusal(error).retryAfterSeconds : null
    return Math.min(Math.max(backoff, retryAfter ?? 0), maxRetryWaitSeconds) * 1000
  },
}

function rateLimitWaitSeconds(error: unknown): number | null {
  return match(error)
    .with(P.intersection(P.instanceOf(HttpError), { status: 429 }), (refused) =>
      match(classifyRefusal(refused).retryAfterSeconds)
        .with(P.number.lte(maxRetryWaitSeconds), (seconds) => seconds)
        .otherwise(() => null),
    )
    .otherwise(() => null)
}

async function requestRedditJson<T>(input: RequestInput, schema: z.ZodType<T>): Promise<T> {
  return retry(() => requestJson(input, schema), redditRetry)
}

async function getOAuthJson<T>(url: string, schema: z.ZodType<T>, allowTokenRefresh = true): Promise<T> {
  const token = session.token ?? readCachedToken() ?? (await fetchToken())
  session.token = token

  try {
    return await requestRedditJson({ url, headers: { Authorization: `Bearer ${token}`, 'User-Agent': session.userAgent } }, schema)
  } catch (error) {
    const canRefresh = allowTokenRefresh ? isStaleTokenRefusal(error) : false
    if (!canRefresh) throw error

    session.token = null
    rmSync(tokenCachePath, { force: true })
    return getOAuthJson(url, schema, false)
  }
}

function isStaleTokenRefusal(error: unknown): boolean {
  return match(error)
    .with(P.intersection(P.instanceOf(HttpError), { status: P.union(401, 403) }), (refused) => classifyRefusal(refused).kind !== RefusalKind.EdgeBlock)
    .otherwise(() => false)
}

async function fetchToken(): Promise<string> {
  const body = new URLSearchParams({ grant_type: 'https://oauth.reddit.com/grants/installed_client', device_id: deviceId() }).toString()
  const response = await requestRedditJson(
    {
      url: tokenUrl,
      method: 'POST',
      body,
      headers: { Authorization: `Basic ${btoa(`${clientId}:`)}`, 'User-Agent': androidUserAgent(), 'Content-Type': 'application/x-www-form-urlencoded' },
    },
    TokenResponse,
  ).catch((error: unknown) => {
    throw new TokenRequestError(error)
  })

  writeCachedToken(response.access_token, Date.now() / 1000 + (response.expires_in ?? 86_400))
  return response.access_token
}

function readCachedToken(): string | null {
  try {
    const cached = TokenCache.parse(JSON.parse(readFileSync(tokenCachePath, 'utf8')))
    return cached.expires_at - tokenExpiryMarginSeconds > Date.now() / 1000 ? cached.access_token : null
  } catch {
    return null
  }
}

function writeCachedToken(token: string, expiresAt: number): void {
  try {
    mkdirSync(dirname(tokenCachePath), { recursive: true })
    writeFileSync(tokenCachePath, JSON.stringify({ access_token: token, expires_at: expiresAt }), { mode: 0o600 })
  } catch {
    return
  }
}

function androidUserAgent(): string {
  return `Reddit/2024.${randomInt(10, 21)}.0/Android ${randomInt(10, 15)}`
}

function deviceId(): string {
  return Array.from({ length: 30 }, () => sample(deviceIdAlphabet)).join('')
}

function describeFailure(error: unknown): string {
  return match(error)
    .with(P.instanceOf(TokenRequestError), (failure): string => `token request: ${describeFailure(failure.cause)}`)
    .with(P.instanceOf(HttpError), (refused) => classifyRefusal(refused).detail)
    .otherwise(describeError)
}

function classifyRefusal(error: HttpError): Refusal {
  const remaining = error.headers.get('x-ratelimit-remaining')
  const retryAfterSeconds = toWaitSeconds(error.headers.get('retry-after')) ?? toWaitSeconds(error.headers.get('x-ratelimit-reset'))
  const kind = match({
    edgeBlocked: error.body.includes('blocked by network security'),
    rateLimited: [error.status === 429, remaining !== null && Number(remaining) <= 0].some(Boolean),
  })
    .with({ edgeBlocked: true }, () => RefusalKind.EdgeBlock)
    .with({ rateLimited: true }, () => RefusalKind.RateLimit)
    .otherwise(() => RefusalKind.Other)

  const detail = match(kind)
    .with(RefusalKind.EdgeBlock, () => `HTTP ${error.status} edge block: Reddit's edge refused this client from this network ("blocked by network security")`)
    .with(RefusalKind.RateLimit, () => `HTTP ${error.status} rate limited${retryAfterSeconds === null ? '' : `, resets in ${retryAfterSeconds}s`}`)
    .with(RefusalKind.Other, () => `HTTP ${error.status} ${error.body.match(/"error"\s*:\s*"([^"]+)"/)?.[1] ?? error.statusText}`)
    .exhaustive()

  return { kind, status: error.status, retryAfterSeconds, detail }
}

function toWaitSeconds(value: string | null): number | null {
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
