import { afterEach, describe, expect, it } from 'vitest'
import {
  startManagementServer,
  defaultManagementKey,
  type ManagementServerHandle,
} from '../src/host/http-server.js'
import { WorkbuddyClient } from '../src/host/workbuddy-client.js'

/**
 * Build a fetch stub that simulates wb2api. Used as the `fetchImpl` of
 * `WorkbuddyClient` so the management server, when it asks the client
 * for /status, gets a deterministic response. The **test** itself uses
 * the real global `fetch` to hit the management server's bound port.
 */
function makeStubFetch(upstream: {
  bodies: Record<string, { status: number; body: unknown }>
}): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === 'string' ? input : input.toString()
    const u = new URL(url)
    const match = upstream.bodies[u.pathname]
    if (match === undefined) {
      return new Response('not stubbed', { status: 599 })
    }
    return new Response(
      match.body === undefined ? '' : JSON.stringify(match.body),
      { status: match.status, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof fetch
}

describe('startManagementServer', () => {
  let server: ManagementServerHandle | null = null

  afterEach(async () => {
    if (server !== null) {
      await server.close()
      server = null
    }
  })

  it('serves the workbuddy credits path with the right schema', async () => {
    const fetchImpl = makeStubFetch({
      bodies: {
        '/status': {
          status: 200,
          body: {
            accounts: [
              { uid: 'secret-uid', nickname: 'PII', credits: 3000, credits_total: 4000 },
            ],
          },
        },
      },
    })
    const client = new WorkbuddyClient({
      baseURL: 'http://wb2api.local:7863',
      apiKey: 'wb2api-key',
      fetchImpl,
    })
    server = await startManagementServer({ client, managementKey: 'k1' })

    const response = await fetch(server.baseURL + '/v0/management/plugins/workbuddy/credits', {
      headers: { 'x-management-key': 'k1' },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      accounts: Array<{ authIndex: number; credits: { used: number; remaining: number; limit: number; fetchedAt: string } }>
    }
    expect(body.accounts.length).toBe(1)
    expect(body.accounts[0]).toEqual({
      authIndex: 0,
      credits: {
        unit: 'credits',
        used: 1000,
        remaining: 3000,
        limit: 4000,
        fetchedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        packages: [],
      },
    })
    // PII MUST NOT appear in the response.
    expect(JSON.stringify(body)).not.toContain('secret-uid')
    expect(JSON.stringify(body)).not.toContain('PII')
  })

  it('returns 401 on a wrong X-Management-Key (constant-time compare)', async () => {
    const fetchImpl = makeStubFetch({ bodies: {} })
    const client = new WorkbuddyClient({
      baseURL: 'http://wb2api.local:7863',
      apiKey: 'wb2api-key',
      fetchImpl,
    })
    server = await startManagementServer({ client, managementKey: 'correct-key' })

    const r = await fetch(server.baseURL + '/v0/management/plugins/workbuddy/credits', {
      headers: { 'x-management-key': 'wrong-key' },
    })
    expect(r.status).toBe(401)
  })

  it('returns 405 on non-GET', async () => {
    const fetchImpl = makeStubFetch({ bodies: {} })
    const client = new WorkbuddyClient({
      baseURL: 'http://wb2api.local:7863',
      apiKey: 'wb2api-key',
      fetchImpl,
    })
    server = await startManagementServer({ client, managementKey: 'k1' })
    const r = await fetch(server.baseURL + '/v0/management/plugins/workbuddy/credits', {
      method: 'POST',
      headers: { 'x-management-key': 'k1' },
    })
    expect(r.status).toBe(405)
  })

  it('returns 404 on an unrelated path', async () => {
    const fetchImpl = makeStubFetch({ bodies: {} })
    const client = new WorkbuddyClient({
      baseURL: 'http://wb2api.local:7863',
      apiKey: 'wb2api-key',
      fetchImpl,
    })
    server = await startManagementServer({ client, managementKey: 'k1' })
    const r = await fetch(server.baseURL + '/v0/management/something-else', {
      headers: { 'x-management-key': 'k1' },
    })
    expect(r.status).toBe(404)
  })

  it('returns 502 when wb2api /status is unreachable', async () => {
    const fetchImpl: typeof fetch = (async () => {
      throw new Error('econnrefused')
    }) as typeof fetch
    const client = new WorkbuddyClient({
      baseURL: 'http://wb2api.local:7863',
      apiKey: 'wb2api-key',
      fetchImpl,
    })
    server = await startManagementServer({ client, managementKey: 'k1' })
    const r = await fetch(server.baseURL + '/v0/management/plugins/workbuddy/credits', {
      headers: { 'x-management-key': 'k1' },
    })
    expect(r.status).toBe(502)
    const body = (await r.json()) as { error: string; message: string }
    expect(body.error).toBe('WORKBUDDY_PLUGIN_UNAVAILABLE')
    expect(body.message).toContain('econnrefused')
  })

  it('binds to 127.0.0.1 and a port OS assigns (loopback only)', async () => {
    const fetchImpl = makeStubFetch({ bodies: {} })
    const client = new WorkbuddyClient({
      baseURL: 'http://wb2api.local:7863',
      apiKey: 'wb2api-key',
      fetchImpl,
    })
    server = await startManagementServer({ client, managementKey: 'k1' })
    expect(server.baseURL.startsWith('http://127.0.0.1:')).toBe(true)
    expect(server.port).toBeGreaterThan(0)
  })
})

describe('defaultManagementKey', () => {
  it('returns a different value each call', () => {
    const a = defaultManagementKey()
    const b = defaultManagementKey()
    expect(a).not.toBe(b)
  })
  it('returns a 64-character hex string (sha256)', () => {
    const k = defaultManagementKey()
    expect(k).toMatch(/^[0-9a-f]{64}$/)
  })
})
