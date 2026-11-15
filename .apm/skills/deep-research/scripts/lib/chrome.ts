import $ from 'dax-sh@0.42.0'
import { z } from 'zod@4.6.5'

$.setPrintCommand(false)

const PagesResponse = z.object({
  pages: z.array(z.object({ id: z.number(), url: z.string(), selected: z.boolean() })),
})

const MessageResponse = z.object({ message: z.string() })

export class ChromeUnavailableError extends Error {
  public constructor(detail: string) {
    super(`chrome-devtools failed: ${detail}`)
  }
}

export async function openPage(url: string): Promise<number> {
  const response = PagesResponse.parse(await chromeDevtools(['new_page', url]))
  const page = response.pages.find((candidate) => candidate.selected)
  if (page === undefined) throw new ChromeUnavailableError('new_page returned no selected page')
  return page.id
}

export async function navigatePage(pageId: number, url: string): Promise<void> {
  await chromeDevtools(['navigate_page', String(pageId), '--type', 'url', '--url', url])
}

export async function closePage(pageId: number): Promise<void> {
  await chromeDevtools(['close_page', String(pageId)]).catch(() => undefined)
}

export async function evaluateInPage<T>(pageId: number, source: string, schema: z.ZodType<T>): Promise<T> {
  const response = MessageResponse.parse(await chromeDevtools(['evaluate_script', '--pageId', String(pageId), source]))
  const payload = response.message.match(/```json\n([\s\S]*)\n```/)?.[1]
  if (payload === undefined) throw new ChromeUnavailableError(`evaluate_script returned no value: ${response.message.slice(0, 200)}`)
  return schema.parse(JSON.parse(payload))
}

async function chromeDevtools(args: string[]): Promise<unknown> {
  const result = await $`chrome-devtools ${args} --output-format json`.stdout('piped').stderr('piped').noThrow()
  const output = result.stdout.split('\n').find((line) => line.startsWith('{'))
  if (result.code !== 0) throw new ChromeUnavailableError(result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`)
  if (output === undefined) throw new ChromeUnavailableError(`no JSON in output: ${result.stdout.slice(0, 200)}`)
  return JSON.parse(output)
}
