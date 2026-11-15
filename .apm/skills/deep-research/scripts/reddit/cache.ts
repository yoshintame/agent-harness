import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod@4.6.5'

const cacheDir = join(z.string().min(1).catch(join(homedir(), '.cache')).parse(process.env.XDG_CACHE_HOME ?? ''), 'search-reddit')

export const cachePaths = {
  workerLock: join(cacheDir, 'worker.lock'),
  humanLock: join(cacheDir, 'human.lock'),
  lastRequest: join(cacheDir, 'last-request'),
  humanGaveUp: join(cacheDir, 'human-gave-up'),
} as const
