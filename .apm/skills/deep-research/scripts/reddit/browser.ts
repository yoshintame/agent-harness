import { match, P } from 'ts-pattern@5.9.0'
import { z } from 'zod@4.6.5'
import { type CommandError, evaluateInPage, LockBusyError } from '../lib'
import { collectMatching } from './collect'
import { withHumanFix } from './human-fix'
import { PageState, RedditApiError, RedditPageError, readRedditJson, resultLinkSelector, toPageError } from './page'
import { type ListingSort, type SearchPostsInput, type TimeRange } from './query'
import { PageMovedError, withRedditPage } from './session'
import { type CommentOptions, CommentSort, extractComments, type FlairFilter, Post, type PostSummary, type Thread, ThreadResponse, toPostSummary, toThread, wwwBase } from './thread'

const maxScrolls = 12
const scrollSettleMs = 1500
const maxApiComments = 500
const maxListingPageSize = 100

const commentSortParams = {
  [CommentSort.Top]: 'top',
  [CommentSort.Best]: 'confidence',
  [CommentSort.New]: 'new',
  [CommentSort.Old]: 'old',
  [CommentSort.Controversial]: 'controversial',
  [CommentSort.Qa]: 'qa',
} as const satisfies Record<CommentSort, string>

const SearchSnapshot = PageState.extend({
  noResults: z.boolean(),
  units: z.array(
    z.object({
      title: z.string(),
      permalink: z.string(),
      subreddit: z.string().nullish(),
      author: z.string().nullish(),
      created: z.string().nullish(),
      votes: z.number().nullish(),
      comments: z.number().nullish(),
      snippet: z.string().nullish(),
    }),
  ),
})

const ResultUnit = z.object({
  title: z.string().min(1),
  permalink: z.string().regex(/^\/r\/[^/]+\/comments\/[a-z0-9]+/),
  subreddit: z.string().nullish(),
  author: z.string().nullish(),
  created: z.string().nullish(),
  votes: z.number().nullish(),
  comments: z.number().nullish(),
  snippet: z.string().nullish(),
})
type ResultUnit = z.infer<typeof ResultUnit>

const FlairsResponse = z.array(z.object({ text: z.string(), mod_only: z.boolean().nullish() }))
const ListingResponse = z.object({ data: z.object({ after: z.string().nullable(), children: z.array(z.object({ data: Post })) }) })
const SharedPage = PageState.extend({ path: z.string() })

const searchSnapshotScript = `() => {
  const numberLabelled = (card, label) => {
    const span = [...card.querySelectorAll('[data-testid=search-counter-row] span')].find((candidate) => candidate.querySelector('faceplate-number') && candidate.textContent.includes(label))
    const value = Number(span?.querySelector('faceplate-number')?.getAttribute('number'))
    return Number.isFinite(value) ? value : null
  }
  return {
    title: document.title,
    text: document.body.innerText.slice(0, 300),
    noResults: document.querySelector('[data-testid=search-error-message]') !== null,
    units: [...document.querySelectorAll('${resultLinkSelector}')].map((link) => {
      const card = link.closest('[data-testid^=search-post]') ?? link.parentElement
      let context = {}
      try { context = JSON.parse(card.querySelector('[data-faceplate-tracking-context]')?.getAttribute('data-faceplate-tracking-context') ?? '{}') } catch {}
      const snippet = [...card.querySelectorAll('a[href*="/comments/"]')].map((candidate) => candidate.innerText.trim()).find((text) => text !== '' && text !== link.innerText.trim())
      return {
        title: context.post?.title ?? link.innerText.trim(),
        permalink: link.getAttribute('href') ?? '',
        subreddit: context.subreddit?.name ?? null,
        author: context.profile?.name ?? null,
        created: card.querySelector('faceplate-timeago')?.getAttribute('ts') ?? null,
        votes: numberLabelled(card, 'vote'),
        comments: numberLabelled(card, 'comment'),
        snippet: snippet ?? null,
      }
    }),
  }
}`

const scrollScript = `() => {
  window.scrollTo(0, document.body.scrollHeight)
  return document.querySelectorAll('${resultLinkSelector}').length
}`

