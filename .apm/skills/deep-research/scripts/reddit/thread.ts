import { orderBy, take } from 'es-toolkit@1.52.0'
import { match } from 'ts-pattern@5.9.0'
import { z } from 'zod@4.6.5'

export const wwwBase = 'https://www.reddit.com'

const removedBodies = new Set(['', '[deleted]', '[removed]'])

export enum CommentSort {
  Top = 'top',
  Best = 'best',
  New = 'new',
  Old = 'old',
  Controversial = 'controversial',
  Qa = 'qa',
}

export interface CommentOptions {
  perLevel: number
  maxDepth: number
  sort: CommentSort
}

export const Post = z.object({
  title: z.string().nullish(),
  subreddit: z.string().nullish(),
  score: z.number().nullish(),
  num_comments: z.number().nullish(),
  created_utc: z.number().nullish(),
  permalink: z.string().nullish(),
  selftext: z.string().nullish(),
  author: z.string().nullish(),
})
export type Post = z.infer<typeof Post>

export const ThreadResponse = z.tuple([
  z.object({ data: z.object({ children: z.array(z.object({ data: Post })).min(1) }) }),
  z.object({ data: z.object({ children: z.array(z.unknown()) }) }),
])

const CommentThing = z.object({
  kind: z.literal('t1'),
  data: z.object({
    author: z.string().nullish(),
    score: z.number().nullish(),
    created_utc: z.number().nullish(),
    body: z.string().nullish(),
    replies: z.unknown().optional(),
  }),
})
type CommentData = z.infer<typeof CommentThing>['data']

const RepliesListing = z.object({ data: z.object({ children: z.array(z.unknown()) }) })

export interface PostSummary {
  title: string
  subreddit: string
  score: number | null
  num_comments: number | null
  created_utc: number
  url: string
  selftext: string
  author: string
}

export interface Comment {
  author: string | null
  score: number | null
  body: string
  depth: number
}

export interface Thread {
  title: string | null
  subreddit: string | null
  score: number | null
  num_comments: number | null
  url: string
  author: string | null
  selftext: string
  comment_sort: CommentSort
  top_comments: Comment[]
}

export function toPostSummary(post: Post): PostSummary {
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

interface ToThreadInput {
  post: Post
  comments: Comment[]
  postId: string
  sort: CommentSort
}

export function toThread({ post, comments, postId, sort }: ToThreadInput): Thread {
  return {
    title: post.title ?? null,
    subreddit: post.subreddit ?? null,
    score: post.score ?? null,
    num_comments: post.num_comments ?? null,
    url: wwwBase + (post.permalink ?? `/comments/${postId}/`),
    author: post.author ?? null,
    selftext: post.selftext ?? '',
    comment_sort: sort,
    top_comments: comments,
  }
}

interface ExtractCommentsInput {
  items: unknown[]
  options: CommentOptions
  serverSorted: boolean
}

export function extractComments({ items, options, serverSorted }: ExtractCommentsInput): Comment[] {
  return extractLevel({ items, depth: 0, options, serverSorted })
}

interface ExtractLevelInput extends ExtractCommentsInput {
  depth: number
}

function extractLevel({ items, depth, options, serverSorted }: ExtractLevelInput): Comment[] {
  if (depth >= options.maxDepth) return []

  const comments = parseComments(items).filter((comment) => !removedBodies.has(comment.body ?? ''))
  const ranked = rankComments({ comments, sort: options.sort, serverSorted })

  return take(ranked, options.perLevel).flatMap((comment) => [
    { author: comment.author ?? null, score: comment.score ?? null, body: comment.body ?? '', depth },
    ...extractLevel({ items: childItems(comment), depth: depth + 1, options, serverSorted }),
  ])
}

interface RankCommentsInput {
  comments: CommentData[]
  sort: CommentSort
  serverSorted: boolean
}

function rankComments({ comments, sort, serverSorted }: RankCommentsInput): CommentData[] {
  return match({ sort, serverSorted })
    .with({ serverSorted: true }, () => comments)
    .with({ sort: CommentSort.New }, () => orderBy(comments, [(comment) => comment.created_utc ?? 0], ['desc']))
    .with({ sort: CommentSort.Old }, () => orderBy(comments, [(comment) => comment.created_utc ?? 0], ['asc']))
    .otherwise(() => orderBy(comments, [(comment) => comment.score ?? 0], ['desc']))
}

function childItems(comment: CommentData): unknown[] {
  const replies = RepliesListing.safeParse(comment.replies)
  return replies.success ? replies.data.data.children : []
}

function parseComments(items: unknown[]): CommentData[] {
  return items.flatMap((item) => {
    const parsed = CommentThing.safeParse(item)
    return parsed.success ? [parsed.data.data] : []
  })
}
