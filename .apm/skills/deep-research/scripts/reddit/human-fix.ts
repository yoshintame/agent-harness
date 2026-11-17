import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { match, P } from 'ts-pattern@5.9.0'
import { z } from 'zod@4.6.5'
import { alertUser, closePage, closePageNow, getChromePid, isLockHeld, LockBusyError, openPage, registerCleanup, withFileLock } from '../lib'
import { cachePaths } from './cache'
import { HumanRefusal, RedditEndpointClosedError, RedditRefusalError, readRedditJson } from './page'
import { wwwBase } from './thread'

const humanWaitMs = 180_000
const humanPollMs = 5000
const giveUpCooldownMs = 600_000
const waitMinutes = humanWaitMs / 60_000
const cooldownMinutes = giveUpCooldownMs / 60_000

export enum SessionHealth {
  Healthy = 'healthy',
  SignedOut = 'signed-out',
  Challenged = 'challenged',
  Unknown = 'unknown',
}

enum FixOutcome {
  Fixed = 'fixed',
  TimedOut = 'timed-out',
  Cooldown = 'cooldown',
}

const SignedInMe = z.object({ data: z.object({ name: z.string().min(1) }) })

const signInAction = { url: `${wwwBase}/login/`, message: 'Reddit signed the agent Chrome out: sign in in the window that just opened' }
const humanCheckAction = { url: `${wwwBase}/`, message: 'Reddit asks for a human check: pass it in the window that just opened' }

export async function withHumanFix<T>(attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt()
  } catch (error) {
    if (!(error instanceof RedditRefusalError)) throw error

    return recoverFromRefusal({ refused: error, attempt })
  }
}

export async function checkSessionHealth(): Promise<SessionHealth> {
  try {
    const me = await readRedditJson({ url: `${wwwBase}/api/me.json?raw_json=1`, expectInUrl: '/api/me.json', schema: z.unknown() })
    return SignedInMe.safeParse(me).success ? SessionHealth.Healthy : SessionHealth.SignedOut
  } catch (error) {
    return match(error)
      .with(P.intersection(P.instanceOf(RedditRefusalError), { refusal: HumanRefusal.Challenge }), () => SessionHealth.Challenged)
      .with(P.instanceOf(RedditRefusalError), () => SessionHealth.SignedOut)
      .otherwise(() => SessionHealth.Unknown)
  }
}

interface RecoverFromRefusalInput<T> {
  refused: RedditRefusalError
  attempt: () => Promise<T>
}

async function recoverFromRefusal<T>({ refused, attempt }: RecoverFromRefusalInput<T>): Promise<T> {
  const health = await checkSessionHealth()

  return match(health)
    .with(SessionHealth.Healthy, () => retryWithWorkingSession(attempt))
    .with(SessionHealth.Unknown, () => {
      throw new RedditRefusalError({ refusal: refused.refusal, detail: `${refused.message}; the session could not be checked, so the user was not asked` })
    })
    .with(P.union(SessionHealth.SignedOut, SessionHealth.Challenged), async (broken) => {
      const outcome = await awaitHumanFix(broken)
      return match(outcome)
        .with(FixOutcome.Fixed, () => attempt())
        .with(FixOutcome.TimedOut, () => {
          throw new RedditRefusalError({
            refusal: refused.refusal,
            detail: `${refused.message}; the user was asked to fix it in the chrome-cdp window and nobody did within ${waitMinutes} min`,
          })
        })
        .with(FixOutcome.Cooldown, () => {
          throw new RedditRefusalError({
            refusal: refused.refusal,
            detail: `${refused.message}; the user was not asked again because an earlier prompt went unanswered less than ${cooldownMinutes} min ago`,
          })
        })
        .exhaustive()
    })
    .exhaustive()
}

async function retryWithWorkingSession<T>(attempt: () => Promise<T>): Promise<T> {
  return attempt().catch((error: unknown) => {
    throw error instanceof RedditRefusalError
      ? new RedditEndpointClosedError('Reddit refused this address twice while the signed-in session works: Reddit closes this endpoint to the agent Chrome, or the subreddit or post is private, banned or missing')
      : error
  })
}

async function awaitHumanFix(health: SessionHealth.SignedOut | SessionHealth.Challenged): Promise<FixOutcome> {
  if (gaveUpRecently()) return FixOutcome.Cooldown

  return withFileLock({ path: cachePaths.humanLock, waitMs: 0, run: () => guideHumanThroughFix(health) }).catch((error: unknown) => {
    if (error instanceof LockBusyError) return waitForOtherRunsFix()
    throw error
  })
}

async function guideHumanThroughFix(health: SessionHealth.SignedOut | SessionHealth.Challenged): Promise<FixOutcome> {
  const action = health === SessionHealth.SignedOut ? signInAction : humanCheckAction
  const pageId = await openPage({ url: action.url, background: false })
  const unregister = registerCleanup(() => closePageNow(pageId))

  try {
    await alertUser({ title: 'search-reddit', message: action.message, focusPid: await getChromePid() })
    const fixed = await pollUntilHealthy(Date.now() + humanWaitMs)
    if (!fixed) writeGaveUp()

    return fixed ? FixOutcome.Fixed : FixOutcome.TimedOut
  } finally {
    unregister()
    await closePage(pageId)
  }
}

async function pollUntilHealthy(deadline: number): Promise<boolean> {
  await Bun.sleep(humanPollMs)
  const health = await checkSessionHealth()

  return match({ healthy: health === SessionHealth.Healthy, expired: Date.now() >= deadline })
    .with({ healthy: true }, () => true)
    .with({ expired: true }, () => false)
    .otherwise(() => pollUntilHealthy(deadline))
}

async function waitForOtherRunsFix(): Promise<FixOutcome> {
  await waitWhileHumanLockHeld(Date.now() + humanWaitMs + humanPollMs * 4)
  return gaveUpRecently() ? FixOutcome.TimedOut : FixOutcome.Fixed
}

async function waitWhileHumanLockHeld(deadline: number): Promise<void> {
  if ([!isLockHeld(cachePaths.humanLock), Date.now() >= deadline].some(Boolean)) return

  await Bun.sleep(humanPollMs)
  return waitWhileHumanLockHeld(deadline)
}

function writeGaveUp(): void {
  mkdirSync(dirname(cachePaths.humanGaveUp), { recursive: true })
  writeFileSync(cachePaths.humanGaveUp, String(Date.now()))
}

function gaveUpRecently(): boolean {
  try {
    const gaveUpAt = z.coerce.number().catch(0).parse(readFileSync(cachePaths.humanGaveUp, 'utf8'))
    return Date.now() - gaveUpAt < giveUpCooldownMs
  } catch {
    return false
  }
}