const resultCountScript = `() => document.querySelectorAll('${resultLinkSelector}').length`

const sharedPageScript = '() => ({ title: document.title, text: document.body.innerText.slice(0, 300), path: location.pathname })'

export function searchViaBrowser(input: SearchPostsInput): Promise<PostSummary[]> {
  return withHumanFix(async () => {
    const snapshot = await withRedditPage({
      url: browserSearchUrl(input),
      expectInUrl: '/search',
      read: async (pageId) => {
        const initialCount = await evaluateInPage({ pageId, source: resultCountScript, schema: z.number() })
        await loadMoreResults({ pageId, limit: input.limit, seen: initialCount, scrollsLeft: maxScrolls })
        return evaluateInPage({ pageId, source: searchSnapshotScript, schema: SearchSnapshot })
      },
    })
    const units = snapshot.units.flatMap((unit) => {
      const parsed = ResultUnit.safeParse(unit)
      return parsed.success ? [parsed.data] : []
    })

    return match({ found: snapshot.units.length, valid: units.length, noResults: snapshot.noResults })
      .with({ valid: P.number.gt(0) }, () => units.slice(0, input.limit).map(toSearchSummary))
      .with({ found: P.number.gt(0) }, () => {
        throw new RedditPageError('Reddit result cards changed shape: no card had a title and a /r/<sub>/comments/ link')
      })
      .with({ noResults: true }, () => [])
      .otherwise(() => {
        throw toPageError(snapshot)
      })
  })
}

interface FetchViaBrowserInput {
  postId: string
  options: CommentOptions
}

export function fetchViaBrowser({ postId, options }: FetchViaBrowserInput): Promise<Thread> {
  return withHumanFix(async () => {
    const [post, comments] = await readRedditJson({ url: threadJsonUrl({ postId, options }), expectInUrl: postId, schema: ThreadResponse }).catch((error: unknown) => {
      throw match(error)
        .with(P.intersection(P.instanceOf(RedditApiError), { status: 404 }), () => new RedditPageError(`post ${postId} not found on Reddit`))
        .otherwise(() => error)
    })
    const items = options.perLevel === 0 ? [] : comments.data.children

    return toThread({ post: post.data.children[0].data, comments: extractComments({ items, options, serverSorted: true }), postId, sort: options.sort })
  })
}

export interface ListSubredditInput {
  sub: string
  sort: ListingSort
  timeRange: TimeRange
  limit: number
  filter: FlairFilter
}

export function listViaBrowser(input: ListSubredditInput): Promise<PostSummary[]> {
  return withHumanFix(() => collectMatching({ pages: listingPages({ input, after: null }), filter: input.filter, limit: input.limit }))
}

interface ListingPagesInput {
  input: ListSubredditInput
  after: string | null
}

async function* listingPages({ input, after }: ListingPagesInput): AsyncGenerator<PostSummary[]> {
  const params = new URLSearchParams({ limit: String(maxListingPageSize), t: input.timeRange, raw_json: '1' })
  if (after !== null) params.set('after', after)

  const page = await readRedditJson({ url: `${wwwBase}/r/${input.sub}/${input.sort}.json?${params}`, expectInUrl: `/r/${input.sub}/`, schema: ListingResponse }).catch(
    (error: unknown) => {
      throw toMissingSubredditError({ error, sub: input.sub })
    },
  )
  yield page.data.children.map(({ data }) => toPostSummary(data))

  if (page.data.after !== null) yield* listingPages({ input, after: page.data.after })
}

export interface SubredditFlair {
  text: string
  mod_only: boolean
}

export function listFlairs(sub: string): Promise<SubredditFlair[]> {
  return withHumanFix(async () => {
    const flairs = await readRedditJson({ url: `${wwwBase}/r/${sub}/api/link_flair_v2.json?raw_json=1`, expectInUrl: 'link_flair_v2', schema: FlairsResponse }).catch(
      (error: unknown) => {
        throw match(error)
          .with(P.instanceOf(RedditApiError), ({ status }) => new RedditPageError(`r/${sub} does not publish its flair list (Reddit answered ${status}); read flairs off \`top\` output instead`))
          .otherwise(() => toMissingSubredditError({ error, sub }))
      },
    )
    return flairs.map((flair) => ({ text: flair.text, mod_only: flair.mod_only ?? false }))
  })
}

