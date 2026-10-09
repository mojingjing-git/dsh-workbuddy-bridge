/**
 * Local simulated end-to-end test.
 *
 * This is NOT a substitute for the real DSH Desktop acceptance run. It is a
 * contract test that consumes the adapter's output with the DSH runtime's own
 * consumers instead of with mocks of our own making:
 *
 *   - `BlockAssembler` is "the single canonical assembly algorithm used by
 *     the agent loop to build an assistant message from a chunk stream"
 *     (`@deepseek-ai/dsh-llm/lib/types/assembler.d.ts`).
 *   - `createUserMessage` / `createToolResultMessage` are the runtime's own
 *     message constructors.
 *
 * If the adapter emits a chunk sequence the real assembler cannot turn into a
 * usable assistant message, these tests fail. That closes the specific gap
 * the PR #1 review called out: v0.1's tests asserted against types the plugin
 * had defined itself, so they proved only self-consistency.
 *
 * What it still cannot prove: that the DSH desktop actually loads the plugin,
 * that `ctx.llm` is reachable, that the user's chosen model supports tool
 * calls, and that a real tool executes. Those need the desktop run described
 * in `docs/probe/BATCH2-E2E-RUNBOOK.md`.
 */

import { describe, expect, it } from 'vitest'
import {
  BlockAssembler,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, ToolSchema } from '@deepseek-ai/dsh-llm'

import { WorkbuddyLlmAdapter, WORKBUDDY_PROVIDER } from '../src/host/llm-adapter.js'
import { WorkbuddyClient } from '../src/host/workbuddy-client.js'

// ---------------------------------------------------------------------------
// A fetch stub that answers with a realistic OpenAI Chat Completions SSE
// stream, built from the same frame vocabulary a real wb2api emits.

type Frame =
  | { role: 'assistant' }
  | { text: string }
  | { reasoning: string }
  | { toolIndex: number; id?: string; name?: string; args?: string }
  | { finish: string }
  | { usage: { prompt: number; completion: number; total?: number } }

function frameToBody(f: Frame): Record<string, unknown> {
  if ('role' in f) return { choices: [{ delta: { role: f.role } }] }
  if ('text' in f) return { choices: [{ delta: { content: f.text } }] }
  if ('reasoning' in f) return { choices: [{ delta: { reasoning_content: f.reasoning } }] }
  if ('toolIndex' in f) {
    return {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: f.toolIndex,
                ...(f.id !== undefined ? { id: f.id } : {}),
                type: 'function',
                function: {
                  ...(f.name !== undefined ? { name: f.name } : {}),
                  ...(f.args !== undefined ? { arguments: f.args } : {}),
                },
              },
            ],
          },
        },
      ],
    }
  }
  if ('finish' in f) return { choices: [{ delta: {}, finish_reason: f.finish }] }
  return {
    choices: [],
    usage: {
      prompt_tokens: f.usage.prompt,
      completion_tokens: f.usage.completion,
      ...(f.usage.total !== undefined ? { total_tokens: f.usage.total } : {}),
    },
  }
}

