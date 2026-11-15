#!/usr/bin/env bun
import { defineCommand } from 'citty@0.2.2'
import { trimEnd } from 'es-toolkit@1.52.0'
import { match, P } from 'ts-pattern@5.9.0'
import {
  CommandError,
  describeError,
  emit,
  fail,
  HttpError,
  jsonArg,
  limitArg,
  printBlock,
  printComment,
  printEntries,
  ReportError,
  readLimit,
  runCli,
  toAbsoluteUrl,
  toOneLine,
} from './lib'
import {
  ArcticSort,
  describeArcticHttpError,
  describeBrowserFailure,
  fetchViaArctic,
  fetchViaBrowser,
  listArcticPosts,
  type PostSummary,
  RedditPageError,
  resolveShareLink,
  type SearchPostsInput,
  SearchSort,
  searchViaArctic,
  searchViaBrowser,
  type Thread,
  TimeRange,
} from './reddit'

enum Stage {
  Browser = 'browser',
  Arctic = 'arctic',
}

const browserNote = 'Reddit via the chrome-cdp Chrome session'
const arcticSearchNote = 'Arctic Shift archive: title-only match, newest first regardless of --sort, scores are archive snapshots'
const arcticFetchNote = 'Arctic Shift archive, scores are archive snapshots'
const noArchiveHint = 'No archive fallback without --sub: Arctic Shift title search is subreddit-scoped, and its full-text search times out.'

interface StageFailure {
  stage: Stage
  reason: string
}

interface StageAttempt<T> {
  stage: Stage
  note: string
  run: () => Promise<T>
}

interface StageResult<T> {
  value: T
  stage: Stage
  note: string
  failures: StageFailure[]
}

interface PostRef {
  kind: 'post'
  postId: string
}

interface ShareRef {
  kind: 'share'
  url: string
}

type ThreadRef = PostRef | ShareRef

interface AllStagesFailedErrorInput {
  operation: string
  failures: StageFailure[]
  hint: string | undefined
}

class AllStagesFailedError extends ReportError {
  public constructor({ operation, failures, hint }: AllStagesFailedErrorInput) {
    super([`search-reddit ${operation}: every stage failed`, ...failures.map(formatFailure), ...(hint ? [hint] : [])].join('\n'))
  }
}

const search = defineCommand({
  meta: { name: 'search', description: 'Search Reddit posts' },
  args: {
    query: { type: 'positional', required: true, description: 'Search query' },
    sub: { type: 'string', description: 'Restrict to subreddit (e.g. typescript, selfhosted); enables the Arctic Shift fallback' },
    sort: { type: 'enum', options: Object.values(SearchSort), default: SearchSort.Relevance, description: 'Sort order' },
    time: { type: 'enum', options: Object.values(TimeRange), default: TimeRange.All, description: 'Time range' },
    limit: limitArg(20),
    json: jsonArg,
  },
  async run({ args }) {
    const result = await searchPosts({ query: args.query, sub: args.sub, sort: args.sort, timeRange: args.time, limit: readLimit(args.limit) })
    reportFallback(result)
    emit({ value: result.value, json: args.json, printMarkdown: printPosts })
  },
})

const fetchCommand = defineCommand({
  meta: { name: 'fetch', description: 'Fetch a specific thread with top comments' },
  args: {
    url: { type: 'positional', required: true, description: 'Thread URL: reddit.com/.../comments/<id>, redd.it/<id> or a /r/<sub>/s/<token> share link' },
    json: jsonArg,
  },
  async run({ args }) {
    const result = await fetchThread(parseThreadUrl(args.url))
    reportFallback(result)
    emit({ value: result.value, json: args.json, printMarkdown: printThread })
  },
})

const arcticCommand = defineCommand({
  meta: { name: 'arctic', description: 'List a subreddit chronologically via the Arctic Shift archive (no auth)' },
  args: {
    subreddit: { type: 'positional', required: true, description: 'Subreddit name (e.g. rust, ClaudeAI)' },
    title: { type: 'string', description: 'Only posts whose title matches these words (archive-side title search)' },
    after: { type: 'string', description: 'Only posts on/after this date (YYYY-MM-DD)' },
    before: { type: 'string', description: 'Only posts before this date (YYYY-MM-DD)' },
    sort: { type: 'enum', options: Object.values(ArcticSort), default: ArcticSort.Desc, description: 'desc = newest first, asc = oldest first' },
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
      limit: readLimit(args.limit),
    }).catch((error: unknown) => fail(`search-reddit arctic: ${describeFailure(error)}`))
    emit({ value: posts, json: args.json, printMarkdown: printPosts })
  },
})