export function resolveShareLink(url: string): Promise<string> {
  return withHumanFix(async () => {
    const page = await withRedditPage({ url, expectInUrl: 'reddit.com/', read: (pageId) => evaluateInPage({ pageId, source: sharedPageScript, schema: SharedPage }) })
    const postId = page.path.match(/\/comments\/([a-z0-9]+)/)?.[1]
    if (postId === undefined) throw toPageError(page)

    return postId
  })
}

export function describeBrowserFailure(error: CommandError | LockBusyError): string {
  return match(error)
    .with(P.instanceOf(LockBusyError), () => 'another search-reddit run kept the agent Chrome tab busy for over 2 minutes; run fewer Reddit calls in parallel')
    .with({ detail: P.string.includes('refusing to run inside the agent sandbox') }, () => 'chrome-devtools refuses to run in the agent sandbox: run search-reddit outside it')
    .with({ detail: P.string.includes('timed out') }, ({ detail }) => `chrome-devtools ${detail}: check the chrome-cdp Chrome window (\`chrome-cdp status\`)`)
    .with({ detail: P.string.regex(/ECONNREFUSED|could not connect|failed to (launch|connect)|browser has disconnected/i) }, () => "can't reach the chrome-cdp Chrome: start it with `chrome-cdp up`")
    .otherwise(({ message }) => message)
}

interface ToMissingSubredditErrorInput {
  error: unknown
  sub: string
}

function toMissingSubredditError({ error, sub }: ToMissingSubredditErrorInput): unknown {
  return match(error)
    .with(P.intersection(P.instanceOf(PageMovedError), { href: P.string.includes('/subreddits/search') }), () => new RedditPageError(`r/${sub} does not exist: Reddit redirected to its subreddit search`))
    .otherwise(() => error)
}

function threadJsonUrl({ postId, options }: FetchViaBrowserInput): string {
  const params = new URLSearchParams({
    sort: commentSortParams[options.sort],
    depth: String(Math.max(options.maxDepth, 1)),
    limit: String(options.perLevel === 0 ? 1 : maxApiComments),
    raw_json: '1',
  })
  return `${wwwBase}/comments/${postId}/.json?${params}`
}

interface LoadMoreResultsInput {
  pageId: number
  limit: number
  seen: number
  scrollsLeft: number
}

async function loadMoreResults({ pageId, limit, seen, scrollsLeft }: LoadMoreResultsInput): Promise<void> {
  if ([seen >= limit, scrollsLeft === 0].some(Boolean)) return

  await evaluateInPage({ pageId, source: scrollScript, schema: z.number() })
  await Bun.sleep(scrollSettleMs)
  const count = await evaluateInPage({ pageId, source: resultCountScript, schema: z.number() })

  return count === seen ? undefined : loadMoreResults({ pageId, limit, seen: count, scrollsLeft: scrollsLeft - 1 })
}

function browserSearchUrl({ query, sub, sort, timeRange }: SearchPostsInput): string {
  const params = new URLSearchParams({ q: query, type: 'posts', sort, t: timeRange })
  if (sub) params.set('restrict_sr', '1')

  return sub ? `${wwwBase}/r/${sub}/search/?${params}` : `${wwwBase}/search/?${params}`
}

function toSearchSummary(unit: ResultUnit): PostSummary {
  const createdMs = unit.created ? Date.parse(unit.created) : Number.NaN
  return {
    id: unit.permalink.match(/\/comments\/([a-z0-9]+)/)?.[1] ?? '',
    title: unit.title,
    subreddit: unit.subreddit ?? unit.permalink.split('/')[2] ?? '',
    score: unit.votes ?? null,
    num_comments: unit.comments ?? null,
    created_utc: Number.isFinite(createdMs) ? Math.floor(createdMs / 1000) : null,
    edited_utc: null,
    url: wwwBase + unit.permalink,
    selftext: (unit.snippet ?? '').slice(0, 300),
    author: unit.author ?? null,
    flair: null,
    flair_known: false,
    kind: null,
    link: null,
  }
}
