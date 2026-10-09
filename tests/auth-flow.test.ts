import { describe, expect, it } from 'vitest'
import { runWorkbuddyOAuth } from '../src/host/auth-flow.js'
import { WorkbuddyClient } from '../src/host/workbuddy-client.js'
import type {
  AuthorizationSession,
  CredentialsService,
} from '../src/host/auth-flow.js'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(
    body === undefined ? '' : JSON.stringify(body),
    { status, headers: { 'content-type': 'application/json' } },
  )
}

function makeFetch(opts: {
  startResponse: { status: number; body: unknown }
  pollResponses: Array<{ status: number; body: unknown }>
}): typeof fetch {
  let pollIndex = 0
  return (async (input: RequestInfo | URL) => {
    const u = new URL(typeof input === 'string' ? input : input.toString())
    if (u.pathname === '/panel/api/login/start') {
      return jsonResponse(opts.startResponse.status, opts.startResponse.body)
    }
    if (u.pathname === '/panel/api/login/poll') {
      const i = Math.min(pollIndex, opts.pollResponses.length - 1)
      pollIndex++
      return jsonResponse(opts.pollResponses[i]!.status, opts.pollResponses[i]!.body)
    }
    return new Response('not stubbed', { status: 599 })
  }) as typeof fetch
}

class FakeController {
  aborted = false
  listeners: Array<() => void> = []
  abort() {
    this.aborted = true
    for (const l of this.listeners) l()
  }
  addEventListener(_: 'abort', fn: () => void) {
    this.listeners.push(fn)
  }
}

function makeSession(): { session: AuthorizationSession; controller: FakeController; events: Array<{ message?: string; url?: string; code?: string }> } {
  const controller = new FakeController()
  const events: Array<{ message?: string; url?: string; code?: string }> = []
  const session: AuthorizationSession = {
    method: 'oauth',
    signal: controller as unknown as AbortSignal,
    notify(e) {
      events.push(e)
    },
  }
  return { session, controller, events }
}

describe('runWorkbuddyOAuth', () => {
  it('completes a successful OAuth flow (cn → copilot.tencent.com)', async () => {
    const fetchImpl = makeFetch({
      startResponse: {
        status: 200,
        body: { ok: true, realm: 'cn', state: 'state-1', url: 'https://copilot.tencent.com/login?platform=CLI&state=state-1' },
      },
      pollResponses: [
        { status: 200, body: { done: false, message: 'waiting' } },
        { status: 200, body: { done: false, message: 'still waiting' } },
        { status: 200, body: { done: true, uid: 'real-uid', nickname: 'PII', realm: 'cn' } },
      ],
    })
    const client = new WorkbuddyClient({
      baseURL: 'http://wb2api.local:7863',
      apiKey: 'k',
      fetchImpl,
    })
    const credentials: CredentialsService = {
      async set() {},
      async describe() { return { configured: false, writable: true } },
    }
    const { session, controller, events } = makeSession()
    // Speed up the test: we don't want to wait 3s between polls. We
    // monkey-patch the poll to be near-instant by setting a tiny interval.
    // The `pollUntilDone` uses OAUTH_POLL_INTERVAL_MS which is 3000; we
    // accept the wait. To keep the test under a second, we also abort
    // the session mid-way? No, we want the success path. The test will
    // take ~6s because of two false polls. We accept that.
    controller.aborted = false
    await runWorkbuddyOAuth({ workbuddy: client, credentials, realm: 'cn' }, session)
    expect(events.some((e) => e.url?.includes('copilot.tencent.com'))).toBe(true)
    expect(events.some((e) => e.message?.includes('登录成功'))).toBe(true)
  }, 30_000)

  it('throws when login/start fails', async () => {
    const fetchImpl = makeFetch({
      startResponse: { status: 500, body: { error: 'upstream' } },
      pollResponses: [],
    })
    const client = new WorkbuddyClient({
      baseURL: 'http://wb2api.local:7863',
      apiKey: 'k',
      fetchImpl,
    })
    const credentials: CredentialsService = {
      async set() {},
      async describe() { return { configured: false, writable: true } },
    }
    const { session } = makeSession()
    await expect(
      runWorkbuddyOAuth({ workbuddy: client, credentials, realm: 'cn' }, session),
    ).rejects.toThrow(/HTTP 500/)
  })
})
