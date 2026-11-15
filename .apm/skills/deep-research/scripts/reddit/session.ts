import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod@4.6.5'
import { evaluateInPage, keepingFocus, listPages, navigatePage, navigatePageNow, openPage, registerCleanup, withFileLock } from '../lib'
import { cachePaths } from './cache'

const workerMarkerUrl = 'about:blank#search-reddit-worker'
const minRequestGapMs = 5500
const workerWaitMs = 150_000

export class PageMovedError extends Error {
  public readonly href: string

  public constructor(href: string) {
    super(`the agent Chrome tab ended up on ${href}; a redirect or another run moved it`)
    this.href = href
  }
}

interface WithRedditPageInput<T> {
  url: string
  expectInUrl: string
  read: (pageId: number) => Promise<T>
}

export function withRedditPage<T>({ url, expectInUrl, read }: WithRedditPageInput<T>): Promise<T> {
  return withFileLock({
    path: cachePaths.workerLock,
    waitMs: workerWaitMs,
    run: async () => {
      const pageId = await findOrOpenWorkerPage()
      const unregister = registerCleanup(() => navigatePageNow({ pageId, url: workerMarkerUrl }))

      try {
        await waitForRequestGap()
        await navigatePage({ pageId, url })
        const value = await read(pageId)
        await assertPageStayedOn({ pageId, expectInUrl })
        return value
      } finally {
        unregister()
        await navigatePage({ pageId, url: workerMarkerUrl }).catch(() => undefined)
      }
    },
  })
}

async function findOrOpenWorkerPage(): Promise<number> {
  const parked = (await listPages()).find((page) => page.url === workerMarkerUrl)
  return parked === undefined ? keepingFocus(() => openPage({ url: workerMarkerUrl, background: true })) : parked.id
}

interface AssertPageStayedOnInput {
  pageId: number
  expectInUrl: string
}

async function assertPageStayedOn({ pageId, expectInUrl }: AssertPageStayedOnInput): Promise<void> {
  const href = await evaluateInPage({ pageId, source: '() => location.href', schema: z.string() })
  if (!href.toLowerCase().includes(expectInUrl.toLowerCase())) throw new PageMovedError(href)
}

async function waitForRequestGap(): Promise<void> {
  const waitMs = readLastRequestAt() + minRequestGapMs - Date.now()
  if (waitMs > 0) await Bun.sleep(waitMs)

  mkdirSync(dirname(cachePaths.lastRequest), { recursive: true })
  writeFileSync(cachePaths.lastRequest, String(Date.now()))
}

function readLastRequestAt(): number {
  try {
    return z.coerce.number().int().nonnegative().catch(0).parse(readFileSync(cachePaths.lastRequest, 'utf8'))
  } catch {
    return 0
  }
}
