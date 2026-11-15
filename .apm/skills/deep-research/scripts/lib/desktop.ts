import $ from 'dax-sh@0.42.0'

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
  const focus = focusPid === null ? '' : `local app = hs.application.applicationForPID(${focusPid}); if app then app:activate() end`
  const lua = [
    `local function focus() ${focus} end`,
    'focus()',
    `hs.notify.new(focus, { title = ${luaString(title)}, informativeText = ${luaString(message)}, soundName = "Glass", withdrawAfter = 0 }):send()`,
    'return "ok"',
  ].join('\n')
  const result = await $`hs -c ${lua}`.stdout('piped').stderr('piped').timeout(hammerspoonTimeoutMs).noThrow()

  return result.code === 0 ? result.stdout.includes('ok') : false
}

export async function keepingFocus<T>(run: () => Promise<T>): Promise<T> {
  const previous = await runHammerspoon('local app = hs.application.frontmostApplication(); return app and app:bundleID() or ""')

  try {
    return await run()
  } finally {
    if (previous) await runHammerspoon(`local app = hs.application.get(${luaString(previous)}); if app then app:activate() end; return ""`)
  }
}

async function runHammerspoon(lua: string): Promise<string> {
  const result = await $`hs -c ${lua}`.stdout('piped').stderr('piped').timeout(hammerspoonTimeoutMs).noThrow()
  return result.code === 0 ? result.stdout.trim() : ''
}

function luaString(text: string): string {
  return `[==[${text.replaceAll(']==]', '')}]==]`
}
