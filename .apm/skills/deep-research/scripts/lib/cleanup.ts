const cleanupsById = new Map<symbol, () => void>()
const exitCodesBySignal = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const satisfies Record<string, number>
const installed = { value: false }

export function registerCleanup(cleanup: () => void): () => void {
  installSignalHandlers()
  const id = Symbol('cleanup')
  cleanupsById.set(id, cleanup)
  return () => {
    cleanupsById.delete(id)
  }
}

function installSignalHandlers(): void {
  if (installed.value) return

  installed.value = true
  for (const [signal, exitCode] of Object.entries(exitCodesBySignal)) {
    process.on(signal, () => {
      for (const cleanup of cleanupsById.values()) {
        try {
          cleanup()
        } catch {
          continue
        }
      }
      process.exit(exitCode)
    })
  }
}
