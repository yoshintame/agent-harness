import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { releaseLock, takeLock } from '../scripts/refresh-orchestrator'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'refresh-orchestrator-test-'))
})

afterEach(() => {
  rmSync(tmp, { force: true, recursive: true })
})

test('lock is exclusive, counts a pid-less lock as held and steals only a stale one', () => {
  const lock = join(tmp, 'lock')
  expect(takeLock(lock)).toBe(true)
  expect(readFileSync(join(lock, 'pid'), 'utf8')).toBe(`${process.pid}\n`)
  expect(takeLock(lock)).toBe(false)
  releaseLock(lock)
  expect(existsSync(lock)).toBe(false)

  mkdirSync(lock)
  expect(takeLock(lock)).toBe(false)
  const old = new Date(Date.now() - 20 * 60_000)
  utimesSync(lock, old, old)
  expect(takeLock(lock)).toBe(true)
})
