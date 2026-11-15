import { match, P } from 'ts-pattern@5.9.0'
import { z } from 'zod@4.6.5'
import { evaluateInPage } from '../lib'
import { withRedditPage } from './session'

const blockedPhrase = 'blocked by network security'
const challengePhrase = 'Prove your humanity'
export const resultLinkSelector = 'a[data-testid=post-title]'

export enum HumanRefusal {
  Blocked = 'blocked',
  Challenge = 'challenge',
}

interface RedditRefusalErrorInput {
  refusal: HumanRefusal
  detail: string
}

export class RedditRefusalError extends Error {
  public readonly refusal: HumanRefusal

  public constructor({ refusal, detail }: RedditRefusalErrorInput) {
    super(detail)
    this.refusal = refusal
  }
}

export class RedditPageError extends Error {}

export class RedditApiError extends RedditPageError {
  public readonly status: number

  public constructor(status: number) {
    super(`Reddit answered ${status}`)
    this.status = status
  }
}

export const PageState = z.object({ title: z.string(), text: z.string() })
export type PageState = z.infer<typeof PageState>

const JsonSnapshot = PageState.extend({ data: z.unknown() })
const ApiErrorBody = z.object({ error: z.number() })

export const jsonSnapshotScript = `() => {
  const raw = document.querySelector('pre')?.textContent ?? document.body.textContent ?? ''
  let data = null
  try { data = JSON.parse(raw) } catch {}
  return { title: document.title, text: document.body.innerText.slice(0, 300), data }
}`

interface ReadRedditJsonInput<T> {
  url: string
  expectInUrl: string
  schema: z.ZodType<T>
}

export async function readRedditJson<T>({ url, expectInUrl, schema }: ReadRedditJsonInput<T>): Promise<T> {
  const snapshot = await withRedditPage({ url, expectInUrl, read: (pageId) => evaluateInPage({ pageId, source: jsonSnapshotScript, schema: JsonSnapshot }) })

  return match(snapshot.data)
    .with(P.nullish, () => {
      throw toPageError(snapshot)
    })
    .when(
      (data) => ApiErrorBody.safeParse(data).success,
      (data) => {
        throw new RedditApiError(ApiErrorBody.parse(data).error)
      },
    )
    .otherwise((data) => schema.parse(data))
}

export function toPageError({ title, text }: PageState): RedditRefusalError | RedditPageError {
  return match(`${title} ${text}`)
    .with(
      P.string.includes(blockedPhrase),
      () => new RedditRefusalError({ refusal: HumanRefusal.Blocked, detail: `Reddit blocked the chrome-cdp Chrome ("${blockedPhrase}")` }),
    )
    .with(P.string.includes(challengePhrase), () => new RedditRefusalError({ refusal: HumanRefusal.Challenge, detail: `Reddit asks for a human check ("${challengePhrase}")` }))
    .otherwise(() => new RedditPageError(`unexpected Reddit page "${title}": ${text.replaceAll('\n', ' ').slice(0, 120)}`))
}
