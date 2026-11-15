import $ from 'dax-sh@0.42.0'
import { match, P } from 'ts-pattern@5.9.0'
import type { z } from 'zod@4.6.5'

$.setPrintCommand(false)

const timeoutExitCode = 124

interface CommandErrorInput {
  command: string
  detail: string
}

export class CommandError extends Error {
  public readonly command: string
  public readonly detail: string

  public constructor({ command, detail }: CommandErrorInput) {
    super(`${command} failed: ${detail}`)
    this.command = command
    this.detail = detail
  }
}

interface RunJsonCommandInput<T> {
  command: string
  args: string[]
  schema: z.ZodType<T>
  timeoutMs: number
}

export async function runJsonCommand<T>({ command, args, schema, timeoutMs }: RunJsonCommandInput<T>): Promise<T> {
  const result = await $`${command} ${args}`.stdout('piped').stderr('piped').timeout(timeoutMs).noThrow()
  const json = findJson(result.stdout)

  return match({ code: result.code, json })
    .with({ code: 0, json: P.not(P.nullish) }, ({ json: value }) => schema.parse(value))
    .with({ code: 0 }, () => {
      throw new CommandError({ command, detail: 'printed no JSON' })
    })
    .with({ code: timeoutExitCode }, () => {
      throw new CommandError({ command, detail: `timed out after ${Math.round(timeoutMs / 1000)}s` })
    })
    .otherwise(() => {
      const detail = [result.stderr.trim(), result.stdout.trim()].find((text) => text !== '') ?? `exit ${result.code}`
      throw new CommandError({ command, detail })
    })
}

function findJson(stdout: string): unknown {
  const text = stdout.trim()
  if (text === '') return null

  try {
    return JSON.parse(text)
  } catch {
    const line = text.split('\n').find((candidate) => candidate.startsWith('{') || candidate.startsWith('['))
    return line === undefined ? null : JSON.parse(line)
  }
}
