import type { z } from 'zod@4.6.5'

export class HttpError extends Error {
  public constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly headers: Headers,
    public readonly body: string,
  ) {
    super(`HTTP ${status} ${statusText}`)
  }
}

export class NonJsonResponseError extends Error {
  public constructor(public readonly contentType: string) {
    super(`non-JSON response (${contentType || 'no content type'})`)
  }
}

export interface RequestInput {
  url: string
  headers?: Record<string, string>
  method?: 'GET' | 'POST'
  body?: string
  timeoutMs?: number
}

export async function request({ url, headers, method = 'GET', body, timeoutMs = 15_000 }: RequestInput): Promise<Response> {
  const response = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) })

  if (!response.ok) {
    throw new HttpError(response.status, response.statusText, response.headers, await response.text())
  }

  return response
}

export async function requestJson<T>(input: RequestInput, schema: z.ZodType<T>): Promise<T> {
  const response = await request(input)
  const contentType = response.headers.get('content-type') ?? ''

  if (!contentType.includes('json')) throw new NonJsonResponseError(contentType)

  return schema.parse(await response.json())
}

export async function requestText(input: RequestInput): Promise<string> {
  const response = await request(input)
  return response.text()
}
