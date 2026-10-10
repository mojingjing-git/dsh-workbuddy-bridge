/**
 * `WorkbuddyClient`'s request timeout.
 *
 * The timer used to be cleared in a `finally` around the `fetch` call, which
 * fires as soon as the response **headers** arrive. Everything after that —
 * `response.text()` — ran with no timeout at all, so a server that answers the
 * headers promptly and then stalls mid-body would hang the request forever.
 * That path is worst on the OAuth poll, which is a loop of exactly these calls.
 */

import { describe, expect, it } from 'vitest'

import { WorkbuddyClient, WorkbuddyClientError } from '../src/host/workbuddy-client.js'

/**
 * A response whose headers arrive immediately and whose body never does, with
 * the body read tied to the request signal the way a real `fetch` body is.
 *
 * The signal wiring is the point, not decoration: against a stub whose `text()`
 * ignores the signal, aborting cannot interrupt anything and the test would
 * fail for a reason that does not exist in production. Modelling the platform's
 * actual behaviour is what makes the assertion mean something.
 */
function stallingResponse(signal: AbortSignal | null | undefined): Response {
  return {
    ok: true,
    status: 200,
    text: () =>
      new Promise<string>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException('The operation was aborted.', 'AbortError'))
          return
        }
        signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError')),
        )
      }),
  } as unknown as Response
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('WorkbuddyClient request timeout', () => {
  it('still fires while the body is being read', async () => {
    const client = new WorkbuddyClient({
      baseURL: 'http://gateway.test',
      apiKey: 'k',
      requestTimeoutMs: 40,
      // Headers resolve immediately; the body never does on its own.
      fetchImpl: async (_url, init) => stallingResponse(init?.signal),
    })

    const started = Date.now()
    await expect(client.status()).rejects.toThrow(WorkbuddyClientError)
    // Proves the timer was still armed during the body read, rather than having
    // been cleared when the headers landed. With the old code the clear ran in
    // the `finally` around `fetch`, so this promise never settled at all.
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('names the timeout rather than surfacing a bare AbortError', async () => {
    const client = new WorkbuddyClient({
      baseURL: 'http://gateway.test',
      apiKey: 'k',
      requestTimeoutMs: 40,
      fetchImpl: async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          // Reject the way a real aborted fetch does.
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted.', 'AbortError')),
          )
        }),
    })

    await expect(client.status()).rejects.toThrow(/timed out after 40ms/)
  })

  it('leaves no timer armed on the success path', async () => {
    // A leaked timer would keep the process alive past the test run. Node's
    // test runner reports that as a hang rather than a failure, so it is
    // asserted here by counting handles.
    const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
    const client = new WorkbuddyClient({
      baseURL: 'http://gateway.test',
      apiKey: 'k',
      requestTimeoutMs: 5_000,
      fetchImpl: async () => jsonResponse({ total: 2, accounts: [] }),
    })

    await expect(client.status()).resolves.toMatchObject({ total: 2 })

    const after = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
    expect(after).toBeLessThanOrEqual(before)
  })

  it('reads and parses a normal body', async () => {
    const client = new WorkbuddyClient({
      baseURL: 'http://gateway.test',
      apiKey: 'k',
      fetchImpl: async () => jsonResponse({ healthy: 1 }),
    })
    await expect(client.healthz()).resolves.toEqual({ healthy: 1 })
  })

  it('reports the status on an HTTP error', async () => {
    const client = new WorkbuddyClient({
      baseURL: 'http://gateway.test',
      apiKey: 'k',
      fetchImpl: async () => jsonResponse({ error: 'nope' }, 401),
    })
    await expect(client.status()).rejects.toMatchObject({ status: 401 })
  })
})
