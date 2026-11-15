import type { z } from 'zod@4.6.5'

const defaultTimeoutMs = 15_000

interface HttpErrorInput {
  status: number
  statusText: string
  headers: Headers
  body: string
}

export class HttpError extends Error {
  public readonly status: number
  public readonly statusText: string
  public readonly headers: Headers
  public readonly body: string

  public constructor({ status, statusText, headers, body }: HttpErrorInput) {
    super(`HTTP ${status} ${statusText}`)
    this.status = status
    this.statusText = statusText
    this.headers = headers
    this.body = body
  }
}

export class NonJsonResponseError extends Error {
  public constructor(contentType: string) {
    super(`non-JSON response (${contentType || 'no content type'})`)
  }
}

interface RequestJsonInput<T> {
  url: string
  schema: z.ZodType<T>
  headers?: Record<string, string>
  timeoutMs?: number
}

export async function requestJson<T>({ url, schema, headers, timeoutMs = defaultTimeoutMs }: RequestJsonInput<T>): Promise<T> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) {
    throw new HttpError({ status: response.status, statusText: response.statusText, headers: response.headers, body: await response.text() })
  }

  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('json')) throw new NonJsonResponseError(contentType)

  return schema.parse(await response.json())
}
