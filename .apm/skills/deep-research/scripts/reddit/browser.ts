import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { match, P } from 'ts-pattern@5.9.0'
import { z } from 'zod@4.6.5'
import { alertUser, closePage, CommandError, evaluateInPage, getChromePid, openPage } from '../lib'
import { normalizeSubreddit, type SearchPostsInput } from './query'
import { type CommentOptions, CommentSort, extractComments, type PostSummary, type Thread, ThreadResponse, toThread, wwwBase } from './thread'

const minRequestGapMs = 5500
const maxScrolls = 12
const scrollSettleMs = 1500
const lockRetryMs = 100
const lockAttempts = 100
const staleLockMs = 30_000
const humanWaitMs = 180_000
const humanPollMs = 5000
const humanGiveUpCooldownMs = 600_000
const maxApiComments = 500
const cacheDir = join(z.string().min(1).catch(join(homedir(), '.cache')).parse(process.env.XDG_CACHE_HOME ?? ''), 'search-reddit')
const lastSlotPath = join(cacheDir, 'last-request')
const requestLockPath = join(cacheDir, 'request.lock')
const humanLockPath = join(cacheDir, 'human.lock')
const humanGaveUpPath = join(cacheDir, 'human-gave-up')
const blockedPhrase = 'blocked by network security'
const challengePhrase = 'Prove your humanity'
const resultLinkSelector = 'a[data-testid=post-title]'
const signedInSelector = '#expand-user-drawer-button, faceplate-dropdown-menu'

export enum PageRefusal {
  Blocked = 'blocked',
  Challenge = 'challenge',
  Unexpected = 'unexpected',
}

interface RedditPageErrorInput {
  refusal: PageRefusal
  detail: string
}

export class RedditPageError extends Error {
  public readonly refusal: PageRefusal

  public constructor({ refusal, detail }: RedditPageErrorInput) {
    super(detail)
    this.refusal = refusal
  }
}

const commentSortParams = {
  [CommentSort.Top]: 'top',
  [CommentSort.Best]: 'confidence',
  [CommentSort.New]: 'new',
  [CommentSort.Old]: 'old',
  [CommentSort.Controversial]: 'controversial',
  [CommentSort.Qa]: 'qa',
} as const satisfies Record<CommentSort, string>

const humanActionsByRefusal = {
  [PageRefusal.Blocked]: { url: `${wwwBase}/login/`, message: 'Reddit signed the agent Chrome out: sign in in the window that just opened' },
  [PageRefusal.Challenge]: { url: `${wwwBase}/`, message: 'Reddit asks for a human check: pass it in the window that just opened' },
} as const

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
const HumanCheckState = PageState.extend({ signedIn: z.boolean() })

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

const humanCheckScript = `() => ({
  title: document.title,
  text: document.body.innerText.slice(0, 300),
  signedIn: document.querySelector('${signedInSelector}') !== null,
})`

export function searchViaBrowser(input: SearchPostsInput): Promise<PostSummary[]> {
  return withHumanFix(async () => {
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
        throw new RedditPageError({ refusal: PageRefusal.Unexpected, detail: 'Reddit result cards changed shape: no card had a title and a /r/<sub>/comments/ link' })
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
    const snapshot = await withRedditPage({
      url: threadJsonUrl({ postId, options }),
      read: (pageId) => evaluateInPage({ pageId, source: jsonSnapshotScript, schema: JsonSnapshot }),
    })

    return match(snapshot.data)
      .with(P.nullish, () => {
        throw toPageError(snapshot)
      })
      .when(
        (data) => NotFoundBody.safeParse(data).success,
        () => {
          throw new RedditPageError({ refusal: PageRefusal.Unexpected, detail: `post ${postId} not found on Reddit` })
        },
      )
      .otherwise((data) => {
        const [post, comments] = ThreadResponse.parse(data)
        const items = options.perLevel === 0 ? [] : comments.data.children
        return toThread({ post: post.data.children[0].data, comments: extractComments({ items, options, serverSorted: true }), postId, sort: options.sort })
      })
  })
}

export function resolveShareLink(url: string): Promise<string> {
  return withHumanFix(async () => {
    const page = await withRedditPage({
      url,
      read: (pageId) => evaluateInPage({ pageId, source: '() => ({ title: document.title, text: document.body.innerText.slice(0, 300), path: location.pathname })', schema: PageState.extend({ path: z.string() }) }),
    })
    const postId = page.path.match(/\/comments\/([a-z0-9]+)/)?.[1]
    if (postId === undefined) throw toPageError(page)

    return postId
  })
}

export function describeBrowserFailure(error: CommandError): string {
  return match(error.detail)
    .with(P.string.includes('refusing to run inside the agent sandbox'), () => 'chrome-devtools refuses to run in the agent sandbox: run search-reddit outside it')
    .with(P.string.includes('timed out'), () => `chrome-devtools ${error.detail}: check the chrome-cdp Chrome window (\`chrome-cdp status\`)`)
    .with(P.string.regex(/ECONNREFUSED|could not connect|failed to (launch|connect)|browser has disconnected/i), () => "can't reach the chrome-cdp Chrome: start it with `chrome-cdp up`")
    .otherwise((detail) => `chrome-devtools: ${detail}`)
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

async function withHumanFix<T>(attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt()
  } catch (error) {
    const refused = match(error)
      .with(P.intersection(P.instanceOf(RedditPageError), { refusal: P.union(PageRefusal.Blocked, PageRefusal.Challenge) }), (failure) => failure)
      .otherwise(() => null)
    if (refused === null) throw error

    const fixed = await awaitHumanFix(refused.refusal)
    if (!fixed) throw new RedditPageError({ refusal: refused.refusal, detail: `${refused.message} (nobody fixed it within ${humanWaitMs / 60_000} min)` })

    return attempt()
  }
}

