import { type ArgsDef, type BooleanArgDef, type CommandDef, runCommand, runMain, type StringArgDef } from 'citty@0.2.2'
import { match, P } from 'ts-pattern@5.9.0'
import { z } from 'zod@4.6.5'
import { HttpError, NonJsonResponseError } from './http'
import { CommandError } from './process'
import { toOneLine } from './text'

export class ReportError extends Error {}

export const jsonArg = {
  type: 'boolean',
  description: 'Print JSON instead of Markdown',
} as const satisfies BooleanArgDef

export function limitArg(defaultLimit: number, description = 'Max results') {
  return { type: 'string', description, default: String(defaultLimit) } as const satisfies StringArgDef
}

export async function runCli<T extends ArgsDef>(command: CommandDef<T>): Promise<void> {
  const rawArgs = process.argv.slice(2)
  if (rawArgs.some((arg) => arg === '--help' || arg === '-h')) return runMain(command)

  await runCommand(command, { rawArgs }).catch((error: unknown) =>
    match(error)
      .with({ name: 'CLIError' }, (usageError) => fail(`${describeError(usageError)}\nRun with --help for usage.`))
      .otherwise((failure) => fail(describeError(failure))),
  )
}

export function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

interface EmitInput<T> {
  value: T
  json: boolean | undefined
  printMarkdown: (value: T) => void
}

export function emit<T>({ value, json, printMarkdown }: EmitInput<T>): void {
  if (json) return printJson(value)
  printMarkdown(value)
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

export function describeError(error: unknown): string {
  return match(error)
    .with(P.instanceOf(ReportError), (failure) => failure.message)
    .with(P.instanceOf(HttpError), (failure) => failure.message)
    .with(P.instanceOf(NonJsonResponseError), (failure) => failure.message)
    .with(P.instanceOf(CommandError), (failure) => toOneLine({ text: failure.message, maxLength: 300 }))
    .with(P.instanceOf(z.ZodError), (failure) => describeSchemaMismatch(failure))
    .with({ name: 'TimeoutError' }, () => 'request timed out')
    .with(P.instanceOf(Error), (failure) => toOneLine({ text: failure.message, maxLength: 300 }))
    .otherwise((failure) => String(failure))
}

function describeSchemaMismatch(error: z.ZodError): string {
  const [issue] = error.issues
  const path = issue?.path.length ? issue.path.join('.') : 'root'
  return `unexpected response shape at ${path}: ${issue?.message ?? 'invalid'}`
}

export function readLimit(value: string): number {
  return parseCount({ flag: 'limit', value })
}

interface ParseCountInput {
  flag: string
  value: string
}

export function parseCount({ flag, value }: ParseCountInput): number {
  const parsed = z.coerce.number().int().nonnegative().safeParse(value)
  if (!parsed.success) fail(`--${flag} must be a non-negative integer, got ${JSON.stringify(value)}`)

  return parsed.data
}

interface ParseOptionalCountInput {
  flag: string
  value: string | undefined
}

export function parseOptionalCount({ flag, value }: ParseOptionalCountInput): number | undefined {
  return value === undefined ? undefined : parseCount({ flag, value })
}
