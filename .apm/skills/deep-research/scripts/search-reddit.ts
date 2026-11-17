#!/usr/bin/env bun
import { type ArgsDef, defineCommand } from 'citty@0.2.2'
import { compact, take, trimEnd } from 'es-toolkit@1.52.0'
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
  parseCount,
  ReportError,
  readLimit,
  runCli,
  toAbsoluteUrl,
  toOneLine,
} from './lib'
import {
  ArcticSort,
  type CommentOptions,
  CommentSort,
  describeArcticHttpError,
  describeBrowserFailure,
  enrichFromArchive,
  type FlairFilter,
  fetchViaArctic,
  fetchViaBrowser,
  listArcticPosts,
  listFlairs,
  ListingSort,
  listViaBrowser,
  matchesFlairFilter,
  type PostSummary,
  RedditPageError,
  resolveShareLink,
  type SearchPostsInput,
  SearchSort,
  type SubredditFlair,
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
const maxWidenedLimit = 100
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

const flairArgs = {
  flair: { type: 'string', description: 'Keep only posts with these flairs (comma-separated, case-insensitive)' },
  'exclude-flair': { type: 'string', description: 'Drop posts with these flairs, e.g. Meme' },
} as const satisfies ArgsDef

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
    ...flairArgs,
    json: jsonArg,
  },
  async run({ args }) {
    const filter = parseFlairFilter({ include: args.flair, exclude: args['exclude-flair'] })
    const limit = readLimit(args.limit)
    const result = await searchPosts({ query: args.query, sub: args.sub, sort: args.sort, timeRange: args.time, limit: widenForFilter({ limit, filter }) })
    reportFallback(result)
    const posts = await addArchiveDetails(result)
    emit({ value: take(posts.filter((post) => matchesFlairFilter({ post, filter })), limit), json: args.json, printMarkdown: printPosts })
  },
})

const top = defineCommand({
  meta: { name: 'top', description: "List a subreddit's own tabs (top, hot, new, rising, controversial) without a query" },
  args: {
    subreddit: { type: 'positional', required: true, description: 'Subreddit name (e.g. StremioAddons)' },
    sort: { type: 'enum', options: Object.values(ListingSort), default: ListingSort.Top, description: 'Subreddit tab' },
    time: { type: 'enum', options: Object.values(TimeRange), default: TimeRange.Year, description: 'Time range for top and controversial' },
    limit: limitArg(25),
    ...flairArgs,
    json: jsonArg,
  },
  async run({ args }) {
    const posts = await listViaBrowser({
      sub: args.subreddit,
      sort: args.sort,
      timeRange: args.time,
      limit: readLimit(args.limit),
      filter: parseFlairFilter({ include: args.flair, exclude: args['exclude-flair'] }),
    }).catch((error: unknown) => fail(`search-reddit top: ${describeFailure(error)}\nWithout Reddit, \`search-reddit arctic <sub>\` lists the subreddit chronologically from the archive.`))
    emit({ value: posts, json: args.json, printMarkdown: printPosts })
  },
})

const fetchCommand = defineCommand({
  meta: { name: 'fetch', description: 'Fetch a specific thread with its comments' },
  args: {
    url: { type: 'positional', required: true, description: 'Thread URL: reddit.com/.../comments/<id>, redd.it/<id> or a /r/<sub>/s/<token> share link' },
    comments: { type: 'string', default: '10', description: 'Comments per level; 0 fetches the post alone' },
    depth: { type: 'string', default: '3', description: 'Comment levels to keep; 1 keeps top-level comments only' },
    sort: {
      type: 'enum',
      options: Object.values(CommentSort),
      default: CommentSort.Top,
      description: 'Comment order, sorted by Reddit',
    },
    json: jsonArg,
  },
  async run({ args }) {
    const options = {
      perLevel: parseCount({ flag: 'comments', value: args.comments }),
      maxDepth: parseCount({ flag: 'depth', value: args.depth }),
      sort: args.sort,
    }
    const result = await fetchThread({ ref: parseThreadUrl(args.url), options })
    reportFallback(result)
    emit({ value: result.value, json: args.json, printMarkdown: printThread })
  },
})

const flairsCommand = defineCommand({
  meta: { name: 'flairs', description: 'List the post flairs a subreddit offers, for --flair and --exclude-flair' },
  args: {
    subreddit: { type: 'positional', required: true, description: 'Subreddit name (e.g. StremioAddons)' },
    json: jsonArg,
  },
  async run({ args }) {
    const flairs = await listFlairs(args.subreddit).catch((error: unknown) => fail(`search-reddit flairs: ${describeFailure(error)}`))
    emit({ value: flairs, json: args.json, printMarkdown: printFlairs })
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
    ...flairArgs,
    json: jsonArg,
  },
  async run({ args }) {
    const filter = parseFlairFilter({ include: args.flair, exclude: args['exclude-flair'] })
    const limit = readLimit(args.limit)
    const posts = await listArcticPosts({
      subreddit: args.subreddit,
      title: args.title,
      after: args.after,
      before: args.before,
      sort: args.sort,
      limit: widenForFilter({ limit, filter }),
    }).catch((error: unknown) => fail(`search-reddit arctic: ${describeFailure(error)}`))
    emit({ value: take(posts.filter((post) => matchesFlairFilter({ post, filter })), limit), json: args.json, printMarkdown: printPosts })
  },
})

