import { trim } from 'es-toolkit@1.52.0'

export enum SearchSort {
  Relevance = 'relevance',
  Top = 'top',
  New = 'new',
  Comments = 'comments',
  Hot = 'hot',
}

export enum TimeRange {
  Hour = 'hour',
  Day = 'day',
  Week = 'week',
  Month = 'month',
  Year = 'year',
  All = 'all',
}

export enum ListingSort {
  Top = 'top',
  Hot = 'hot',
  New = 'new',
  Rising = 'rising',
  Controversial = 'controversial',
}

export enum ArcticSort {
  Desc = 'desc',
  Asc = 'asc',
}

export interface SearchPostsInput {
  query: string
  sub: string | undefined
  sort: SearchSort
  timeRange: TimeRange
  limit: number
}

const hoursByTimeRange = {
  [TimeRange.Hour]: 1,
  [TimeRange.Day]: 24,
  [TimeRange.Week]: 7 * 24,
  [TimeRange.Month]: 31 * 24,
  [TimeRange.Year]: 366 * 24,
  [TimeRange.All]: null,
} as const satisfies Record<TimeRange, number | null>

const booleanOperators = new Set(['AND', 'OR', 'NOT'])

export function toSinceEpochSeconds(timeRange: TimeRange): number | undefined {
  const hours = hoursByTimeRange[timeRange]
  return hours === null ? undefined : Math.floor(Date.now() / 1000) - hours * 3600
}

export function toSubredditName(sub: string): string | null {
  const name = trim(sub.trim().replace(/^\/?r\//i, ''), '/')
  return /^[A-Za-z0-9_]{2,21}$/.test(name) ? name : null
}

export function toArcticTitleWords(query: string): string {
  return query
    .replace(/\b(?:author|subreddit|self|site|url|flair|nsfw):\S+/g, ' ')
    .replace(/\b\w+:/g, ' ')
    .replace(/[+"()]/g, ' ')
    .split(/\s+/)
    .filter((word) => [word !== '', !word.startsWith('-'), !booleanOperators.has(word.toUpperCase())].every(Boolean))
    .join(' ')
}
