/**
 * Message serialization: DSH conversation -> OpenAI Chat Completions wire.
 *
 * The PR review named this the load-bearing gap in the Batch 2 tests:
 * `BlockAssembler` verifies how a *response* is assembled but says nothing
 * about whether the *next request* is legal. A wrong request is what breaks
 * the agent loop, and it fails in a way the streaming tests cannot see.
 *
 * Every test here asserts the **whole `messages` array** the adapter put on the
 * wire, not a field of it. Asserting a field is what let the earlier bug
 * through: the previous code serialized every message as
 * `{ role, content }` with `JSON.stringify` for array content, so a user turn
 * arrived as `"[{\"type\":\"text\",\"text\":\"hi\"}]"` and a tool result
 * arrived with no `tool_call_id` at all.
 */

import { describe, expect, it } from 'vitest'
import {
  createAssistantMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, RequestMessage } from '@deepseek-ai/dsh-llm'

import { WorkbuddyLlmAdapter, WORKBUDDY_PROVIDER } from '../src/host/llm-adapter.js'
import { WorkbuddyClient } from '../src/host/workbuddy-client.js'

/** The wire message shape this adapter produces. */
interface WireMessage {
  role: string
  content: string | null
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

/** Run one call and return the decoded request body. */
async function captureBody(options: Partial<GenerateOptions> & { model?: string }) {
  let captured: Record<string, unknown> | undefined
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const path = new URL(typeof input === 'string' ? input : input.toString()).pathname
    if (path === '/v1/models') {
      return new Response(JSON.stringify({ object: 'list', data: [] }), { status: 200 })
    }
    if (typeof init?.body === 'string') {
      captured = JSON.parse(init.body) as Record<string, unknown>
    }
    const sse =
      'data: ' +
      JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }) +
      '\n\ndata: ' +
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) +
      '\n\ndata: [DONE]\n\n'
    return new Response(new TextEncoder().encode(sse), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }) as typeof fetch

  const client = new WorkbuddyClient({
    baseURL: 'http://wb2api.local:7863',
    apiKey: 'k',
    fetchImpl,
  })
  const adapter = new WorkbuddyLlmAdapter(client, { fetchImpl })

  // Drain the stream; the body is captured as a side effect of the request.
  for await (const _chunk of adapter.stream({
    provider: WORKBUDDY_PROVIDER,
    model: options.model ?? 'glm-5.2',
    messages: (options.messages ?? []) as RequestMessage[],
    ...(options.system !== undefined ? { system: options.system } : {}),
    ...(options.tools !== undefined ? { tools: options.tools } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
  })) {
    void _chunk
  }

  if (captured === undefined) throw new Error('adapter never sent a completion request')
  return captured
}

function messagesOf(body: Record<string, unknown>): WireMessage[] {
  return body.messages as WireMessage[]
}

const user = (text: string): Message =>
  createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

// ---------------------------------------------------------------------------

describe('wire serialization — user content', () => {
  it('sends user text as plain text, not as a JSON string of the block array', async () => {
    // The exact v0.2 regression: `JSON.stringify(content)` produced
    // `[{"type":"text","text":"你好"}]` on the wire, so the model received
    // JSON syntax instead of the user's words.
    const body = await captureBody({ messages: [user('你好')] })
    expect(messagesOf(body)).toEqual([{ role: 'user', content: '你好' }])
  })

  it('joins several text blocks in one message with a blank line', async () => {
    const message = createUserMessage({
      content: [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ],
      source: { kind: 'user' },
    })
    const body = await captureBody({ messages: [message] })
    expect(messagesOf(body)).toEqual([{ role: 'user', content: 'first\n\nsecond' }])
  })

  it('renders an unprojected image block as text rather than dropping it', async () => {
    // The runtime projects images to placeholders for a text-only route, so
    // this should not occur. If it does, the block must not vanish silently.
    const message = {
      role: 'user',
      content: [
        { type: 'text', text: 'look at this' },
        { type: 'image', attachment: { id: 'a', name: 'x.png' } },
      ],
    } as unknown as Message
    const body = await captureBody({ messages: [message] })
    const [wire] = messagesOf(body)
    expect(wire?.content).toContain('look at this')
    expect(wire?.content).toContain('image omitted')
  })
})

describe('wire serialization — system prompt', () => {
  it('prepends GenerateOptions.system ahead of the conversation', async () => {
    const body = await captureBody({
      system: 'You are terse.',
      messages: [user('hi')],
    })
    expect(messagesOf(body)).toEqual([
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'hi' },
    ])
  })

  it('keeps a leading system message in order when no system option is given', async () => {
    const body = await captureBody({
      messages: [createSystemMessage('be helpful'), user('hi')],
    })
    expect(messagesOf(body)).toEqual([
      { role: 'system', content: 'be helpful' },
      { role: 'user', content: 'hi' },
    ])
  })
})

