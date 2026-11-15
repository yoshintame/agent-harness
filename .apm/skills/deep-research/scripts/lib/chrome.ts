import { z } from 'zod@4.6.5'
import { CommandError, runJsonCommand } from './process'

const command = 'chrome-devtools'
const commandTimeoutMs = 60_000
const pageLoadTimeoutMs = 30_000

const PagesResponse = z.object({
  pages: z.array(z.object({ id: z.number(), url: z.string(), selected: z.boolean() })),
})

const MessageResponse = z.object({ message: z.string() })

export async function openPage(url: string): Promise<number> {
  const response = await runChromeDevtools({ args: ['new_page', url, '--background', '--timeout', String(pageLoadTimeoutMs)], schema: PagesResponse })
  const page = response.pages.find((candidate) => candidate.selected)
  if (page === undefined) throw new CommandError({ command, detail: 'new_page returned no selected page' })

  return page.id
}

export async function closePage(pageId: number): Promise<void> {
  await runChromeDevtools({ args: ['close_page', String(pageId)], schema: z.unknown() }).catch(() => undefined)
}

interface EvaluateInPageInput<T> {
  pageId: number
  source: string
  schema: z.ZodType<T>
}

export async function evaluateInPage<T>({ pageId, source, schema }: EvaluateInPageInput<T>): Promise<T> {
  const response = await runChromeDevtools({ args: ['evaluate_script', '--pageId', String(pageId), source], schema: MessageResponse })
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
