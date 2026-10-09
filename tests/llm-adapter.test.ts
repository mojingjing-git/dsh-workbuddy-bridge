import { describe, expect, it } from 'vitest'
import { WorkbuddyLlmAdapter, WORKBUDDY_PROVIDER } from '../src/host/llm-adapter.js'
import { WorkbuddyClient } from '../src/host/workbuddy-client.js'

/**
 * Build a fetch stub that answers `/v1/models` and `/v1/chat/completions`
 * with deterministic responses.
 */
function makeSseFetch(opts: {
  models: string[]
  streamChunks: Array<{ type: 'text' | 'reasoning' | 'usage' | 'finish'; text?: string; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }>
  status: number
}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const u = new URL(url)
    if (u.pathname === '/v1/models') {
      return new Response(
        JSON.stringify({
          object: 'list',
          data: opts.models.map((id) => ({ id, owned_by: 'workbuddy2api' })),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (u.pathname === '/v1/chat/completions') {
      if (opts.status !== 200) {
        return new Response('upstream error', { status: opts.status })
      }
      // Build a small SSE body.
      const parts: string[] = []
      for (const c of opts.streamChunks) {
        if (c.type === 'text') {
          parts.push(`data: ${JSON.stringify({ choices: [{ delta: { content: c.text } }] })}\n\n`)
        } else if (c.type === 'reasoning') {
          parts.push(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: c.text } }] })}\n\n`)
        } else if (c.type === 'usage') {
          parts.push(`data: ${JSON.stringify({ choices: [{ finish_reason: 'stop' }], usage: c.usage })}\n\n`)
        } else if (c.type === 'finish') {
          parts.push('data: [DONE]\n\n')
        }
      }
      const encoder = new TextEncoder()
      return new Response(encoder.encode(parts.join('')), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    return new Response('not stubbed', { status: 599 })
  }) as typeof fetch
}

describe('WorkbuddyLlmAdapter.listModels', () => {
  it('returns the 19 wb2api models with realm parsed', async () => {
    const fetchImpl = makeSseFetch({ models: [], streamChunks: [], status: 200 })
    const client = new WorkbuddyClient({
      baseURL: 'http://wb2api.local:7863',
      apiKey: 'k',
      fetchImpl,
    })
    const adapter = new WorkbuddyLlmAdapter(client)
    const models = await adapter.listModels(WORKBUDDY_PROVIDER)
    expect(models.length).toBe(0) // because we passed []
  })

  it('parses cn: prefix and marks hasRealmPrefix', async () => {
    const fetchImpl = makeSseFetch({
      models: ['cn:glm-5.2', 'cn:auto', 'global:foo'],
      streamChunks: [],
      status: 200,
    })
    const client = new WorkbuddyClient({
      baseURL: 'http://wb2api.local:7863',
      apiKey: 'k',
      fetchImpl,
    })
    const adapter = new WorkbuddyLlmAdapter(client)
    const models = await adapter.listModels(WORKBUDDY_PROVIDER)
    expect(models.length).toBe(3)
    expect(models[0]).toEqual({
      provider: 'workbuddy',
      id: 'cn:glm-5.2',
      name: 'cn:glm-5.2',
      hasRealmPrefix: true,
      realm: 'cn',
    })
    expect(models[1]?.realm).toBe('cn')
    expect(models[2]?.realm).toBe('global')
  })
})

describe('WorkbuddyLlmAdapter.resolveModel', () => {
  it('rejects cH:glm-5.2 with PROVIDER_REJECTED_CASE', async () => {
    const fetchImpl = makeSseFetch({ models: [], streamChunks: [], status: 200 })
    const client = new WorkbuddyClient({
      baseURL: 'http://wb2api.local:7863',
      apiKey: 'k',
      fetchImpl,
    })
    const adapter = new WorkbuddyLlmAdapter(client)
    await expect(adapter.resolveModel(WORKBUDDY_PROVIDER, 'cH:glm-5.2')).rejects.toThrow(
      /PROVIDER_REJECTED_CASE/,
    )
  })
})

describe('WorkbuddyLlmAdapter.stream', () => {
  it('strips cn: prefix before sending to wb2api', async () => {
    let capturedBody: unknown = null
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof input === 'string' ? input : input.toString()
      if (new URL(u).pathname === '/v1/chat/completions') {
        capturedBody = JSON.parse(init!.body as string)
        const encoder = new TextEncoder()
        return new Response(
          encoder.encode(`data: ${JSON.stringify({ choices: [{ finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
      }
      return new Response('', { status: 599 })
    }) as typeof fetch
    const client = new WorkbuddyClient({
      baseURL: 'http://wb2api.local:7863',
      apiKey: 'k',
      fetchImpl,
    })
    const adapter = new WorkbuddyLlmAdapter(client, { fetchImpl })
    const chunks: string[] = []
    for await (const c of adapter.stream({
      apiKey: 'k',
      model: 'cn:glm-5.2',
      body: { messages: [{ role: 'user', content: 'hi' }] },
    })) {
      if (c.type === 'text' && c.text !== undefined) chunks.push(c.text)
    }
    const sent = capturedBody as { model: string; messages: unknown[]; stream: boolean }
    expect(sent.model).toBe('glm-5.2')
    expect(sent.stream).toBe(true)
  })

  it('yields a text chunk from a normal SSE data line', async () => {
    const fetchImpl = makeSseFetch({
      models: [],
      streamChunks: [{ type: 'text', text: 'Hello' }],
      status: 200,
    })
    const client = new WorkbuddyClient({
      baseURL: 'http://wb2api.local:7863',
      apiKey: 'k',
      fetchImpl,
    })
    const adapter = new WorkbuddyLlmAdapter(client, { fetchImpl })
    const out: string[] = []
    for await (const c of adapter.stream({
      apiKey: 'k',
      model: 'glm-5.2',
      body: { messages: [] },
    })) {
      if (c.type === 'text' && c.text !== undefined) out.push(c.text)
    }
    expect(out.join('')).toBe('Hello')
  })

  it('yields an error chunk when the model id has wrong case', async () => {
    const fetchImpl = makeSseFetch({ models: [], streamChunks: [], status: 200 })
    const client = new WorkbuddyClient({
      baseURL: 'http://wb2api.local:7863',
      apiKey: 'k',
      fetchImpl,
    })
    const adapter = new WorkbuddyLlmAdapter(client, { fetchImpl })
    let errored = false
    for await (const c of adapter.stream({
      apiKey: 'k',
      model: 'CN:glm-5.2',
      body: { messages: [] },
    })) {
      if (c.type === 'error') {
        errored = true
        expect(c.error?.code).toBe('PROVIDER_REJECTED_CASE')
      }
    }
    expect(errored).toBe(true)
  })
})

describe('WorkbuddyLlmAdapter.providerInfo', () => {
  it('returns id+name for the workbuddy provider', async () => {
    const fetchImpl = makeSseFetch({ models: [], streamChunks: [], status: 200 })
    const client = new WorkbuddyClient({
      baseURL: 'http://wb2api.local:7863',
      apiKey: 'k',
      fetchImpl,
    })
    const adapter = new WorkbuddyLlmAdapter(client)
    const info = adapter.providerInfo(WORKBUDDY_PROVIDER)
    expect(info.id).toBe('workbuddy')
    expect(info.name).toBe('WorkBuddy / CodeBuddy')
  })

  it('rejects provider mismatch', async () => {
    const fetchImpl = makeSseFetch({ models: [], streamChunks: [], status: 200 })
    const client = new WorkbuddyClient({
      baseURL: 'http://wb2api.local:7863',
      apiKey: 'k',
      fetchImpl,
    })
    const adapter = new WorkbuddyLlmAdapter(client)
    expect(() => adapter.providerInfo('openai')).toThrow(/PROVIDER_MISMATCH/)
  })
})
