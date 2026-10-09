import { describe, expect, it } from 'vitest'
import {
  WorkbuddyLlmAdapter,
  WorkbuddyLlmError,
  WORKBUDDY_PROVIDER,
  parseModelId,
} from '../src/host/llm-adapter.js'
import { WorkbuddyClient } from '../src/host/workbuddy-client.js'

/**
 * Build a fetch stub that answers `/v1/models` and
 * `/v1/chat/completions` with deterministic SSE responses.
 *
 * The SSE body is a sequence of OpenAI chat.completion.chunk frames.
 * Callers pass the frames they want; the helper joins them with the
 * SSE blank-line separator and appends `data: [DONE]`.
 */
type SseFrame =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool-call'; id?: string; name?: string; argumentsDelta?: string }
  | { kind: 'finish'; reason: string }
  | { kind: 'usage'; prompt: number; completion: number; total?: number }

function frameToJson(f: SseFrame): string {
  switch (f.kind) {
    case 'text':
      return JSON.stringify({ choices: [{ delta: { content: f.text } }] })
    case 'reasoning':
      return JSON.stringify({ choices: [{ delta: { reasoning_content: f.text } }] })
    case 'tool-call':
      return JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  ...(f.id !== undefined ? { id: f.id } : {}),
                  type: 'function',
                  function: {
                    ...(f.name !== undefined ? { name: f.name } : {}),
                    ...(f.argumentsDelta !== undefined ? { arguments: f.argumentsDelta } : {}),
                  },
                },
              ],
            },
          },
        ],
      })
    case 'finish':
      return JSON.stringify({ choices: [{ delta: {}, finish_reason: f.reason }] })
    case 'usage':
      return JSON.stringify({
        choices: [],
        usage: {
          prompt_tokens: f.prompt,
          completion_tokens: f.completion,
          ...(f.total !== undefined ? { total_tokens: f.total } : {}),
        },
      })
  }
}

