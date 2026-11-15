import $ from 'dax-sh@0.42.0'
import { z } from 'zod@4.6.5'
import { CommandError, runJsonCommand } from './process'

const command = 'chrome-devtools'
const commandTimeoutMs = 60_000
const statusTimeoutMs = 10_000
const pageLoadTimeoutMs = 30_000

const PagesResponse = z.object({
  pages: z.array(z.object({ id: z.number(), url: z.string(), selected: z.boolean() })),
})

const MessageResponse = z.union([
  z.object({ message: z.string() }).transform(({ message }) => ({ message, failed: false })),
  z.array(z.object({ text: z.string() })).transform((parts) => ({ message: parts.map((part) => part.text).join('\n'), failed: true })),
])

interface OpenPageInput {
  url: string
  background: boolean
}

export async function openPage({ url, background }: OpenPageInput): Promise<number> {
  const args = ['new_page', url, ...(background ? ['--background'] : []), '--timeout', String(pageLoadTimeoutMs)]
  const response = await runChromeDevtools({ args, schema: PagesResponse })
  const page = response.pages.find((candidate) => candidate.selected)
  if (page === undefined) throw new CommandError({ command, detail: 'new_page returned no selected page' })

  return page.id
}

export interface BrowserPage {
  id: number
  url: string
}

export async function listPages(): Promise<BrowserPage[]> {
  const response = await runChromeDevtools({ args: ['list_pages'], schema: PagesResponse })
  return response.pages.map(({ id, url }) => ({ id, url }))
}

interface NavigatePageInput {
  pageId: number
  url: string
}

export async function navigatePage({ pageId, url }: NavigatePageInput): Promise<void> {
  await runChromeDevtools({ args: ['navigate_page', String(pageId), '--type', 'url', '--url', url, '--timeout', String(pageLoadTimeoutMs)], schema: z.unknown() })
}

export async function closePage(pageId: number): Promise<void> {
  await runChromeDevtools({ args: ['close_page', String(pageId)], schema: z.unknown() }).catch(() => undefined)
}

export async function getChromePid(): Promise<number | null> {
  const result = await $`chrome-cdp status`.stdout('piped').stderr('piped').timeout(statusTimeoutMs).noThrow()
  const pid = Number(result.stdout.match(/tracked pid:\s*(\d+)/)?.[1])
  return Number.isInteger(pid) ? pid : null
}

interface EvaluateInPageInput<T> {
  pageId: number
  source: string
  schema: z.ZodType<T>
}

export async function evaluateInPage<T>({ pageId, source, schema }: EvaluateInPageInput<T>): Promise<T> {
  const response = await runChromeDevtools({ args: ['evaluate_script', '--pageId', String(pageId), source], schema: MessageResponse })
  if (response.failed) throw new CommandError({ command, detail: `page script failed: ${response.message.split('\n')[0]}` })

  const payload = response.message.match(/```json\n([\s\S]*)\n```/)?.[1]
  if (payload === undefined) throw new CommandError({ command, detail: `evaluate_script returned no value: ${response.message.slice(0, 200)}` })

  return schema.parse(JSON.parse(payload))
}

interface RunChromeDevtoolsInput<T> {
  args: string[]
  schema: z.ZodType<T>
}

function runChromeDevtools<T>({ args, schema }: RunChromeDevtoolsInput<T>): Promise<T> {
  return runJsonCommand({ command, args: [...args, '--output-format', 'json'], schema, timeoutMs: commandTimeoutMs })
}