const main = defineCommand({
  meta: {
    name: 'search-reddit',
    description: 'Reddit search and thread fetch through the signed-in chrome-cdp Chrome, with the Arctic Shift archive as fallback',
  },
  subCommands: { search, fetch: fetchCommand, arctic: arcticCommand },
})

function searchPosts(input: SearchPostsInput): Promise<StageResult<PostSummary[]>> {
  const { sub } = input
  const browser = { stage: Stage.Browser, note: browserNote, run: () => searchViaBrowser(input) }
  const arctic = sub === undefined ? null : { stage: Stage.Arctic, note: arcticSearchNote, run: () => searchViaArctic({ ...input, sub }) }

  return runStages({ operation: 'search', attempts: arctic === null ? [browser] : [browser, arctic], hint: arctic === null ? noArchiveHint : undefined })
}

async function fetchThread(ref: ThreadRef): Promise<StageResult<Thread>> {
  const postId = await match(ref)
    .with({ kind: 'post' }, ({ postId: id }) => id)
    .with({ kind: 'share' }, ({ url }) => resolveShareLink(url).catch((error: unknown) => fail(`search-reddit fetch: ${describeFailure(error)}`)))
    .exhaustive()

  return runStages({
    operation: 'fetch',
    attempts: [
      { stage: Stage.Browser, note: browserNote, run: () => fetchViaBrowser(postId) },
      { stage: Stage.Arctic, note: arcticFetchNote, run: () => fetchViaArctic(postId) },
    ],
    hint: undefined,
  })
}

interface RunStagesInput<T> {
  operation: string
  attempts: Array<StageAttempt<T>>
  hint: string | undefined
}

async function runStages<T>({ operation, attempts, hint }: RunStagesInput<T>): Promise<StageResult<T>> {
  const failures: StageFailure[] = []

  for (const { stage, note, run } of attempts) {
    try {
      return { value: await run(), stage, note, failures }
    } catch (error) {
      failures.push({ stage, reason: describeFailure(error) })
    }
  }

  throw new AllStagesFailedError({ operation, failures, hint })
}

function reportFallback<T>({ stage, note, failures }: StageResult<T>): void {
  if (failures.length === 0) return

  process.stderr.write(`${[`note: served by ${stage} (${note}); earlier stages failed:`, ...failures.map(formatFailure)].join('\n')}\n`)
}

function formatFailure({ stage, reason }: StageFailure): string {
  return `  ${stage}: ${reason}`
}

function describeFailure(error: unknown): string {
  return match(error)
    .with(P.instanceOf(RedditPageError), (failure) => failure.message)
    .with(P.intersection(P.instanceOf(CommandError), { command: 'chrome-devtools' }), describeBrowserFailure)
    .with(P.instanceOf(HttpError), describeArcticHttpError)
    .otherwise(describeError)
}

function parseThreadUrl(url: string): ThreadRef {
  const threadUrl = toAbsoluteUrl(url)
  const path = trimEnd(threadUrl.pathname, '/')

  return match({
    isReddit: /(^|\.)reddit\.com$/.test(threadUrl.hostname),
    isShortLink: threadUrl.hostname === 'redd.it',
    isShare: /^\/r\/[^/]+\/s\/[A-Za-z0-9]+$/.test(path),
    commentsId: path.match(/\/comments\/([a-z0-9]+)/)?.[1],
    shortId: path.match(/^\/([a-z0-9]+)$/)?.[1],
  })
    .returnType<ThreadRef>()
    .with({ isReddit: true, commentsId: P.string }, ({ commentsId }) => ({ kind: 'post', postId: commentsId }))
    .with({ isReddit: true, isShare: true }, () => ({ kind: 'share', url: threadUrl.href }))
    .with({ isShortLink: true, shortId: P.string }, ({ shortId }) => ({ kind: 'post', postId: shortId }))
    .otherwise(() => fail(`search-reddit fetch: not a thread URL (expected reddit.com/.../comments/<id>, redd.it/<id> or /r/<sub>/s/<token>): ${url}`))
}

interface FormatScoreInput {
  score: number | null
  width: number
}

function formatScore({ score, width }: FormatScoreInput): string {
  return `${(score === null ? '?' : String(score)).padStart(width)} pts`
}

function printPosts(posts: PostSummary[]): void {
  printEntries({
    entries: posts,
    emptyMessage: 'No results.',
    toBlock: (post) => [
      `[${formatScore({ score: post.score, width: 5 })} | ${post.num_comments ?? '?'} cmts | r/${post.subreddit}] ${post.title}`,
      `  ${post.url}`,
      post.selftext ? `  ${toOneLine({ text: post.selftext, maxLength: 200 })}` : null,
    ],
  })
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
    printComment({ depth: comment.depth, header: `[${formatScore({ score: comment.score, width: 4 })}] u/${comment.author ?? ''}:`, body: comment.body })
  }
}

await runCli(main)