function makeFetch(opts: {
  models?: string[]
  frames?: SseFrame[]
  /** HTTP status to return for /v1/chat/completions. */
  completionStatus?: number
  /** Capture the request body for assertions. */
  capture?: (path: string, body: unknown) => void
}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const path = new URL(url).pathname
    if (path === '/v1/models') {
      return new Response(
        JSON.stringify({
          object: 'list',
          data: (opts.models ?? []).map((id) => ({ id, owned_by: 'workbuddy2api' })),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (path === '/v1/chat/completions') {
      const body = init?.body === undefined ? undefined : JSON.parse(init.body as string)
      opts.capture?.(path, body)
      const status = opts.completionStatus ?? 200
      if (status !== 200) {
        return new Response('upstream error', { status })
      }
      const lines: string[] = []
      for (const f of opts.frames ?? []) {
        lines.push(`data: ${frameToJson(f)}\n\n`)
      }
      lines.push('data: [DONE]\n\n')
      return new Response(new TextEncoder().encode(lines.join('')), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    return new Response('not stubbed', { status: 599 })
  }) as typeof fetch
}

function makeAdapter(opts: {
  models?: string[]
  frames?: SseFrame[]
  completionStatus?: number
  capture?: (path: string, body: unknown) => void
}): WorkbuddyLlmAdapter {
  const fetchImpl = makeFetch(opts)
  const client = new WorkbuddyClient({
    baseURL: 'http://wb2api.local:7863',
    apiKey: 'wb2api-key',
    fetchImpl,
  })
  return new WorkbuddyLlmAdapter(client, { fetchImpl })
}

async function drain(adapter: WorkbuddyLlmAdapter, model = 'glm-5.2', extra = {}) {
  const chunks = []
  for await (const c of adapter.stream({
    provider: WORKBUDDY_PROVIDER,
    model,
    messages: [],
    ...extra,
  })) {
    chunks.push(c)
  }
  return chunks
}

// ---------------------------------------------------------------------------
// parseModelId — the case-sensitivity guard (M05 evidence: the upstream
// returns HTTP 400 code 11102 for cH:/CN:, and HTTP 503 for unknown
// realms; the plugin rejects client-side instead).

describe('parseModelId', () => {
  it('accepts a bare id and treats it as realm-unknown', () => {
    const r = parseModelId('glm-5.2')
    expect(r.ok).toBe(true)
    expect(r.wireId).toBe('glm-5.2')
    expect(r.realm).toBe(null)
    expect(r.hasRealmPrefix).toBe(false)
  })

  it('strips an exact lowercase cn: prefix', () => {
    const r = parseModelId('cn:glm-5.2')
    expect(r.ok).toBe(true)
    expect(r.wireId).toBe('glm-5.2')
    expect(r.realm).toBe('cn')
    expect(r.hasRealmPrefix).toBe(true)
  })

  it('strips an exact lowercase global: prefix', () => {
    const r = parseModelId('global:gpt-5')
    expect(r.ok).toBe(true)
    expect(r.wireId).toBe('gpt-5')
    expect(r.realm).toBe('global')
    expect(r.hasRealmPrefix).toBe(true)
  })

  it('rejects mixed-case cH: (M05 evidence: upstream 400 / 11102)', () => {
    const r = parseModelId('cH:glm-5.2')
    expect(r.ok).toBe(false)
    expect(r.rejection?.code).toBe('PROVIDER_REJECTED_CASE')
    expect(r.rejection?.message).toContain('cH:glm-5.2')
  })

  it('rejects uppercase CN:', () => {
    expect(parseModelId('CN:glm-5.2').ok).toBe(false)
  })

  it('rejects uppercase GLOBAL:', () => {
    expect(parseModelId('GLOBAL:gpt-5').ok).toBe(false)
  })

  it('rejects an unknown vendor prefix', () => {
    const r = parseModelId('openai:gpt-5')
    expect(r.ok).toBe(false)
    expect(r.rejection?.code).toBe('PROVIDER_REJECTED_CASE')
    expect(r.rejection?.message).toContain('openai:gpt-5')
  })

  it('rejects an empty id', () => {
    const r = parseModelId('')
    expect(r.ok).toBe(false)
    expect(r.rejection?.code).toBe('PROVIDER_REJECTED_EMPTY')
  })

  it('keeps internal colons in the bare part', () => {
    const r = parseModelId('cn:foo:bar')
    expect(r.ok).toBe(true)
    expect(r.wireId).toBe('foo:bar')
    expect(r.realm).toBe('cn')
  })
})

// ---------------------------------------------------------------------------
// listModels — the P0 fix from the v0.1 review. DSH must receive the
// BARE id (`glm-5.2`), not the wb2api wire id (`cn:glm-5.2`).

describe('WorkbuddyLlmAdapter.listModels', () => {
  it('strips the cn: prefix so the DSH model directory shows bare ids', async () => {
    const adapter = makeAdapter({ models: ['cn:glm-5.2', 'cn:auto', 'global:foo'] })
    const models = await adapter.listModels(WORKBUDDY_PROVIDER)
    expect(models.length).toBe(3)
    // This is the load-bearing assertion: v0.1 registered `cn:glm-5.2`.
    expect(models[0]).toEqual({
      provider: 'workbuddy',
      id: 'glm-5.2',
      name: 'glm-5.2',
      hasRealmPrefix: true,
      realm: 'cn',
    })
    expect(models[1]?.id).toBe('auto')
    expect(models[2]?.id).toBe('foo')
    expect(models[2]?.realm).toBe('global')
  })

  it('never leaks a cn: prefix into any returned id', async () => {
    const adapter = makeAdapter({ models: ['cn:glm-5.2', 'cn:hy3', 'cn:auto'] })
    const models = await adapter.listModels(WORKBUDDY_PROVIDER)
    for (const m of models) {
      expect(m.id.startsWith('cn:')).toBe(false)
      expect(m.id.startsWith('global:')).toBe(false)
      expect(m.id.includes(':')).toBe(false)
    }
  })

  it('rejects a provider route that is not workbuddy', async () => {
    const adapter = makeAdapter({ models: [] })
    await expect(adapter.listModels('openai')).rejects.toThrow(/PROVIDER_MISMATCH/)
  })

  it('caches the list within the TTL', async () => {
    let calls = 0
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const path = new URL(typeof input === 'string' ? input : input.toString()).pathname
      if (path === '/v1/models') {
        calls += 1
        return new Response(JSON.stringify({ object: 'list', data: [{ id: 'cn:x' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('', { status: 599 })
    }) as typeof fetch
    const client = new WorkbuddyClient({
      baseURL: 'http://wb2api.local:7863',
      apiKey: 'k',
      fetchImpl,
    })
    const adapter = new WorkbuddyLlmAdapter(client)
    await adapter.listModels(WORKBUDDY_PROVIDER)
    await adapter.listModels(WORKBUDDY_PROVIDER)
    expect(calls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// resolveModel

describe('WorkbuddyLlmAdapter.resolveModel', () => {
  it('resolves a bare id without a prefix', async () => {
    const adapter = makeAdapter({ models: [] })
    const m = await adapter.resolveModel(WORKBUDDY_PROVIDER, 'glm-5.2')
    expect(m.id).toBe('glm-5.2')
    expect(m.provider).toBe(WORKBUDDY_PROVIDER)
  })

  it('throws PROVIDER_REJECTED_CASE for cH:glm-5.2', async () => {
    const adapter = makeAdapter({ models: [] })
    let caught: unknown
    try {
      await adapter.resolveModel(WORKBUDDY_PROVIDER, 'cH:glm-5.2')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(WorkbuddyLlmError)
    expect((caught as WorkbuddyLlmError).code).toBe('PROVIDER_REJECTED_CASE')
  })

  it('throws PROVIDER_MISMATCH for another provider', async () => {
    const adapter = makeAdapter({ models: [] })
    let caught: unknown
    try {
      await adapter.resolveModel('openai', 'gpt-5')
    } catch (e) {
      caught = e
    }
    expect((caught as WorkbuddyLlmError).code).toBe('PROVIDER_MISMATCH')
  })
})

// ---------------------------------------------------------------------------
// providerInfo — the runtime rejects a metadata id/name mismatch
// (M02 evidence, LlmRuntime.prepareRoutes).

describe('WorkbuddyLlmAdapter.providerInfo', () => {
  it('returns id + name matching the registered route', () => {
    const adapter = makeAdapter({ models: [] })
    const info = adapter.providerInfo(WORKBUDDY_PROVIDER)
    expect(info.id).toBe(WORKBUDDY_PROVIDER)
    expect(info.name).toBe('WorkBuddy / CodeBuddy')
  })

  it('throws PROVIDER_MISMATCH for another provider', () => {
    const adapter = makeAdapter({ models: [] })
    let caught: unknown
    try {
      adapter.providerInfo('openai')
    } catch (e) {
      caught = e
    }
    expect((caught as WorkbuddyLlmError).code).toBe('PROVIDER_MISMATCH')
  })
})

// ---------------------------------------------------------------------------
// stream — the DSH contract. The adapter receives `GenerateOptions`
// (provider / model / messages / …), NOT a custom options object, and
// emits the `StreamChunk` discriminated union.

describe('WorkbuddyLlmAdapter.stream', () => {
  it('reads GenerateOptions and sends the bare id on the wire', async () => {
    let sent: unknown = null
    const adapter = makeAdapter({
      frames: [{ kind: 'text', text: 'hi' }, { kind: 'finish', reason: 'stop' }],
      capture: (_path, body) => {
        sent = body
      },
    })
    await drain(adapter, 'cn:glm-5.2')
    const body = sent as { model: string; stream: boolean; messages: unknown[] }
    // Prefix stripped for the wire.
    expect(body.model).toBe('glm-5.2')
    expect(body.stream).toBe(true)
    expect(body.messages.length).toBe(0)
  })

  it('emits block-start + text-delta + block-end + finish for a text answer', async () => {
    const adapter = makeAdapter({
      frames: [
        { kind: 'text', text: 'Hello' },
        { kind: 'text', text: ' world' },
        { kind: 'finish', reason: 'stop' },
      ],
    })
    const chunks = await drain(adapter)
    // First chunk opens a text block.
    expect(chunks[0]).toEqual({ type: 'block-start', index: 0, blockType: 'text' })
    // Two text deltas follow.
    expect(chunks[1]).toEqual({ type: 'text-delta', index: 0, text: 'Hello' })
    expect(chunks[2]).toEqual({ type: 'text-delta', index: 0, text: ' world' })
    // A block-end carries the assembled block.
    const blockEnd = chunks.find((c) => c.type === 'block-end') as
      | { type: 'block-end'; index: number; block: { type: string; text: string } }
      | undefined
    expect(blockEnd).toBeDefined()
    expect(blockEnd?.block.type).toBe('text')
    expect(blockEnd?.block.text).toBe('Hello world')
    // The stream ends with a finish chunk whose reason is the object union.
    const finish = chunks.find((c) => c.type === 'finish') as
      | { type: 'finish'; reason: { kind: string } }
      | undefined
    expect(finish).toBeDefined()
    expect(finish?.reason).toEqual({ kind: 'stop' })
  })

  it('emits a reasoning block for reasoning_content deltas', async () => {
    const adapter = makeAdapter({
      frames: [
        { kind: 'reasoning', text: 'thinking…' },
        { kind: 'text', text: 'answer' },
        { kind: 'finish', reason: 'stop' },
      ],
    })
    const chunks = await drain(adapter)
    expect(chunks[0]).toEqual({ type: 'block-start', index: 0, blockType: 'reasoning' })
    expect(chunks[1]).toEqual({ type: 'reasoning-delta', index: 0, text: 'thinking…' })
    const types = chunks.map((c) => c.type)
    expect(types).toContain('text-delta')
  })

  it('assembles a tool call from tool_calls deltas (the Agent path)', async () => {
    const adapter = makeAdapter({
      frames: [
        { kind: 'tool-call', id: 'call_1', name: 'get_weather', argumentsDelta: '{"city":' },
        { kind: 'tool-call', argumentsDelta: '"Beijing"}' },
        { kind: 'finish', reason: 'tool_calls' },
      ],
    })
    const chunks = await drain(adapter, 'glm-5.2', {
      tools: [
        {
          name: 'get_weather',
          description: 'Get the weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      ],
    })
    // The block opens as tool-call.
    expect(chunks[0]).toEqual({ type: 'block-start', index: 0, blockType: 'tool-call' })
    // Tool-call deltas carry the id, name and arguments fragments.
    const deltas = chunks.filter((c) => c.type === 'tool-call-delta')
    expect(deltas.length).toBeGreaterThanOrEqual(2)
    // The block-end carries the assembled call.
    const blockEnd = chunks.find((c) => c.type === 'block-end') as
      | {
          type: 'block-end'
          block: { type: string; id: string; name: string; arguments: string }
        }
      | undefined
    expect(blockEnd).toBeDefined()
    expect(blockEnd?.block.type).toBe('tool-call')
    expect(blockEnd?.block.name).toBe('get_weather')
    // `ToolCallBlock.arguments` is a RAW JSON STRING in dsh-llm ("Raw JSON
    // string as produced by the model"), not a parsed object. An earlier
    // revision of this test asserted `toEqual({ city: 'Beijing' })` and so
    // encoded the adapter bug instead of catching it: the runtime's
    // dispatcher JSON.parses this field itself.
    expect(typeof blockEnd?.block.arguments).toBe('string')
    expect(JSON.parse(blockEnd!.block.arguments)).toEqual({ city: 'Beijing' })
    // The finish reason reflects the tool-call stop.
    const finish = chunks.find((c) => c.type === 'finish') as
      | { type: 'finish'; reason: { kind: string } }
      | undefined
    expect(finish?.reason).toEqual({ kind: 'tool-calls' })
  })

  it('maps OpenAI finish_reason=length to max-tokens', async () => {
    const adapter = makeAdapter({
      frames: [{ kind: 'text', text: 'x' }, { kind: 'finish', reason: 'length' }],
    })
    const chunks = await drain(adapter)
    const finish = chunks.find((c) => c.type === 'finish') as
      | { type: 'finish'; reason: { kind: string } }
      | undefined
    expect(finish?.reason).toEqual({ kind: 'max-tokens' })
  })

  it('emits a usage chunk with inputTokens/outputTokens', async () => {
    const adapter = makeAdapter({
      frames: [
        { kind: 'text', text: 'hi' },
        { kind: 'finish', reason: 'stop' },
        { kind: 'usage', prompt: 7, completion: 10, total: 17 },
      ],
    })
    const chunks = await drain(adapter)
    const usage = chunks.find((c) => c.type === 'usage') as
      | { type: 'usage'; usage: { inputTokens: number; outputTokens: number; totalTokens?: number } }
      | undefined
    expect(usage).toBeDefined()
    expect(usage?.usage.inputTokens).toBe(7)
    expect(usage?.usage.outputTokens).toBe(10)
    expect(usage?.usage.totalTokens).toBe(17)
  })

  it('throws PROVIDER_REJECTED_CASE instead of sending a bad id upstream', async () => {
    let called = false
    const adapter = makeAdapter({
      capture: () => {
        called = true
      },
    })
    let caught: unknown
    try {
      await drain(adapter, 'CN:glm-5.2')
    } catch (e) {
      caught = e
    }
    expect((caught as WorkbuddyLlmError).code).toBe('PROVIDER_REJECTED_CASE')
    // The request never reached the wire.
    expect(called).toBe(false)
  })

  it('throws PROVIDER_HTTP when wb2api returns an error status', async () => {
    const adapter = makeAdapter({ completionStatus: 503 })
    let caught: unknown
    try {
      await drain(adapter)
    } catch (e) {
      caught = e
    }
    expect((caught as WorkbuddyLlmError).code).toBe('PROVIDER_HTTP')
  })

  it('throws CALL_CANCELLED when the signal is already aborted', async () => {
    const adapter = makeAdapter({})
    const ac = new AbortController()
    ac.abort()
    let caught: unknown
    try {
      await drain(adapter, 'glm-5.2', { signal: ac.signal })
    } catch (e) {
      caught = e
    }
    expect((caught as WorkbuddyLlmError).code).toBe('CALL_CANCELLED')
  })

  it('forwards tools to the OpenAI wire body', async () => {
    let sent: unknown = null
    const adapter = makeAdapter({
      frames: [{ kind: 'finish', reason: 'stop' }],
      capture: (_p, body) => {
        sent = body
      },
    })
    await drain(adapter, 'glm-5.2', {
      tools: [{ name: 't', description: 'd', parameters: { type: 'object' } }],
    })
    const body = sent as { tools?: Array<{ type: string; function: { name: string } }> }
    expect(body.tools?.length).toBe(1)
    expect(body.tools?.[0]?.type).toBe('function')
    expect(body.tools?.[0]?.function.name).toBe('t')
  })
})
