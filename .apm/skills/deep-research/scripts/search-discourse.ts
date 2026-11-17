#!/usr/bin/env bun
import { defineCommand } from 'citty@0.2.2'
import { sortBy, take, trim } from 'es-toolkit@1.52.0'
import { z } from 'zod@4.6.5'
import { emit, jsonArg, limitArg, printBlock, printEntries, readLimit, requestJson, runCli, stripHtml, toAbsoluteUrl } from './lib'

const hostsByAlias = new Map([
  ['rust', 'users.rust-lang.org'],
  ['pytorch', 'discuss.pytorch.org'],
  ['obsidian', 'forum.obsidian.md'],
  ['hass', 'community.home-assistant.io'],
  ['homeassistant', 'community.home-assistant.io'],
  ['swift', 'forums.swift.org'],
  ['elixir', 'elixirforum.com'],
  ['docker', 'forums.docker.com'],
  ['meta', 'meta.discourse.org'],
  ['leaflet', 'leafletjs.com'],
])

const requestHeaders = {
  'User-Agent': 'Mozilla/5.0 (research-cli; personal use)',
  Accept: 'application/json',
}

const LatestResponse = z.object({
  topic_list: z.object({
    topics: z.array(
      z.object({
        id: z.number(),
        slug: z.string(),
        title: z.string(),
        posts_count: z.number().nullish(),
        reply_count: z.number().nullish(),
        views: z.number().nullish(),
        created_at: z.string().nullish(),
        last_posted_at: z.string().nullish(),
      }),
    ),
  }),
})

const TopicResponse = z.object({
  title: z.string(),
  slug: z.string(),
  posts_count: z.number().nullish(),
  post_stream: z.object({
    posts: z.array(
      z.object({
        username: z.string().nullish(),
        post_number: z.number(),
        score: z.number().nullish(),
        created_at: z.string().nullish(),
        cooked: z.string().nullish(),
      }),
    ),
  }),
})

interface TopicSummary {
  title: string
  url: string
  posts_count: number | null
  reply_count: number | null
  views: number | null
  created_at: string | null
  last_posted_at: string | null
}

interface TopicPost {
  username: string | null
  post_number: number
  score: number | null
  created_at: string | null
  body: string
}

interface Topic {
  title: string
  url: string
  posts_count: number | null
  posts: TopicPost[]
}

const latest = defineCommand({
  meta: { name: 'latest', description: 'List recent topics from an instance (trend monitoring)' },
  args: {
    instance: { type: 'positional', required: true, description: 'Alias (rust, pytorch, obsidian, hass, ...) or host (forum.example.com)' },
    limit: limitArg(20),
    json: jsonArg,
  },
  async run({ args }) {
    const topics = await listLatestTopics({ instance: args.instance, limit: readLimit(args.limit) })
    emit({ value: topics, json: args.json, printMarkdown: printTopicSummaries })
  },
})

const fetchCommand = defineCommand({
  meta: { name: 'fetch', description: 'Fetch a topic thread with its posts' },
  args: {
    url: { type: 'positional', required: true, description: 'Topic URL, e.g. https://users.rust-lang.org/t/slug/12345' },
    limit: limitArg(20, 'Max posts to return from the thread'),
    json: jsonArg,
  },
  async run({ args }) {
    const topic = await fetchTopic({ url: args.url, maxPosts: readLimit(args.limit) })
    emit({ value: topic, json: args.json, printMarkdown: printTopic })
  },
})

const instances = defineCommand({
  meta: { name: 'instances', description: 'List known instance aliases' },
  run() {
    for (const [alias, host] of sortBy([...hostsByAlias], [([alias]) => alias])) {
      console.log(`${alias.padEnd(16)} ${host}`)
    }
  },
})

const main = defineCommand({
  meta: {
    name: 'search-discourse',
    description:
      "Discourse forum reader. Robots-compliant: uses /latest.json and /t/<id>.json only (their robots.txt disallows /search). Discover threads with WebSearch 'site:host query', then fetch them here.",
  },
  subCommands: { latest, fetch: fetchCommand, instances },
})

interface ListLatestTopicsInput {
  instance: string
  limit: number
}

async function listLatestTopics({ instance, limit }: ListLatestTopicsInput): Promise<TopicSummary[]> {
  const host = resolveHost(instance)
  const response = await requestJson({ url: `https://${host}/latest.json`, headers: requestHeaders, schema: LatestResponse })

  return take(response.topic_list.topics, limit).map((topic) => ({
    title: topic.title,
    url: `https://${host}/t/${topic.slug}/${topic.id}`,
    posts_count: topic.posts_count ?? null,
    reply_count: topic.reply_count ?? null,
    views: topic.views ?? null,
    created_at: topic.created_at ?? null,
    last_posted_at: topic.last_posted_at ?? null,
  }))
}

interface FetchTopicInput {
  url: string
  maxPosts: number
}

async function fetchTopic({ url, maxPosts }: FetchTopicInput): Promise<Topic> {
  const topicUrl = toAbsoluteUrl(url)
  const topicId = topicUrl.pathname.match(/\/t\/(?:[^/]+\/)?(\d+)/)?.[1]
  if (topicId === undefined) throw new Error(`Cannot parse a Discourse topic URL: ${url}`)

  const response = await requestJson({ url: `https://${topicUrl.host}/t/${topicId}.json`, headers: requestHeaders, schema: TopicResponse })
  return {
    title: response.title,
    url: `https://${topicUrl.host}/t/${response.slug}/${topicId}`,
    posts_count: response.posts_count ?? null,
    posts: take(response.post_stream.posts, maxPosts).map((post) => ({
      username: post.username ?? null,
      post_number: post.post_number,
      score: post.score ?? null,
      created_at: post.created_at ?? null,
      body: stripHtml(post.cooked),
    })),
  }
}

function resolveHost(instance: string): string {
  const name = instance.trim()
  return hostsByAlias.get(name) ?? trim(name.replace(/^https?:\/\//, ''), '/')
}

function printTopicSummaries(topics: TopicSummary[]): void {
  printEntries({
    entries: topics,
    emptyMessage: 'No topics.',
    toBlock: (topic) => [`[${topic.posts_count ?? '?'} posts | ${topic.views ?? '?'} views] ${topic.title}`, `  ${topic.url}`],
  })
}

function printTopic(topic: Topic): void {
  printBlock([`# ${topic.title}`, `${topic.url} · ${topic.posts_count ?? '?'} posts`])

  for (const post of topic.posts) {
    const marker = post.post_number === 1 ? 'OP' : `#${post.post_number}`
    printBlock([`[${marker}] ${post.username ?? '?'}:`, `  ${post.body.slice(0, 800)}`])
  }
}

await runCli(main)