async function awaitHumanFix(refusal: PageRefusal): Promise<boolean> {
  mkdirSync(cacheDir, { recursive: true })
  if (gaveUpRecently()) return false

  removeLockOlderThan({ path: humanLockPath, maxAgeMs: humanWaitMs + staleLockMs })
  return tryCreateLock(humanLockPath) ? guideHumanThroughFix(refusal) : waitForOtherRunsFix()
}

async function guideHumanThroughFix(refusal: PageRefusal): Promise<boolean> {
  const action = refusal === PageRefusal.Blocked ? humanActionsByRefusal[PageRefusal.Blocked] : humanActionsByRefusal[PageRefusal.Challenge]

  try {
    const pageId = await openPage({ url: action.url, background: false })
    await alertUser({ title: 'search-reddit', message: action.message, focusPid: await getChromePid() })
    const fixed = await pollUntilFixed({ pageId, deadline: Date.now() + humanWaitMs })
    await closePage(pageId)
    if (!fixed) writeFileSync(humanGaveUpPath, String(Date.now()))

    return fixed
  } finally {
    rmSync(humanLockPath, { force: true, recursive: true })
  }
}

interface PollUntilFixedInput {
  pageId: number
  deadline: number
}

async function pollUntilFixed({ pageId, deadline }: PollUntilFixedInput): Promise<boolean> {
  await Bun.sleep(humanPollMs)
  const state = await evaluateInPage({ pageId, source: humanCheckScript, schema: HumanCheckState }).catch(() => null)
  const refused = state === null ? true : [blockedPhrase, challengePhrase].some((phrase) => `${state.title} ${state.text}`.includes(phrase))
  const fixed = state === null ? false : [state.signedIn, !refused].every(Boolean)

  return match({ fixed, expired: Date.now() >= deadline })
    .with({ fixed: true }, () => true)
    .with({ expired: true }, () => false)
    .otherwise(() => pollUntilFixed({ pageId, deadline }))
}

async function waitForOtherRunsFix(): Promise<boolean> {
  const deadline = Date.now() + humanWaitMs + humanPollMs * 2
  await waitWhileLocked({ path: humanLockPath, deadline })

  return !gaveUpRecently()
}

interface WaitWhileLockedInput {
  path: string
  deadline: number
}

async function waitWhileLocked({ path, deadline }: WaitWhileLockedInput): Promise<void> {
  if ([!existsSync(path), Date.now() >= deadline].some(Boolean)) return

  await Bun.sleep(humanPollMs)
  return waitWhileLocked({ path, deadline })
}

function gaveUpRecently(): boolean {
  try {
    const gaveUpAt = z.coerce.number().catch(0).parse(readFileSync(humanGaveUpPath, 'utf8'))
    return Date.now() - gaveUpAt < humanGiveUpCooldownMs
  } catch {
    return false
  }
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
  return match(`${title} ${text}`)
    .with(
      P.string.includes(blockedPhrase),
      () =>
        new RedditPageError({ refusal: PageRefusal.Blocked, detail: `Reddit blocked the chrome-cdp Chrome ("${blockedPhrase}"): sign in to Reddit in its window (\`chrome-cdp up\` opens it)` }),
    )
    .with(
      P.string.includes(challengePhrase),
      () => new RedditPageError({ refusal: PageRefusal.Challenge, detail: `Reddit asks for a human check ("${challengePhrase}"): pass it in the chrome-cdp Chrome window` }),
    )
    .otherwise(() => new RedditPageError({ refusal: PageRefusal.Unexpected, detail: `unexpected Reddit page "${title}": ${text.replaceAll('\n', ' ').slice(0, 120)}` }))
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
  const pageId = await openPage({ url, background: true })

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
  await acquireRequestLock({ attemptsLeft: lockAttempts })

  try {
    const slot = Math.max(Date.now(), readLastSlot() + minRequestGapMs)
    writeFileSync(lastSlotPath, String(slot))
    return slot
  } finally {
    rmSync(requestLockPath, { force: true, recursive: true })
  }
}

interface AcquireRequestLockInput {
  attemptsLeft: number
}

async function acquireRequestLock({ attemptsLeft }: AcquireRequestLockInput): Promise<void> {
  return match({ created: tryCreateLock(requestLockPath), exhausted: attemptsLeft === 0 })
    .with({ created: true }, () => undefined)
    .with({ exhausted: true }, () => takeOverStaleRequestLock())
    .otherwise(async () => {
      await Bun.sleep(lockRetryMs)
      return acquireRequestLock({ attemptsLeft: attemptsLeft - 1 })
    })
}

function tryCreateLock(path: string): boolean {
  try {
    mkdirSync(path)
    return true
  } catch {
    return false
  }
}

function takeOverStaleRequestLock(): void {
  removeLockOlderThan({ path: requestLockPath, maxAgeMs: staleLockMs })
  if (!tryCreateLock(requestLockPath)) {
    throw new RedditPageError({ refusal: PageRefusal.Unexpected, detail: 'another search-reddit run holds the request lock; retry in a few seconds' })
  }
}

interface RemoveLockOlderThanInput {
  path: string
  maxAgeMs: number
}

function removeLockOlderThan({ path, maxAgeMs }: RemoveLockOlderThanInput): void {
  const lockedAtMs = statSync(path, { throwIfNoEntry: false })?.mtimeMs
  if (lockedAtMs === undefined) return

  if (Date.now() - lockedAtMs > maxAgeMs) rmSync(path, { force: true, recursive: true })
}

function readLastSlot(): number {
  try {
    return z.coerce.number().int().nonnegative().catch(0).parse(readFileSync(lastSlotPath, 'utf8'))
  } catch {
    return 0
  }
}
