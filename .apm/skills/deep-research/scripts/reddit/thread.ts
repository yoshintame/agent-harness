import { orderBy, take } from 'es-toolkit@1.52.0'
import { match, P } from 'ts-pattern@5.9.0'
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

export enum PostKind {
  Text = 'text',
  Image = 'image',
  Gallery = 'gallery',
  Video = 'video',
  Link = 'link',
}

export interface FlairFilter {
  include: string[]
  exclude: string[]
}

export interface CommentOptions {
  perLevel: number
  maxDepth: number
  sort: CommentSort
}

export const Post = z.object({
  id: z.string().nullish(),
  title: z.string().nullish(),
  subreddit: z.string().nullish(),
  score: z.number().nullish(),
  num_comments: z.number().nullish(),
  created_utc: z.number().nullish(),
  permalink: z.string().nullish(),
  selftext: z.string().nullish(),
  author: z.string().nullish(),
  link_flair_text: z.string().nullish(),
  post_hint: z.string().nullish(),
  is_self: z.boolean().nullish(),
  is_gallery: z.boolean().nullish(),
  is_video: z.boolean().nullish(),
  url: z.string().nullish(),
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
  id: string
  title: string
  subreddit: string
  score: number | null
  num_comments: number | null
  created_utc: number
  url: string
  selftext: string
  author: string
  flair: string | null
  kind: PostKind | null
  link: string | null
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
  const kind = toPostKind(post)
  return {
    id: post.id ?? '',
    title: post.title ?? '',
    subreddit: post.subreddit ?? '',
    score: post.score ?? null,
    num_comments: post.num_comments ?? null,
    created_utc: post.created_utc ?? 0,
    url: wwwBase + (post.permalink ?? ''),
    selftext: (post.selftext ?? '').slice(0, 300),
    author: post.author ?? '',
    flair: post.link_flair_text ? post.link_flair_text : null,
    kind,
    link: kind === PostKind.Link ? (post.url ?? null) : null,
  }
}

function toPostKind(post: Post): PostKind {
  return match(post)
    .with({ is_self: true }, () => PostKind.Text)
    .with({ is_gallery: true }, () => PostKind.Gallery)
    .with(P.union({ is_video: true }, { post_hint: P.union('hosted:video', 'rich:video') }), () => PostKind.Video)
    .with({ post_hint: 'image' }, () => PostKind.Image)
    .otherwise(() => PostKind.Link)
}

interface MatchesFlairFilterInput {
  post: PostSummary
  filter: FlairFilter
}

export function matchesFlairFilter({ post, filter }: MatchesFlairFilterInput): boolean {
  const flair = post.flair?.toLowerCase() ?? null
  const included = filter.include.length === 0 ? true : filter.include.some((wanted) => wanted.toLowerCase() === flair)
  const excluded = flair === null ? false : filter.exclude.some((unwanted) => unwanted.toLowerCase() === flair)
  return included ? !excluded : false
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
