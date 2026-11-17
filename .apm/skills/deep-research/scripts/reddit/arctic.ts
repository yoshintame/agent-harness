import { chunk, retry } from 'es-toolkit@1.52.0'
import { match, P } from 'ts-pattern@5.9.0'
import { z } from 'zod@4.6.5'
import { HttpError, requestJson } from '../lib'
import { collectMatching } from './collect'
import { ArcticSort, type SearchPostsInput, toArcticTitleWords, toSinceEpochSeconds } from './query'
import { type CommentOptions, extractComments, type FlairFilter, Post, type PostSummary, type Thread, toPostSummary, toThread } from './thread'

const arcticBase = 'https://arctic-shift.photon-reddit.com/api'
const arcticUserAgent = 'search-reddit/2.0 (personal research CLI)'
const arcticTimeoutMs = 30_000
const enrichTimeoutMs = 8000
const maxRetryWaitSeconds = 10
const maxArcticPageSize = 100

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

interface SearchViaArcticInput extends Omit<SearchPostsInput, 'sub' | 'sort'> {
  sub: string
  filter: FlairFilter
}

export async function searchViaArctic({ query, sub, timeRange, limit, filter }: SearchViaArcticInput): Promise<PostSummary[]> {
  const words = toArcticTitleWords(query)
  if (!words) throw new Error('nothing left to match on titles after stripping Reddit syntax')

  const since = toSinceEpochSeconds(timeRange)
  const pages = arcticPostPages({ subreddit: sub, title: words, after: since === undefined ? undefined : String(since), before: undefined, sort: ArcticSort.Desc })
  return collectMatching({ pages, filter, limit })
}

interface FetchViaArcticInput {
  postId: string
  options: CommentOptions
}

export async function fetchViaArctic({ postId, options }: FetchViaArcticInput): Promise<Thread> {
  const [post] = await getArcticData({ path: 'posts/ids', params: { ids: postId }, itemSchema: Post })
  if (post === undefined) throw new Error(`post ${postId} is not in the archive`)

  const tree = options.perLevel === 0 ? [] : await getArcticData({ path: 'comments/tree', params: { link_id: postId, limit: '500' }, itemSchema: z.unknown() })
  return toThread({ post, comments: extractComments({ items: tree, options, serverSorted: false }), postId, sort: options.sort })
}

export interface ArcticPostPagesInput {
  subreddit: string
  title: string | undefined
  after: string | undefined
  before: string | undefined
  sort: ArcticSort
}

export async function* arcticPostPages({ subreddit, title, after, before, sort }: ArcticPostPagesInput): AsyncGenerator<PostSummary[]> {
  const params = { subreddit, sort, limit: String(maxArcticPageSize), title, after, before }
  const posts = await getArcticData({ path: 'posts/search', params, itemSchema: Post })
  yield posts.map(toPostSummary)

  const last = posts.at(-1)?.created_utc
  if ([posts.length < maxArcticPageSize, last === undefined, last === null].some(Boolean)) return

  const cursor = String(last)
  yield* arcticPostPages(sort === ArcticSort.Desc ? { subreddit, title, after, before: cursor, sort } : { subreddit, title, after: cursor, before, sort })
}

export async function enrichFromArchive(posts: PostSummary[]): Promise<PostSummary[]> {
  const ids = posts.map((post) => post.id)
  if (ids.length === 0) return posts

  const batches = await Promise.all(
    chunk(ids, maxArcticPageSize).map((batch) =>
      getArcticData({ path: 'posts/ids', params: { ids: batch.join(',') }, itemSchema: Post, timeoutMs: enrichTimeoutMs, retries: 0 }),
    ),
  )
  const archivedById = new Map(batches.flat().map((post) => [post.id ?? '', toPostSummary(post)]))

  return posts.map((post) => {
    const archivedPost = archivedById.get(post.id)
    return archivedPost === undefined
      ? post
      : {
          ...post,
          edited_utc: archivedPost.edited_utc,
          flair: archivedPost.flair,
          flair_known: true,
          kind: archivedPost.kind,
          link: archivedPost.link,
          selftext: archivedPost.selftext === '' ? post.selftext : archivedPost.selftext,
        }
  })
}

export function describeArcticHttpError(error: HttpError): string {
  const reason = error.body.match(/"error"\s*:\s*"([^"]+)"/)?.[1] ?? error.statusText
  const wait = error.status === 429 ? retryAfterSeconds(error) : null
  return `HTTP ${error.status} ${reason}${wait === null ? '' : `, retry after ${wait}s`}`
}

interface GetArcticDataInput<T> {
  path: string
  params: Record<string, string | undefined>
  itemSchema: z.ZodType<T>
  timeoutMs?: number
  retries?: number
}

async function getArcticData<T>({ path, params, itemSchema, timeoutMs = arcticTimeoutMs, retries = arcticRetry.retries }: GetArcticDataInput<T>): Promise<T[]> {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, value)
  }

  const envelope = z.object({ data: z.array(itemSchema).nullish(), error: z.string().nullish() })
  const payload = await retry(
    () => requestJson({ url: `${arcticBase}/${path}?${search}`, headers: { 'User-Agent': arcticUserAgent }, timeoutMs, schema: envelope }),
    { ...arcticRetry, retries },
  )
  if (payload.error) throw new Error(`Arctic Shift: ${payload.error}`)

  return payload.data ?? []
}

function retryAfterSeconds(error: HttpError): number | null {
  const value = error.headers.get('retry-after') ?? error.headers.get('x-ratelimit-reset')
  const seconds = Math.floor(Number(value))
  return [value !== null, Number.isFinite(seconds), seconds > 0].every(Boolean) ? seconds : null
}