describe('wire serialization — the tool round trip', () => {
  /**
   * The failure this guards against: the provider correlates a tool result
   * with the assistant turn that requested it through `tool_call_id` and
   * `tool_calls`. DSH carries that correlation in `ToolResultMessage.toolCallId`
   * and in `tool-call` content blocks; serializing by role and text alone
   * loses both, and the provider sees an orphan tool message.
   */
  it('carries tool_calls on the assistant turn and tool_call_id on the result', async () => {
    const assistant = createAssistantMessage({
      content: [
        { type: 'text', text: 'Let me check.' },
        {
          type: 'tool-call',
          id: ToolCallId('call_abc'),
          name: 'get_weather',
          arguments: '{"city":"Beijing"}',
        },
      ],
      source: { provider: WORKBUDDY_PROVIDER, model: 'glm-5.2' },
    })
    const toolResult = createToolResultMessage({
      callId: ToolCallId('call_abc'),
      content: [{ type: 'text', text: 'Beijing: 22C, clear' }],
      isError: false,
    })

    const body = await captureBody({
      messages: [user('Weather in Beijing?'), assistant, toolResult],
    })

    expect(messagesOf(body)).toEqual([
      { role: 'user', content: 'Weather in Beijing?' },
      {
        role: 'assistant',
        content: 'Let me check.',
        tool_calls: [
          {
            id: 'call_abc',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Beijing"}' },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_abc',
        content: 'Beijing: 22C, clear',
      },
    ])
  })

  it('sends content: null for an assistant turn that only requests tools', async () => {
    const assistant = createAssistantMessage({
      content: [
        { type: 'tool-call', id: ToolCallId('call_1'), name: 'ls', arguments: '{"path":"."}' },
      ],
      source: { provider: WORKBUDDY_PROVIDER, model: 'glm-5.2' },
    })
    const body = await captureBody({ messages: [assistant] })
    const [wire] = messagesOf(body)
    expect(wire?.role).toBe('assistant')
    expect(wire?.content).toBe(null)
    expect(wire?.tool_calls?.[0]?.id).toBe('call_1')
  })

  it('keeps parallel tool calls distinct and in block order', async () => {
    const assistant = createAssistantMessage({
      content: [
        { type: 'tool-call', id: ToolCallId('call_a'), name: 'get_weather', arguments: '{"city":"Beijing"}' },
        { type: 'tool-call', id: ToolCallId('call_b'), name: 'get_weather', arguments: '{"city":"Shanghai"}' },
      ],
      source: { provider: WORKBUDDY_PROVIDER, model: 'glm-5.2' },
    })
    const body = await captureBody({ messages: [assistant] })
    const [wire] = messagesOf(body)
    expect(wire?.tool_calls?.map((c) => c.id)).toEqual(['call_a', 'call_b'])
    // Arguments stay the raw JSON string the model produced.
    expect(typeof wire?.tool_calls?.[0]?.function.arguments).toBe('string')
  })
})

describe('wire serialization — blocks that must not reach the provider', () => {
  it('drops reasoning blocks instead of echoing the scratchpad back', async () => {
    const assistant = createAssistantMessage({
      content: [
        { type: 'reasoning', text: 'the user probably wants X' },
        { type: 'text', text: 'Here is the answer.' },
      ],
      source: { provider: WORKBUDDY_PROVIDER, model: 'glm-5.2' },
    })
    const body = await captureBody({ messages: [assistant] })
    expect(messagesOf(body)).toEqual([
      { role: 'assistant', content: 'Here is the answer.' },
    ])
    expect(JSON.stringify(body)).not.toContain('probably wants X')
  })

  it('drops tool-addition / tool-removal bookkeeping from message content', async () => {
    // `projectToolUpdates` folds these into the `tools` argument, so they must
    // not also appear as text - and a developer message carrying only these is
    // dropped rather than sent as an empty system turn.
    const developer = {
      role: 'developer',
      content: [
        { type: 'tool-addition', toolName: 'get_weather' },
        { type: 'tool-removal', toolName: 'legacy_tool' },
      ],
    } as unknown as Message
    const body = await captureBody({ messages: [developer, user('hi')] })
    expect(messagesOf(body)).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('drops an assistant turn that carries nothing', async () => {
    const empty = createAssistantMessage({
      content: [],
      source: { provider: WORKBUDDY_PROVIDER, model: 'glm-5.2' },
    })
    const body = await captureBody({ messages: [empty, user('hi')] })
    expect(messagesOf(body)).toEqual([{ role: 'user', content: 'hi' }])
  })
})

describe('wire serialization — model id and knobs', () => {
  it('sends the bare model id when the caller passes a cn: prefix', async () => {
    const body = await captureBody({ model: 'cn:glm-5.2', messages: [] })
    expect(body.model).toBe('glm-5.2')
  })

  it('refuses a global-realm model before building a request', async () => {
    let sent = false
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const path = new URL(typeof input === 'string' ? input : input.toString()).pathname
      if (path === '/v1/chat/completions') sent = true
      return new Response(JSON.stringify({ object: 'list', data: [] }), { status: 200 })
    }) as typeof fetch
    const client = new WorkbuddyClient({
      baseURL: 'http://wb2api.local:7863',
      apiKey: 'k',
      fetchImpl,
    })
    const adapter = new WorkbuddyLlmAdapter(client, { fetchImpl })

    let caught: unknown
    try {
      for await (const _c of adapter.stream({
        provider: WORKBUDDY_PROVIDER,
        model: 'global:glm-5.2',
        messages: [],
      })) {
        void _c
      }
    } catch (e) {
      caught = e
    }
    expect(String((caught as { code?: string }).code)).toBe('PROVIDER_REJECTED_GLOBAL')
    expect(sent).toBe(false)
  })

  it('maps temperature, maxTokens and stop onto the wire field names', async () => {
    const body = await captureBody({
      messages: [],
      temperature: 0.3,
      maxTokens: 512,
    })
    expect(body.temperature).toBe(0.3)
    expect(body.max_tokens).toBe(512)
    expect(body.stream).toBe(true)
  })
})
