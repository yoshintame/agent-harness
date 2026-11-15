import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { match } from 'ts-pattern@5.9.0'
import { z } from 'zod@4.6.5'
import { registerCleanup } from './cleanup'

const defaultRetryMs = 250
const ownerlessGraceMs = 5000

const LockOwner = z.object({ pid: z.number().int(), token: z.string() })

export class LockBusyError extends Error {
  public readonly path: string

  public constructor(path: string) {
    super(`lock ${path} is held by another run`)
    this.path = path
  }
}

interface WithFileLockInput<T> {
  path: string
  waitMs: number
  run: () => Promise<T>
}

export async function withFileLock<T>({ path, waitMs, run }: WithFileLockInput<T>): Promise<T> {
  mkdirSync(dirname(path), { recursive: true })
  const token = await acquireLock({ path, deadline: Date.now() + waitMs })
  const unregister = registerCleanup(() => releaseLock({ path, token }))

  try {
    return await run()
  } finally {
    unregister()
    releaseLock({ path, token })
  }
}

export function isLockHeld(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false }) === undefined ? false : !isAbandoned(path)
}

interface AcquireLockInput {
  path: string
  deadline: number
}

async function acquireLock({ path, deadline }: AcquireLockInput): Promise<string> {
  const token = randomUUID()
  if (tryCreateLock({ path, token })) return token

  return match({ abandoned: isAbandoned(path), expired: Date.now() >= deadline })
    .with({ abandoned: true }, () => {
      takeOverAbandoned(path)
      return acquireLock({ path, deadline })
    })
    .with({ expired: true }, () => {
      throw new LockBusyError(path)
    })
    .otherwise(async () => {
      await Bun.sleep(defaultRetryMs)
      return acquireLock({ path, deadline })
    })
}

interface LockTokenInput {
  path: string
  token: string
}

function tryCreateLock({ path, token }: LockTokenInput): boolean {
  try {
    mkdirSync(path)
  } catch {
    return false
  }

  writeFileSync(join(path, 'owner.json'), JSON.stringify({ pid: process.pid, token }))
  return true
}

function releaseLock({ path, token }: LockTokenInput): void {
  if (readOwner(path)?.token === token) rmSync(path, { force: true, recursive: true })
}

function isAbandoned(path: string): boolean {
  const owner = readOwner(path)
  if (owner !== null) return !isProcessAlive(owner.pid)

  const createdAtMs = statSync(path, { throwIfNoEntry: false })?.mtimeMs
  return createdAtMs === undefined ? false : Date.now() - createdAtMs > ownerlessGraceMs
}

function takeOverAbandoned(path: string): void {
  const graveyard = `${path}.abandoned-${randomUUID()}`
  try {
    renameSync(path, graveyard)
  } catch {
    return
  }

  rmSync(graveyard, { force: true, recursive: true })
}

function readOwner(path: string): z.infer<typeof LockOwner> | null {
  try {
    return LockOwner.parse(JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8')))
  } catch {
    return null
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return match(error)
      .with({ code: 'EPERM' }, () => true)
      .otherwise(() => false)
  }
}
