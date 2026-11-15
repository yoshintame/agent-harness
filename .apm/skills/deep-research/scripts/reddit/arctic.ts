import { retry } from 'es-toolkit@1.52.0'
import { match, P } from 'ts-pattern@5.9.0'
import { z } from 'zod@4.6.5'
import { HttpError, requestJson } from '../lib'
import { ArcticSort, normalizeSubreddit, type SearchPostsInput, toArcticTitleWords, toSinceEpochSeconds } from './query'
import { type CommentOptions, extractComments, Post, type PostSummary, type Thread, toPostSummary, toThread } from './thread'

const arcticBase = 'https://arctic-shift.photon-reddit.com/api'
const arcticUserAgent = 'search-reddit/2.0 (personal research CLI)'
const arcticTimeoutMs = 30_000
const maxRetryWaitSeconds = 10

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
}

export async function searchViaArctic({ query, sub, timeRange, limit }: SearchViaArcticInput): Promise<PostSummary[]> {
  const words = toArcticTitleWords(query)
  if (!words) throw new Error('nothing left to match on titles after stripping Reddit syntax')

  return listArcticPosts({ subreddit: sub, title: words, after: toSinceEpochSeconds(timeRange)?.toString(), before: undefined, sort: ArcticSort.Desc, limit })
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

interface ListArcticPostsInput {
  subreddit: string
  title: string | undefined
  after: string | undefined
  before: string | undefined
  sort: ArcticSort
  limit: number
}

export async function listArcticPosts({ subreddit, title, after, before, sort, limit }: ListArcticPostsInput): Promise<PostSummary[]> {
  const name = normalizeSubreddit(subreddit)
  if (!name) throw new Error('arctic requires a subreddit')

  const posts = await getArcticData({ path: 'posts/search', params: { subreddit: name, sort, limit: String(limit), title, after, before }, itemSchema: Post })
  return posts.map(toPostSummary)
}

export async function enrichFromArchive(posts: PostSummary[]): Promise<PostSummary[]> {
  const ids = posts.map((post) => post.id).filter((id) => id !== '')
  if (ids.length === 0) return posts

  const archived = await getArcticData({ path: 'posts/ids', params: { ids: ids.join(',') }, itemSchema: Post })
  const archivedById = new Map(archived.map((post) => [post.id ?? '', toPostSummary(post)]))

  return posts.map((post) => {
    const archivedPost = archivedById.get(post.id)
    return archivedPost === undefined
      ? post
      : {
          ...post,
          flair: archivedPost.flair,
          kind: archivedPost.kind,
          link: archivedPost.link,
          selftext: archivedPost.selftext === '' ? post.selftext : archivedPost.selftext,
        }
  })
}

export function describeArcticHttpError(error: HttpError): string {
  const reason = error.body.match(/"error"\s*:\s*"([^"]+)"/)?.[1] ?? error.statusText
  const wait = retryAfterSeconds(error)
  return `HTTP ${error.status} ${reason}${wait === null ? '' : `, retry after ${wait}s`}`
}

interface GetArcticDataInput<T> {
  path: string
  params: Record<string, string | undefined>
  itemSchema: z.ZodType<T>
}

async function getArcticData<T>({ path, params, itemSchema }: GetArcticDataInput<T>): Promise<T[]> {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, value)
  }

  const envelope = z.object({ data: z.array(itemSchema).nullish(), error: z.string().nullish() })
  const payload = await retry(
    () => requestJson({ url: `${arcticBase}/${path}?${search}`, headers: { 'User-Agent': arcticUserAgent }, timeoutMs: arcticTimeoutMs, schema: envelope }),
    arcticRetry,
  )
  if (payload.error) throw new Error(`Arctic Shift: ${payload.error}`)

  return payload.data ?? []
}

function retryAfterSeconds(error: HttpError): number | null {
  const value = error.headers.get('retry-after') ?? error.headers.get('x-ratelimit-reset')
  const seconds = Math.floor(Number(value))
  return [value !== null, Number.isFinite(seconds), seconds > 0].every(Boolean) ? seconds : null
}
