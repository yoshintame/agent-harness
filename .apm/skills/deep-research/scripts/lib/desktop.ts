import $ from 'dax-sh@0.42.0'
import { z } from 'zod@4.6.5'

const hammerspoonTimeoutMs = 5000

interface AlertUserInput {
  title: string
  message: string
  focusPid: number | null
}

export async function alertUser({ title, message, focusPid }: AlertUserInput): Promise<void> {
  const shown = await alertViaHammerspoon({ title, message, focusPid })
  if (shown) return

  await $`osascript -e ${`display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)} sound name "Glass"`}`.quiet().noThrow()
}

async function alertViaHammerspoon({ title, message, focusPid }: AlertUserInput): Promise<boolean> {
  const focus = focusPid === null ? '' : activatePidLua(focusPid)
  const lua = [
    `local function focus() ${focus} end`,
    'focus()',
    `hs.notify.new(focus, { title = ${luaString(title)}, informativeText = ${luaString(message)}, soundName = "Glass", withdrawAfter = 0 }):send()`,
    'return "ok"',
  ].join('\n')

  return (await runHammerspoon(lua)) === 'ok'
}

export async function keepingFocus<T>(run: () => Promise<T>): Promise<T> {
  const frontmostPid = z.coerce.number().int().positive().nullable().catch(null).parse(
    await runHammerspoon('local app = hs.application.frontmostApplication(); return app and app:pid() or ""'),
  )

  try {
    return await run()
  } finally {
    if (frontmostPid !== null) await runHammerspoon(`${activatePidLua(frontmostPid)}; return ""`)
  }
}

function activatePidLua(pid: number): string {
  return `local app = hs.application.applicationForPID(${Math.trunc(pid)}); if app then app:activate() end`
}

async function runHammerspoon(lua: string): Promise<string> {
  const result = await $`hs -c ${lua}`.stdout('piped').stderr('piped').timeout(hammerspoonTimeoutMs).noThrow()
  return result.code === 0 ? result.stdout.trim() : ''
}

function luaString(text: string): string {
  const bytes = [...new TextEncoder().encode(text)]
  return bytes.length === 0 ? '""' : `string.char(${bytes.join(',')})`
}
