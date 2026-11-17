import { type FlairFilter, matchesFlairFilter, type PostSummary } from './thread'

const defaultMaxPages = 5

interface CollectMatchingInput {
  pages: AsyncIterable<PostSummary[]>
  filter: FlairFilter
  limit: number
  maxPages?: number
}

export async function collectMatching({ pages, filter, limit, maxPages = defaultMaxPages }: CollectMatchingInput): Promise<PostSummary[]> {
  const collected: PostSummary[] = []
  const progress = { pagesRead: 0 }

  for await (const page of pages) {
    collected.push(...page.filter((post) => matchesFlairFilter({ post, filter })))
    progress.pagesRead += 1
    if ([collected.length >= limit, progress.pagesRead >= maxPages].some(Boolean)) break
  }

  return collected.slice(0, limit)
}

export async function* singlePage(posts: Promise<PostSummary[]>): AsyncGenerator<PostSummary[]> {
  yield await posts
}
