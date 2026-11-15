import { orderBy, take } from 'es-toolkit@1.52.0'
import { z } from 'zod@4.6.5'

export const wwwBase = 'https://www.reddit.com'

const maxCommentDepth = 2
const maxCommentsPerLevel = 10
const removedBodies = new Set(['', '[deleted]', '[removed]'])

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
}

export function toThread({ post, comments, postId }: ToThreadInput): Thread {
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

export function extractComments({ items, depth, byScore }: ExtractCommentsInput): Comment[] {
  const comments = items.flatMap((item) => {
    const parsed = CommentThing.safeParse(item)
    return parsed.success ? [parsed.data.data] : []
  })
  const ranked = byScore ? orderBy(comments, [(comment) => comment.score ?? 0], ['desc']) : comments

  return take(ranked, maxCommentsPerLevel).flatMap((comment) => toCommentWithReplies({ comment, depth, byScore }))
}

interface ToCommentWithRepliesInput {
  comment: CommentData
  depth: number
  byScore: boolean
}

function toCommentWithReplies({ comment, depth, byScore }: ToCommentWithRepliesInput): Comment[] {
  const body = comment.body ?? ''
  if (removedBodies.has(body)) return []

  const replies = RepliesListing.safeParse(comment.replies)
  const nested = replies.success ? extractReplies({ children: replies.data.data.children, depth, byScore }) : []
  return [{ author: comment.author ?? null, score: comment.score ?? null, body, depth }, ...nested]
}

interface ExtractRepliesInput {
  children: unknown[]
  depth: number
  byScore: boolean
}

function extractReplies({ children, depth, byScore }: ExtractRepliesInput): Comment[] {
  return depth < maxCommentDepth ? extractComments({ items: children, depth: depth + 1, byScore }) : []
}
