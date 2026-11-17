#!/usr/bin/env bun
import { defineCommand } from 'citty@0.2.2'
import $ from 'dax-sh@0.42.0'
import { orderBy, round, take } from 'es-toolkit@1.52.0'
import { z } from 'zod@4.6.5'
import { jsonArg, limitArg, parseCount, printBlock, printJson, runCli } from './lib'

$.setPrintCommand(false)

const dayMs = 24 * 60 * 60 * 1000
const staleAfterDays = 365

const SearchedRepo = z.object({
  fullName: z.string(),
  description: z.string().nullish(),
  stargazersCount: z.number(),
  updatedAt: z.string(),
  language: z.string().nullish(),
  url: z.string(),
})
type SearchedRepo = z.infer<typeof SearchedRepo>

const TopicRepo = z.object({
  fullName: z.string(),
  description: z.string().nullish(),
  stargazersCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const AwesomeRepo = SearchedRepo.omit({ language: true })

const RepoDetails = z.object({
  full_name: z.string(),
  description: z.string().nullish(),
  stargazers_count: z.number(),
  forks_count: z.number(),
  open_issues_count: z.number(),
  license: z.object({ spdx_id: z.string().nullish() }).nullish(),
  pushed_at: z.string(),
  created_at: z.string(),
  archived: z.boolean(),
  fork: z.boolean(),
  html_url: z.string(),
})

interface RepoHealth {
  full_name: string
  description: string | null
  stars: number
  forks: number
  open_issues: number
  license: string
  pushed_at: string
  created_at: string
  age_days: number
  stars_per_day: number
  days_since_push: number
  is_archived: boolean
  is_fork: boolean
  url: string
}

type TrendingRepo = z.infer<typeof TopicRepo> & { stars_per_day: number }
type AwesomeList = z.infer<typeof AwesomeRepo> & { days_since_push: number; stale: boolean }

const search = defineCommand({
  meta: { name: 'search', description: 'Search repos (supports OR syntax)' },
  args: {
    query: { type: 'positional', required: true, description: 'e.g. "awesome X OR awesome Y OR awesome Z"' },
    stars: { type: 'string', description: 'e.g. ">100"' },
    language: { type: 'string', description: 'Primary language' },
    'pushed-after': { type: 'string', description: 'YYYY-MM-DD' },
    limit: limitArg(50),
    json: jsonArg,
  },
  async run({ args }) {
    const repos = await searchRepos({
      query: args.query,
      stars: args.stars,
      language: args.language,
      pushedAfter: args['pushed-after'],
      limit: parseCount({ flag: 'limit', value: args.limit }),
    })
    if (args.json) return printJson(repos)
    printSearchedRepos(repos)
  },
})

const health = defineCommand({
  meta: { name: 'health', description: 'Health check (stars/day, last push, license)' },
  args: {
    repo: { type: 'positional', required: true, description: 'owner/repo' },
    json: jsonArg,
  },
  async run({ args }) {
    const report = await getRepoHealth(args.repo)
    if (args.json) return printJson(report)
    printRepoHealth(report)
  },
})

const trending = defineCommand({
  meta: { name: 'trending', description: 'Topic repos ranked by stars/day' },
  args: {
    topic: { type: 'positional', required: true, description: 'GitHub topic' },
    limit: limitArg(20),
    json: jsonArg,
  },
  async run({ args }) {
    const repos = await getTrendingRepos(args.topic, parseCount({ flag: 'limit', value: args.limit }))
    if (args.json) return printJson(repos)
    printTrendingRepos(repos)
  },
})

const awesome = defineCommand({
  meta: { name: 'awesome', description: 'Find awesome-* lists for a topic (single call)' },
  args: {
    topic: { type: 'positional', required: true, description: 'Topic, e.g. typescript' },
    limit: limitArg(20),
    json: jsonArg,
  },
  async run({ args }) {
    const lists = await findAwesomeLists(args.topic, parseCount({ flag: 'limit', value: args.limit }))
    if (args.json) return printJson(lists)
    printAwesomeLists(lists)
  },
})

const main = defineCommand({
  meta: { name: 'search-github', description: 'GitHub discovery via gh CLI (needs gh auth login)' },
  subCommands: { search, health, trending, awesome },
})

interface SearchReposInput {
  query: string
  stars: string | undefined
  language: string | undefined
  pushedAfter: string | undefined
  limit: number
}

async function searchRepos({ query, stars, language, pushedAfter, limit }: SearchReposInput): Promise<SearchedRepo[]> {
  const filters = [
    ...(stars ? ['--stars', stars] : []),
    ...(language ? ['--language', language] : []),
    ...(pushedAfter ? ['--pushed', `>${pushedAfter}`] : []),
  ]
  const fields = 'fullName,description,stargazersCount,updatedAt,language,url'
  return gh(['search', 'repos', query, '--limit', String(limit), '--sort', 'stars', '--json', fields, ...filters], z.array(SearchedRepo))
}

async function getRepoHealth(repo: string): Promise<RepoHealth> {
  const details = await gh(['api', `repos/${repo}`], RepoDetails)
  const ageDays = Math.max(daysSince(details.created_at), 1)

  return {
    full_name: details.full_name,
    description: details.description ?? null,
    stars: details.stargazers_count,
    forks: details.forks_count,
    open_issues: details.open_issues_count,
    license: details.license?.spdx_id ?? 'none',
    pushed_at: details.pushed_at,
    created_at: details.created_at,
    age_days: ageDays,
    stars_per_day: round(details.stargazers_count / ageDays, 3),
    days_since_push: daysSince(details.pushed_at),
    is_archived: details.archived,
    is_fork: details.fork,
    url: details.html_url,
  }
}

async function getTrendingRepos(topic: string, limit: number): Promise<TrendingRepo[]> {
  const fields = 'fullName,description,stargazersCount,createdAt,updatedAt'
  const repos = await gh(['search', 'repos', `topic:${topic}`, '--limit', String(limit * 2), '--sort', 'stars', '--json', fields], z.array(TopicRepo))
  const ranked = repos.map((repo) => ({
    ...repo,
    stars_per_day: round(repo.stargazersCount / Math.max(daysSince(repo.createdAt), 1), 3),
  }))
  return take(orderBy(ranked, ['stars_per_day'], ['desc']), limit)
}

async function findAwesomeLists(topic: string, limit: number): Promise<AwesomeList[]> {
  const fields = 'fullName,description,stargazersCount,updatedAt,url'
  const repos = await gh(['search', 'repos', `awesome ${topic}`, '--limit', String(limit), '--sort', 'stars', '--json', fields], z.array(AwesomeRepo))
  return repos.map((repo) => {
    const daysSincePush = daysSince(repo.updatedAt)
    return { ...repo, days_since_push: daysSincePush, stale: daysSincePush > staleAfterDays }
  })
}

async function gh<T>(args: string[], schema: z.ZodType<T>): Promise<T> {
  const result = await $`gh ${args}`.stdout('piped').stderr('piped').noThrow()
  if (result.code !== 0) throw new Error(`gh error: ${result.stderr.trim()}`)

  return schema.parse(result.stdout.trim() ? JSON.parse(result.stdout) : [])
}

function daysSince(iso: string): number {
  return Math.floor((Date.now() - Date.parse(iso)) / dayMs)
}

function printSearchedRepos(repos: SearchedRepo[]): void {
  if (repos.length === 0) return console.log('No results.')

  for (const repo of repos) {
    printBlock([
      `[${String(repo.stargazersCount).padStart(6)}★] ${repo.fullName}  ${repo.language ?? ''}`,
      repo.description ? `  ${repo.description}` : null,
      `  updated: ${repo.updatedAt.slice(0, 10)}  ${repo.url}`,
    ])
  }
}

function printRepoHealth(report: RepoHealth): void {
  process.stdout.write(
    `${[
      `# ${report.full_name}`,
      ...(report.description ? [report.description] : []),
      '',
      `★ ${report.stars} (${report.stars_per_day}/day over ${report.age_days} days)`,
      `License: ${report.license}`,
      `Last push: ${report.pushed_at.slice(0, 10)} (${report.days_since_push} days ago)`,
      `Open issues: ${report.open_issues}`,
      ...(report.is_archived ? ['⚠️  ARCHIVED'] : []),
      ...(report.is_fork ? ['⚠️  Fork'] : []),
      report.url,
    ].join('\n')}\n`,
  )
}

function printTrendingRepos(repos: TrendingRepo[]): void {
  if (repos.length === 0) return console.log('No results.')

  for (const repo of repos) {
    printBlock([
      `[${String(repo.stars_per_day).padStart(6)}★/day | ${String(repo.stargazersCount).padStart(6)}★ total] ${repo.fullName}`,
      repo.description ? `  ${repo.description}` : null,
    ])
  }
}

function printAwesomeLists(lists: AwesomeList[]): void {
  if (lists.length === 0) return console.log('No awesome lists found.')

  for (const list of lists) {
    printBlock([
      `[${String(list.stargazersCount).padStart(6)}★]${list.stale ? ' [STALE >1yr]' : ''} ${list.fullName}`,
      list.description ? `  ${list.description}` : null,
      `  updated ${list.updatedAt.slice(0, 10)}  ${list.url}`,
    ])
  }
}

await runCli(main)