const main = defineCommand({
  meta: {
    name: 'search-reddit',
    description: 'Reddit search and thread fetch through the signed-in chrome-cdp Chrome, with the Arctic Shift archive as fallback',
  },
  subCommands: { search, top, flairs: flairsCommand, fetch: fetchCommand, arctic: arcticCommand },
})

function searchPosts(input: SearchPostsInput): Promise<StageResult<PostSummary[]>> {
  const { sub } = input
  const browser = { stage: Stage.Browser, note: browserNote, run: () => searchViaBrowser(input) }
  const arctic = sub === undefined ? null : { stage: Stage.Arctic, note: arcticSearchNote, run: () => searchViaArctic({ ...input, sub }) }

  return runStages({ operation: 'search', attempts: arctic === null ? [browser] : [browser, arctic], hint: arctic === null ? noArchiveHint : undefined })
}

interface ParseFlairFilterInput {
  include: string | undefined
  exclude: string | undefined
}

function parseFlairFilter({ include, exclude }: ParseFlairFilterInput): FlairFilter {
  return { include: splitList(include), exclude: splitList(exclude) }
}

function splitList(value: string | undefined): string[] {
  return compact((value ?? '').split(',').map((item) => item.trim()))
}

interface WidenForFilterInput {
  limit: number
  filter: FlairFilter
}

function widenForFilter({ limit, filter }: WidenForFilterInput): number {
  const filtering = filter.include.length + filter.exclude.length > 0
  return filtering ? Math.min(limit * 3, maxWidenedLimit) : limit
}

async function addArchiveDetails({ value, stage }: StageResult<PostSummary[]>): Promise<PostSummary[]> {
  if (stage === Stage.Arctic) return value

  return enrichFromArchive(value).catch((error: unknown) => {
    process.stderr.write(`note: flair and post text unavailable: ${describeFailure(error)}\n`)
    return value
  })
}

interface FetchThreadInput {
  ref: ThreadRef
  options: CommentOptions
}

async function fetchThread({ ref, options }: FetchThreadInput): Promise<StageResult<Thread>> {
  const postId = await match(ref)
    .with({ kind: 'post' }, ({ postId: id }) => id)
    .with({ kind: 'share' }, ({ url }) => resolveShareLink(url).catch((error: unknown) => fail(`search-reddit fetch: ${describeFailure(error)}`)))
    .exhaustive()

  return runStages({
    operation: 'fetch',
    attempts: [
      { stage: Stage.Browser, note: browserNote, run: () => fetchViaBrowser({ postId, options }) },
      { stage: Stage.Arctic, note: arcticFetchNote, run: () => fetchViaArctic({ postId, options }) },
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
  const subreddits = new Set(posts.map((post) => post.subreddit))
  const sharedSubreddit = subreddits.size === 1 ? [...subreddits][0] : undefined
  if (sharedSubreddit) printBlock([`## r/${sharedSubreddit}`])

  printEntries({
    entries: posts,
    emptyMessage: 'No results.',
    toBlock: (post) => {
      const date = post.created_utc > 0 ? describeDates({ createdUtc: post.created_utc, editedUtc: post.edited_utc }) : null
      const subreddit = sharedSubreddit ? null : `r/${post.subreddit}`
      const labels = compact([date, subreddit, post.flair, post.kind]).join(' | ')
      return [
        `[${formatScore({ score: post.score, width: 5 })} | ${post.num_comments ?? '?'} cmts | ${labels}] ${post.title}`,
        `  ${post.url}`,
        post.link ? `  -> ${post.link}` : null,
        post.selftext ? `  ${toOneLine({ text: post.selftext, maxLength: 300 })}` : null,
      ]
    },
  })
}

interface DescribeDatesInput {
  createdUtc: number
  editedUtc: number | null
}

function describeDates({ createdUtc, editedUtc }: DescribeDatesInput): string {
  const created = toIsoDate(createdUtc)
  const edited = editedUtc === null ? created : toIsoDate(editedUtc)
  return edited === created ? created : `${created}, edited ${edited}`
}

function toIsoDate(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000)
  return Number.isNaN(date.getTime()) ? '?' : date.toISOString().slice(0, 10)
}

function printFlairs(flairs: SubredditFlair[]): void {
  if (flairs.length === 0) return console.log('This subreddit offers no post flairs.')

  for (const flair of flairs) console.log(flair.mod_only ? `${flair.text}  (mods only)` : flair.text)
}

function printThread(thread: Thread): void {
  printBlock([
    `# ${thread.title ?? ''}`,
    compact([
      `r/${thread.subreddit ?? ''}`,
      `${thread.score ?? '?'} pts`,
      `${thread.num_comments ?? '?'} comments`,
      `by u/${thread.author ?? ''}`,
      thread.created_utc === null ? null : describeDates({ createdUtc: thread.created_utc, editedUtc: thread.edited_utc }),
    ]).join(' · '),
    thread.url,
  ])
  if (thread.selftext) printBlock([thread.selftext])
  if (thread.top_comments.length === 0) return

  printBlock([`## Comments (${thread.top_comments.length}, sorted by ${thread.comment_sort})`])
  for (const comment of thread.top_comments) {
    const date = comment.created_utc === null ? '' : ` | ${toIsoDate(comment.created_utc)}`
    printComment({ depth: comment.depth, header: `[${formatScore({ score: comment.score, width: 4 })}${date}] u/${comment.author ?? ''}:`, body: comment.body })
  }
}

await runCli(main)