function makeSseResponse(frames: readonly Frame[]): Response {
  const body = frames.map((f) => `data: ${JSON.stringify(frameToBody(f))}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(new TextEncoder().encode(body), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

interface WireCapture {
  path: string
  body: Record<string, unknown>
}

function makeAdapter(
  frames: readonly Frame[],
  captured: WireCapture[] = [],
): { adapter: WorkbuddyLlmAdapter; captured: WireCapture[] } {
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(typeof input === 'string' ? input : input.toString()).pathname
    if (path === '/v1/models') {
      return new Response(JSON.stringify({ object: 'list', data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (init?.body !== undefined) {
      captured.push({ path, body: JSON.parse(init.body as string) as Record<string, unknown> })
    }
    return makeSseResponse(frames)
  }) as typeof fetch
  const client = new WorkbuddyClient({
    baseURL: 'http://wb2api.local:7863',
    apiKey: 'wb2api-key',
    fetchImpl,
  })
  return { adapter: new WorkbuddyLlmAdapter(client, { fetchImpl }), captured }
}

/** Drive the adapter and feed every chunk through the runtime's assembler. */
async function runOnce(
  adapter: WorkbuddyLlmAdapter,
  options: GenerateOptions,
): Promise<BlockAssembler> {
  const assembler = new BlockAssembler()
  for await (const chunk of adapter.stream(options)) {
    assembler.push(chunk)
  }
  return assembler
}

const WEATHER_TOOL: ToolSchema = {
  name: 'get_weather',
  description: 'Get the current weather for a city',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
}

// ---------------------------------------------------------------------------

describe('simulated E2E — text turn', () => {
  it('the real BlockAssembler turns the adapter stream into an assistant message', async () => {
    const { adapter } = makeAdapter([
      { role: 'assistant' },
      { text: 'The answer ' },
      { text: 'is 42.' },
      { finish: 'stop' },
      { usage: { prompt: 12, completion: 8, total: 20 } },
    ])

    const assembler = await runOnce(adapter, {
      provider: WORKBUDDY_PROVIDER,
      model: 'glm-5.2',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'What is the answer?' }] })],
    })

    const blocks = assembler.blocks()
    expect(blocks.length).toBe(1)
    expect(blocks[0]).toEqual({ type: 'text', text: 'The answer is 42.' })
    expect(assembler.finish).toEqual({ kind: 'stop' })
    expect(assembler.usage?.inputTokens).toBe(12)
    expect(assembler.usage?.outputTokens).toBe(8)
    expect(assembler.usage?.totalTokens).toBe(20)

    const message = assembler.message({ provider: WORKBUDDY_PROVIDER, model: 'glm-5.2' })
    expect(message.role).toBe('assistant')
    expect(message.content).toEqual([{ type: 'text', text: 'The answer is 42.' }])
  })
})

describe('simulated E2E — tool-call turn (the Agent path)', () => {
  it('assembles a usable tool call whose arguments are a JSON string', async () => {
    const { adapter, captured } = makeAdapter([
      { role: 'assistant' },
      { toolIndex: 0, id: 'call_abc', name: 'get_weather', args: '{"city":' },
      { toolIndex: 0, args: '"Beijing"}' },
      { finish: 'tool_calls' },
    ])

    const assembler = await runOnce(adapter, {
      provider: WORKBUDDY_PROVIDER,
      model: 'glm-5.2',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'Weather in Beijing?' }] })],
      tools: [WEATHER_TOOL],
    })

    // The tool definitions reached the wire in OpenAI shape.
    const tools = captured[0]?.body.tools as Array<{ type: string; function: { name: string } }>
    expect(tools.length).toBe(1)
    expect(tools[0]?.type).toBe('function')
    expect(tools[0]?.function.name).toBe('get_weather')

    const blocks = assembler.blocks()
    expect(blocks.length).toBe(1)
    const call = blocks[0] as { type: string; id: string; name: string; arguments: string }
    expect(call.type).toBe('tool-call')
    expect(call.id).toBe('call_abc')
    expect(call.name).toBe('get_weather')
    // `ToolCallBlock.arguments` is a raw JSON string, so the runtime can
    // JSON.parse it for dispatch. An object here would break dispatch.
    expect(typeof call.arguments).toBe('string')
    expect(JSON.parse(call.arguments)).toEqual({ city: 'Beijing' })

    expect(assembler.finish).toEqual({ kind: 'tool-calls' })
  })

  it('maps max-token truncation, which makes the assembler drop the tool call', async () => {
    // `BlockAssembler.assembled()` drops tool-call blocks when the finish
    // reason is max-tokens, because a truncated call cannot be dispatched
    // safely. This asserts the adapter reports the reason the assembler's
    // keep/drop decision keys off.
    const { adapter } = makeAdapter([
      { role: 'assistant' },
      { toolIndex: 0, id: 'call_trunc', name: 'get_weather', args: '{"city":"Bei' },
      { finish: 'length' },
    ])

    const assembler = await runOnce(adapter, {
      provider: WORKBUDDY_PROVIDER,
      model: 'glm-5.2',
      messages: [],
      tools: [WEATHER_TOOL],
    })

    expect(assembler.finish).toEqual({ kind: 'max-tokens' })
    expect(assembler.blocks().some((b) => b.type === 'tool-call')).toBe(false)
  })

  it('keeps parallel tool calls apart by their upstream index', async () => {
    const { adapter } = makeAdapter([
      { role: 'assistant' },
      { toolIndex: 0, id: 'call_a', name: 'get_weather', args: '{"city":"Beijing"}' },
      { toolIndex: 1, id: 'call_b', name: 'get_weather', args: '{"city":"Shanghai"}' },
      { finish: 'tool_calls' },
    ])

    const assembler = await runOnce(adapter, {
      provider: WORKBUDDY_PROVIDER,
      model: 'glm-5.2',
      messages: [],
      tools: [WEATHER_TOOL],
    })

    const calls = assembler
      .blocks()
      .filter((b): b is Extract<ContentBlock, { type: 'tool-call' }> => b.type === 'tool-call')
    expect(calls.length).toBe(2)
    expect(calls.map((c) => c.id).sort()).toEqual(['call_a', 'call_b'])
    expect(calls.map((c) => JSON.parse(c.arguments).city).sort()).toEqual(['Beijing', 'Shanghai'])
  })
})

describe('simulated E2E — full agent round trip', () => {
  it('carries a tool result back to wb2api on the next request', async () => {
    // Turn 1: the model asks for a tool call.
    const turn1Frames: Frame[] = [
      { role: 'assistant' },
      { toolIndex: 0, id: 'call_1', name: 'get_weather', args: '{"city":"Beijing"}' },
      { finish: 'tool_calls' },
    ]
    const turn1 = makeAdapter(turn1Frames)
    const userMessage = createUserMessage({
      content: [{ type: 'text', text: 'Weather in Beijing?' }],
    })

    const firstAssembler = await runOnce(turn1.adapter, {
      provider: WORKBUDDY_PROVIDER,
      model: 'glm-5.2',
      messages: [userMessage],
      tools: [WEATHER_TOOL],
    })
    const call = firstAssembler.blocks()[0] as { type: 'tool-call'; id: string }
    expect(call.type).toBe('tool-call')

    // The agent loop turns the assistant message and a tool result into the
    // next request. We build both with the runtime's own constructors.
    const assistantMessage = firstAssembler.message({
      provider: WORKBUDDY_PROVIDER,
      model: 'glm-5.2',
    })
    const toolResult = createToolResultMessage({
      callId: call.id as never,
      content: [{ type: 'text', text: 'Beijing: 22C, clear' }],
    })

    // Turn 2: the model answers using the tool result.
    const turn2 = makeAdapter([
      { role: 'assistant' },
      { text: 'It is 22C and clear in Beijing.' },
      { finish: 'stop' },
    ])
    const secondAssembler = await runOnce(turn2.adapter, {
      provider: WORKBUDDY_PROVIDER,
      model: 'glm-5.2',
      messages: [userMessage, assistantMessage, toolResult],
      tools: [WEATHER_TOOL],
    })

    // The final natural-language answer is the acceptance condition.
    const text = secondAssembler
      .blocks()
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('')
    expect(text).toBe('It is 22C and clear in Beijing.')

    // The third message on the wire is a tool-role message carrying the
    // result: this is what proves the round trip closed rather than the model
    // guessing.
    const sent = turn2.captured[0]?.body.messages as Array<Record<string, unknown>>
    expect(sent.length).toBe(3)
    expect(sent[2]?.role).toBe('tool')
    expect(JSON.stringify(sent[2])).toContain('Beijing: 22C, clear')
  })
})

describe('simulated E2E — interleaved blocks', () => {
  it('keeps reasoning, text and a tool call as three separate blocks', async () => {
    // The v0.1 translator tracked a single "current" block, so it could not
    // represent this shape. The runtime's assembler keys blocks by index and
    // explicitly supports interleaving.
    const { adapter } = makeAdapter([
      { role: 'assistant' },
      { reasoning: 'I should check the weather first.' },
      { text: 'Let me look that up. ' },
      { toolIndex: 0, id: 'call_x', name: 'get_weather', args: '{"city":"Beijing"}' },
      { finish: 'tool_calls' },
    ])

    const assembler = await runOnce(adapter, {
      provider: WORKBUDDY_PROVIDER,
      model: 'glm-5.2',
      messages: [],
      tools: [WEATHER_TOOL],
    })

    const types = assembler.blocks().map((b) => b.type).sort()
    expect(types).toEqual(['reasoning', 'text', 'tool-call'])
    const reasoning = assembler.blocks().find((b) => b.type === 'reasoning') as { text: string }
    expect(reasoning.text).toBe('I should check the weather first.')
    const text = assembler.blocks().find((b) => b.type === 'text') as { text: string }
    expect(text.text).toBe('Let me look that up. ')
  })
})

describe('simulated E2E — interruption', () => {
  it('surfaces partial text through interruptedBlocks() and drops the tool call', async () => {
    // An interrupted stream is the case where DSH reads
    // `interruptedBlocks()`: text already streamed to the user is kept, an
    // undelivered tool call is not.
    const frames: Frame[] = [
      { role: 'assistant' },
      { text: 'Here is what I found: ' },
      { toolIndex: 0, id: 'call_y', name: 'get_weather', args: '{"city":"Beijing"}' },
      // No finish: the caller aborts here.
    ]

    const ac = new AbortController()
    const assembler = new BlockAssembler()
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(typeof input === 'string' ? input : input.toString()).pathname
      if (path === '/v1/models') {
        return new Response(JSON.stringify({ object: 'list', data: [] }), { status: 200 })
      }
      void init
      // Deliver the frames on the first pull, then abort the connection on
      // the second: that reproduces "the model was mid-response when the user
      // hit stop" with deterministic ordering. Erroring straight from
      // `start()` would discard the queued chunk before the adapter could
      // read it, because ReadableStream drops queued data on error.
      const body = frames.map((f) => `data: ${JSON.stringify(frameToBody(f))}\n\n`).join('')
      let pulls = 0
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1
          if (pulls === 1) {
            controller.enqueue(new TextEncoder().encode(body))
            return
          }
          ac.abort()
          controller.error(new DOMException('aborted', 'AbortError'))
        },
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as typeof fetch

    const client = new WorkbuddyClient({
      baseURL: 'http://wb2api.local:7863',
      apiKey: 'k',
      fetchImpl,
    })
    const adapter = new WorkbuddyLlmAdapter(client, { fetchImpl })

    let caught: unknown
    try {
      for await (const chunk of adapter.stream({
        provider: WORKBUDDY_PROVIDER,
        model: 'glm-5.2',
        messages: [],
        signal: ac.signal,
      })) {
        assembler.push(chunk)
      }
    } catch (e) {
      caught = e
    }

    // The adapter reported the cancellation rather than a generic failure.
    expect(caught).toBeDefined()
    expect(String((caught as { code?: string }).code)).toBe('CALL_CANCELLED')

    // The user keeps the text they already saw; the tool call is dropped.
    const partial = assembler.interruptedBlocks()
    expect(partial.some((b) => b.type === 'text')).toBe(true)
    expect(partial.some((b) => b.type === 'tool-call')).toBe(false)
  })
})

describe('simulated E2E — model id hygiene reaches the wire', () => {
  it('sends the bare id even when the caller passes a cn: prefix', async () => {
    const { adapter, captured } = makeAdapter([
      { role: 'assistant' },
      { text: 'ok' },
      { finish: 'stop' },
    ])
    await runOnce(adapter, {
      provider: WORKBUDDY_PROVIDER,
      model: 'cn:glm-5.2',
      messages: [],
    })
    expect(captured[0]?.body.model).toBe('glm-5.2')
  })

  it('refuses a malformed prefix before any request is sent', async () => {
    const { adapter, captured } = makeAdapter([
      { role: 'assistant' },
      { text: 'ok' },
      { finish: 'stop' },
    ])
    let caught: unknown
    try {
      await runOnce(adapter, {
        provider: WORKBUDDY_PROVIDER,
        model: 'cH:glm-5.2',
        messages: [],
      })
    } catch (e) {
      caught = e
    }
    expect(String((caught as { code?: string }).code)).toBe('PROVIDER_REJECTED_CASE')
    expect(captured.length).toBe(0)
  })
})
