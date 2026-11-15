import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { match, P } from 'ts-pattern@5.9.0'
import { z } from 'zod@4.6.5'
import { closePage, CommandError, evaluateInPage, openPage } from '../lib'
import { normalizeSubreddit, type SearchPostsInput } from './query'
import { extractComments, type PostSummary, type Thread, ThreadResponse, toThread, wwwBase } from './thread'

const minRequestGapMs = 5500
const maxScrolls = 12
const scrollSettleMs = 1500
const lockRetryMs = 100
const lockAttempts = 100
const staleLockMs = 30_000
const cacheDir = join(z.string().min(1).catch(join(homedir(), '.cache')).parse(process.env.XDG_CACHE_HOME ?? ''), 'search-reddit')
const lastSlotPath = join(cacheDir, 'last-request')
const lockPath = join(cacheDir, 'request.lock')
const blockedPhrase = 'blocked by network security'
const challengePhrase = 'Prove your humanity'
const resultLinkSelector = 'a[data-testid=post-title]'

export class RedditPageError extends Error {}

const PageState = z.object({ title: z.string(), text: z.string() })
type PageState = z.infer<typeof PageState>

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
  permalink: z.string().regex(/^\/r\/[^/]+\/comments\//),
  subreddit: z.string().nullish(),
  author: z.string().nullish(),
  created: z.string().nullish(),
  votes: z.number().nullish(),
  comments: z.number().nullish(),
  snippet: z.string().nullish(),
})
type ResultUnit = z.infer<typeof ResultUnit>

const JsonSnapshot = PageState.extend({ data: z.unknown() })
const NotFoundBody = z.object({ error: z.literal(404) })

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

const jsonSnapshotScript = `() => {
  const raw = document.querySelector('pre')?.textContent ?? document.body.textContent ?? ''
  let data = null
  try { data = JSON.parse(raw) } catch {}
  return { title: document.title, text: document.body.innerText.slice(0, 300), data }
}`

export async function searchViaBrowser(input: SearchPostsInput): Promise<PostSummary[]> {
  const snapshot = await withRedditPage({
    url: browserSearchUrl(input),
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
}

export async function fetchViaBrowser(postId: string): Promise<Thread> {
  const url = `${wwwBase}/comments/${postId}/.json?limit=100&sort=top&raw_json=1`
  const snapshot = await withRedditPage({ url, read: (pageId) => evaluateInPage({ pageId, source: jsonSnapshotScript, schema: JsonSnapshot }) })

  return match(snapshot.data)
    .with(P.nullish, () => {
      throw toPageError(snapshot)
    })
    .when(
      (data) => NotFoundBody.safeParse(data).success,
      () => {
        throw new RedditPageError(`post ${postId} not found on Reddit`)
      },
    )
    .otherwise((data) => {
      const [post, comments] = ThreadResponse.parse(data)
      return toThread({ post: post.data.children[0].data, comments: extractComments({ items: comments.data.children, depth: 0, byScore: false }), postId })
    })
}

export async function resolveShareLink(url: string): Promise<string> {
  const path = await withRedditPage({ url, read: (pageId) => evaluateInPage({ pageId, source: '() => location.pathname', schema: z.string() }) })
  const postId = path.match(/\/comments\/([a-z0-9]+)/)?.[1]
  if (postId === undefined) throw new RedditPageError(`share link did not lead to a thread (landed on ${path})`)

  return postId
}

export function describeBrowserFailure(error: CommandError): string {
  return match(error.detail)
    .with(P.string.includes('refusing to run inside the agent sandbox'), () => 'chrome-devtools refuses to run in the agent sandbox: run search-reddit outside it')
    .with(P.string.includes('timed out'), () => `chrome-devtools ${error.detail}: check the chrome-cdp Chrome window (\`chrome-cdp status\`)`)
    .with(P.string.regex(/ECONNREFUSED|could not connect|failed to (launch|connect)|browser has disconnected/i), () => "can't reach the chrome-cdp Chrome: start it with `chrome-cdp up`")
    .otherwise((detail) => `chrome-devtools: ${detail}`)
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

  return sub ? `${wwwBase}/r/${normalizeSubreddit(sub)}/search/?${params}` : `${wwwBase}/search/?${params}`
}

function toPageError({ title, text }: PageState): RedditPageError {
  const detail = match(`${title} ${text}`)
    .with(P.string.includes(blockedPhrase), () => `Reddit blocked the chrome-cdp Chrome ("${blockedPhrase}"): sign in to Reddit in its window (\`chrome-cdp up\` opens it)`)
    .with(P.string.includes(challengePhrase), () => `Reddit asks for a human check ("${challengePhrase}"): pass it in the chrome-cdp Chrome window`)
    .otherwise(() => `unexpected Reddit page "${title}": ${text.replaceAll('\n', ' ').slice(0, 120)}`)

  return new RedditPageError(detail)
}

function toSearchSummary(unit: ResultUnit): PostSummary {
  const createdMs = unit.created ? Date.parse(unit.created) : Number.NaN
  return {
    title: unit.title,
    subreddit: unit.subreddit ?? '',
    score: unit.votes ?? null,
    num_comments: unit.comments ?? null,
    created_utc: Number.isFinite(createdMs) ? Math.floor(createdMs / 1000) : 0,
    url: wwwBase + unit.permalink,
    selftext: (unit.snippet ?? '').slice(0, 300),
    author: unit.author ?? '',
  }
}

interface WithRedditPageInput<T> {
  url: string
  read: (pageId: number) => Promise<T>
}

async function withRedditPage<T>({ url, read }: WithRedditPageInput<T>): Promise<T> {
  await waitForRequestSlot()
  const pageId = await openPage(url)

  try {
    return await read(pageId)
  } finally {
    await closePage(pageId)
  }
}

async function waitForRequestSlot(): Promise<void> {
  const slot = await reserveRequestSlot()
  await Bun.sleep(Math.max(0, slot - Date.now()))
}

async function reserveRequestSlot(): Promise<number> {
  mkdirSync(cacheDir, { recursive: true })
  await acquireLock({ attemptsLeft: lockAttempts })

  try {
    const slot = Math.max(Date.now(), readLastSlot() + minRequestGapMs)
    writeFileSync(lastSlotPath, String(slot))
    return slot
  } finally {
    rmSync(lockPath, { force: true, recursive: true })
  }
}

interface AcquireLockInput {
  attemptsLeft: number
}

async function acquireLock({ attemptsLeft }: AcquireLockInput): Promise<void> {
  return match({ created: tryCreateLock(), exhausted: attemptsLeft === 0 })
    .with({ created: true }, () => undefined)
    .with({ exhausted: true }, () => takeOverStaleLock())
    .otherwise(async () => {
      await Bun.sleep(lockRetryMs)
      return acquireLock({ attemptsLeft: attemptsLeft - 1 })
    })
}

function tryCreateLock(): boolean {
  try {
    mkdirSync(lockPath)
    return true
  } catch {
    return false
  }
}

function takeOverStaleLock(): void {
  const lockedAtMs = statSync(lockPath, { throwIfNoEntry: false })?.mtimeMs ?? 0
  if (Date.now() - lockedAtMs < staleLockMs) throw new RedditPageError('another search-reddit run holds the request lock; retry in a few seconds')

  rmSync(lockPath, { force: true, recursive: true })
  mkdirSync(lockPath)
}

function readLastSlot(): number {
  try {
    return z.coerce.number().int().nonnegative().catch(0).parse(readFileSync(lastSlotPath, 'utf8'))
  } catch {
    return 0
  }
}
