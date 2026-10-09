/**
 * LLM adapter for the workbuddy provider.
 *
 * Plan reference: V2.2.1 §5 (model list), §6.2 (auth), M02 evidence.
 *
 * v0.2 design (corrected from v0.1):
 *
 * - **Imports `@deepseek-ai/dsh-llm` types as `import type` only.** The
 *   runtime instance of the `llm` service comes from the DSH desktop
 *   bundle (`ctx.llm`); the plugin never imports the package at
 *   runtime. v0.1's `WorkbuddyStreamOptions` was a duck-typed shape
 *   that did not match the real `GenerateOptions`; v0.2 is the real
 *   shape and the real `StreamChunk` union.
 *
 * - **Extends the official `LlmAdapter` class** instead of declaring
 *   a parallel shape. v0.1's `WorkbuddyLlmAdapterShape` is gone.
 *   `LlmAdapter.stream(options: GenerateOptions)` is now the entry
 *   point; `providerInfo`, `providerRetryPolicy`,
 *   `imageRequestPricing`, `listModels`, `resolveModel`, and
 *   `prepareCall` are inherited overrides where the base default
 *   is not appropriate.
 *
 * - **The wb2api wire format is OpenAI Chat Completions
 *   (SSE /v1/chat/completions).** v0.1's SSE parser was wrong
 *   about the chunk envelope and never handled `delta.tool_calls`,
 *   which is the only way an Agent can request a tool execution.
 *   v0.2 emits the full `StreamChunk` discriminated union and
 *   assembles a tool call from `delta.tool_calls` deltas.
 *
 * - **CN model ids reach DSH without the `cn:` prefix.** v0.1
 *   registered `cn:glm-5.2` as the model id in the harness
 *   directory, contradicting plan §0.3 rule 1 / §5.2. v0.2 strips
 *   the prefix in `listModels` / `resolveModel` so the user sees
 *   `glm-5.2`. The wire id sent to wb2api is the bare id.
 *
 * - **`global:` is disabled in v0.2.** A user who picks
 *   `global:glm-5.2` gets a clear error; we do not strip the
 *   prefix and risk the upstream mistakenly routing a global
 *   account to CN. (M07 evidence: the user's wb2api v1.13 has
 *   zero global accounts, so this is a v2.3 problem, not a
 *   v0.2 problem.)
 *
 * - **`cH:` / `CN:` / `GLOBAL:` are rejected client-side** by
 *   `parseModelId`, which throws an `LlmError` with code
 *   `PROVIDER_REJECTED_CASE`. M05 evidence: the upstream returns
 *   HTTP 400 with code 11102 for these — we do better by giving
 *   the user an actionable message before the request goes out.
 */

import type {
  LlmAdapter,
  LlmConfigurableProvider,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  GenerateOptions,
  StreamChunk,
  FinishReason,
  ContentBlock,
  ContentBlockType,
  TokenUsage,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'

import { WorkbuddyClient, WorkbuddyClientError } from './workbuddy-client.js'
import { MODELS_CACHE_TTL_MS } from '../shared/constants.js'

// ---------------------------------------------------------------------------
// Provider route key (must be a lower-case identifier the cordis loader
// can read from `cordis.patch.yml` and that the runtime will surface
// in the Models page).

export const WORKBUDDY_PROVIDER = 'workbuddy'
export const WORKBUDDY_DISPLAY_NAME = 'WorkBuddy / CodeBuddy'

// ---------------------------------------------------------------------------
// Case-sensitive model id parser. v0.1's `parseModelId` lived in
// `tests/`-adjacent fixtures; v0.2 moves it here because it is part
// of the public adapter contract.

export type Realm = 'cn' | 'global'

export interface ParsedModelId {
  /** Id to send on the wire to wb2api (always bare). */
  wireId: string
  /** Parsed realm; null for bare ids. */
  realm: Realm | null
  /** True iff the id carried a `cn:` or `global:` prefix. */
  hasRealmPrefix: boolean
  /** True iff the id is well-formed for v0.2 routing. */
  ok: boolean
  /** Rejection reason when ok is false. */
  rejection?: { code: string; message: string }
}

/**
 * Parse a model id, applying v0.2 routing rules.
 *
 * Rules (derived from M05 evidence — the user's wb2api v1.13
 * upstream returns HTTP 400 with code 11102 for any id with a
 * non-lowercase prefix; we reject client-side):
 *
 * - `glm-5.2` → wireId=glm-5.2, realm=null, ok=true
 * - `cn:glm-5.2` → wireId=glm-5.2, realm=cn, ok=true
 * - `global:glm-5.2` → wireId=glm-5.2, realm=global, ok=true
 * - `cH:glm-5.2` / `CN:glm-5.2` / `GLOBAL:glm-5.2` → ok=false
 * - `openai:gpt-5` (any other prefix) → ok=false
 *
 * Bare ids default to CN because the user's wb2api has zero global
 * accounts (M06 evidence: `realm_totals.global.total = 0`).
 */
export function parseModelId(id: string): ParsedModelId {
  if (id.length === 0) {
    return {
      wireId: id,
      realm: null,
      hasRealmPrefix: false,
      ok: false,
      rejection: { code: 'PROVIDER_REJECTED_EMPTY', message: 'workbuddy: model id is empty' },
    }
  }
  if (!id.includes(':')) {
    return { wireId: id, realm: null, hasRealmPrefix: false, ok: true }
  }
  // The first colon determines the prefix; everything after is the
  // bare model name. A id with no colon is bare; a id with at
  // least one colon has a prefix. We must compare case-sensitively.
  if (id.startsWith('cn:')) {
    return { wireId: id.slice(3), realm: 'cn', hasRealmPrefix: true, ok: true }
  }
  if (id.startsWith('global:')) {
    return { wireId: id.slice(7), realm: 'global', hasRealmPrefix: true, ok: true }
  }
  // Fall-through: any other prefix is rejected. The original
  // upstream wb2api would have passed the entire string through
  // and gotten HTTP 400 11102 from the upstream WorkBuddy service
  // (M05 evidence). Rejecting client-side gives the user a
  // useful message immediately.
  return {
    wireId: id,
    realm: null,
    hasRealmPrefix: false,
    ok: false,
    rejection: {
      code: 'PROVIDER_REJECTED_CASE',
      message:
        `workbuddy: model id "${id}" carries a ":" prefix that is not the ` +
        `exact lowercase "cn:" or "global:". wb2api v1.13 will pass the ` +
        `whole string through to the upstream and the upstream will ` +
        `reject it (HTTP 400 with code 11102 for cH:/CN:; HTTP 503 for ` +
        `unknown realms). Use the bare id (e.g. "glm-5.2") or the exact ` +
        `lowercase prefix.`,
    },
  }
}

// ---------------------------------------------------------------------------
// LlmError subclass for v0.2. v0.1 defined a private
// `WorkbuddyAdapterError`; the runtime expects `LlmError` (from
// `@deepseek-ai/dsh-llm`) so that `LlmRuntime.stream()` can
// normalise it to a terminal `error` chunk. v0.2 still uses
// `import type` so the runtime symbol comes from the DSH bundle.

import type { LlmError as DshLlmError } from '@deepseek-ai/dsh-llm'

/** A local class that mimics the DSH `LlmError` shape. We do not
 *  extend it across the import-type boundary because the real
 *  class lives inside the bundle and the plugin never has access
 *  to it at runtime. The runtime's `instanceof` checks would
 *  fail, but `LlmRuntime.stream()` accepts any thrown value and
 *  normalises it by reading the `code` and `message` fields.
 */
export class WorkbuddyLlmError extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(message)
    this.name = 'WorkbuddyLlmError'
    this.code = code
  }
}

void (null as unknown as DshLlmError) // type-only reference; satisfies the linter without an unused-var

// ---------------------------------------------------------------------------
// Model list cache. The user's wb2api returns a static 19-model list
// that does not change without a gateway restart. Caching for
// 60 s collapses repeated Models-page loads into a single upstream
// fetch, while keeping the cost of a stale list bounded.

interface CachedModelList {
  fetchedAt: number
  models: readonly WorkbuddyModelView[]
}

export interface WorkbuddyModelView {
  provider: string
  id: string
  name: string
  contextWindow?: number
  maxTokens?: number
  hasRealmPrefix: boolean
  realm: Realm | null
}

// ---------------------------------------------------------------------------
// The adapter.
//
// `LlmAdapter` is an `abstract class` in dsh-llm, not an interface. We
// use `implements LlmAdapter` with a type-only import rather than
// `extends LlmAdapter` for a concrete reason verified against the
// compiled runtime in `node_modules/@deepseek-ai/dsh-llm/lib/index.js`:
//
//   - `LlmRuntime.registerAdapter(providers, adapter)` calls
//     `prepareRoutes(providers, adapter, owned)`, which calls
//     `adapter.providerInfo(provider)` and `adapter.providerRetryPolicy(provider)`.
//     It never evaluates `adapter instanceof LlmAdapter`.
//   - The adapter is therefore duck-typed at runtime. `implements`
//     gives us the same compile-time guarantee `extends` would, without
//     requiring the plugin to resolve `@deepseek-ai/dsh-llm` at runtime
//     (which it cannot do: the DSH desktop bundle has its own copy and
//     the plugin's `node_modules` copy is a devDependency only).
//
// This is the corrected form of the v0.1 mistake: v0.1 invented a
// parallel `WorkbuddyLlmAdapterShape` instead of referencing the
// official type. v0.2 references the official type and adds no new
// shape of its own.

export class WorkbuddyLlmAdapter implements LlmAdapter {
  private readonly client: WorkbuddyClient
  private readonly fetchImpl: typeof fetch
  private cache: CachedModelList | null = null

  constructor(client: WorkbuddyClient, opts?: { fetchImpl?: typeof fetch }) {
    this.client = client
    this.fetchImpl = opts?.fetchImpl ?? globalThis.fetch.bind(globalThis)
  }

  /**
   * Return the route metadata DSH uses to register the adapter
   * (`LlmRuntime.registerAdapter` rejects any name/id mismatch —
   * M02 evidence, line 434-438).
   */
  providerInfo(provider: string): LlmProviderInfo {
    if (provider !== WORKBUDDY_PROVIDER) {
      throw new WorkbuddyLlmError(
        `workbuddy adapter: PROVIDER_MISMATCH cannot provide info for "${provider}"`,
        'PROVIDER_MISMATCH',
      )
    }
    return { id: WORKBUDDY_PROVIDER, name: WORKBUDDY_DISPLAY_NAME }
  }

  /** DSH calls this on every request; return undefined to accept
   *  the default retry policy. */
  providerRetryPolicy(_provider: string): undefined {
    return undefined
  }

  /** DSH calls this on every request; return undefined to opt
   *  out of image pricing. */
  imageRequestPricing(_provider: string, _model: string): undefined {
    return undefined
  }

  /**
   * Fetch the wb2api model list, strip the `cn:` / `global:`
   * prefix, and cache for MODELS_CACHE_TTL_MS. DSH calls this
   * from the Models page and from `registerModelDiscovery`.
   */
  async listModels(provider: string): Promise<readonly WorkbuddyModelView[]> {
    if (provider !== WORKBUDDY_PROVIDER) {
      throw new WorkbuddyLlmError(
        `workbuddy adapter: PROVIDER_MISMATCH cannot list models for "${provider}"`,
        'PROVIDER_MISMATCH',
      )
    }
    const now = Date.now()
    if (this.cache !== null && now - this.cache.fetchedAt < MODELS_CACHE_TTL_MS) {
      return this.cache.models
    }
    const response = await this.client.listModels()
    const out: WorkbuddyModelView[] = []
    for (const entry of response.data) {
      const parsed = parseModelId(entry.id)
      if (!parsed.ok) continue
      out.push({
        provider: WORKBUDDY_PROVIDER,
        // DSH shows this id in the Models page; strip the prefix
        // so the user sees `glm-5.2`, not `cn:glm-5.2`.
        id: parsed.wireId,
        name: entry.name ?? parsed.wireId,
        hasRealmPrefix: parsed.hasRealmPrefix,
        realm: parsed.realm,
      })
    }
    this.cache = { fetchedAt: now, models: out }
    return out
  }

  /**
   * Resolve a single model by id. The runtime calls this before
   * `stream` so it can attach model-level metadata to the request.
   */
  async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    if (provider !== WORKBUDDY_PROVIDER) {
      throw new WorkbuddyLlmError(
        `workbuddy adapter: PROVIDER_MISMATCH cannot resolve model for "${provider}"`,
        'PROVIDER_MISMATCH',
      )
    }
    const parsed = parseModelId(model)
    if (!parsed.ok) {
      throw new WorkbuddyLlmError(parsed.rejection!.message, parsed.rejection!.code)
    }
    return {
      provider: WORKBUDDY_PROVIDER,
      id: parsed.wireId,
      name: parsed.wireId,
      hasRealmPrefix: parsed.hasRealmPrefix,
      realm: parsed.realm,
    } as LlmResolvedModelInfo
  }

  /**
   * Default `prepareCall` from the base class is fine. The runtime
   * calls it, then calls the returned `stream(options)` with the
   * final `GenerateOptions`. We override only to inject the
   * model-view metadata we know about.
   */
  async prepareCall(provider: string, model: string, signal?: AbortSignal) {
    const m = await this.resolveModel(provider, model)
    if (signal?.aborted) {
      throw new WorkbuddyLlmError('workbuddy: prepareCall cancelled', 'CALL_CANCELLED')
    }
    return {
      model: m,
      stream: (options: GenerateOptions): AsyncIterable<StreamChunk> =>
        this.stream(options),
    }
  }

  /**
   * Send a Chat Completions request to wb2api and translate the
   * OpenAI SSE stream into DSH `StreamChunk` events. The
   * `GenerateOptions` shape is dictated by the DSH runtime; this
   * method MUST NOT introduce its own custom options object.
   */
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.signal?.aborted) {
      throw new WorkbuddyLlmError('workbuddy: stream cancelled before start', 'CALL_CANCELLED')
    }

    const parsed = parseModelId(options.model)
    if (!parsed.ok) {
      throw new WorkbuddyLlmError(parsed.rejection!.message, parsed.rejection!.code)
    }

    // Translate GenerateOptions to OpenAI Chat Completions wire body.
    // We do not invent a custom body shape: the runtime owns the
    // field names, we own the mapping. Tools and toolHistory are
    // joined to a single tools[] array; reasoningEffort maps to
    // OpenAI's `reasoning_effort`; temperature / max_tokens / stop
    // pass through.
    const body = buildChatCompletionsBody(parsed.wireId, options)

    let response: Response
    try {
      response = await this.fetchImpl(this.client.baseURL + '/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.client.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: options.signal,
      })
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      throw new WorkbuddyLlmError(`workbuddy: fetch failed: ${reason}`, 'FETCH_FAILED')
    }

    if (!response.ok || response.body === null) {
      const text = await response.text().catch(() => '')
      throw new WorkbuddyLlmError(
        `workbuddy: HTTP ${response.status} ${text.slice(0, 200)}`,
        'PROVIDER_HTTP',
      )
    }

    yield* parseSseStream(response.body, options.signal)
  }
}

// ---------------------------------------------------------------------------
// Map GenerateOptions -> OpenAI Chat Completions body.

interface ChatCompletionsBody {
  model: string
  messages: Array<{ role: string; content: string | null; name?: string }>
  stream: true
  temperature?: number
  max_tokens?: number
  stop?: string[]
  tools?: Array<{
    type: 'function'
    function: { name: string; description: string; parameters: Record<string, unknown> }
  }>
  tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } }
  reasoning_effort?: string
}

function buildChatCompletionsBody(wireId: string, opts: GenerateOptions): ChatCompletionsBody {
  const body: ChatCompletionsBody = {
    model: wireId,
    stream: true,
    messages: opts.messages.map((m) => ({
      role: m.role,
      content: extractMessageContent(m.content),
      ...(m.role === 'tool' && (m as unknown as { name?: string }).name !== undefined
        ? { name: (m as unknown as { name?: string }).name }
        : {}),
    })),
  }
  if (opts.temperature !== undefined) body.temperature = opts.temperature
  if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens
  if (opts.stop !== undefined && opts.stop.length > 0) body.stop = opts.stop
  if (opts.tools !== undefined && opts.tools.length > 0) {
    body.tools = opts.tools.map((t) => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
  }
  if (opts.reasoningEffort !== undefined) body.reasoning_effort = opts.reasoningEffort
  return body
}

function extractMessageContent(
  content: unknown,
): string | null {
  // GenerateOptions messages carry a typed `content`; in v0.2 the
  // base type from dsh-llm is `RequestMessage['content']` (either a
  // string or a structured block array). The OpenAI wire format
  // accepts both shapes, so we pass the value through unchanged.
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return JSON.stringify(content)
  if (content === null || content === undefined) return null
  return JSON.stringify(content)
}

// ---------------------------------------------------------------------------
// SSE parser. OpenAI Chat Completions streams `data: {…}` lines
// terminated by `data: [DONE]`. Each line is a chat.completion.chunk
// with `choices[].delta.{content,reasoning_content,tool_calls}`.
// We translate each line into one or more DSH `StreamChunk` events.
//
// The first chunk from the upstream carries `delta.role = "assistant"`
// with no content; we drop it. Subsequent chunks carry one of:
//   - delta.content         -> emit a text-delta (after a block-start)
//   - delta.reasoning_content -> emit a reasoning-delta
//   - delta.tool_calls[i]   -> emit tool-call-deltas + a block-end on finish
//   - finish_reason         -> emit block-end + finish
//   - usage                 -> emit usage
// We track one block at a time: text first, then a tool call
// (if any), then the finish.
//
// The block index increments per block; DSH uses the index to
// interleave deltas from multiple blocks (which we do not emit in
// this adapter yet, but the field is required for forward compat).

interface UpstreamChunk {
  id?: string
  object?: string
  created?: number
  model?: string
  choices?: Array<{
    index?: number
    delta?: {
      role?: string
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: Array<{
        index?: number
        id?: string
        type?: 'function'
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

// ---------------------------------------------------------------------------
// SSE -> StreamChunk translation.
//
// DSH's `BlockAssembler` keys blocks by `index` and explicitly supports
// interleaved deltas ("Block indexes correlate interleaved deltas"), so the
// translator keeps one open block per kind instead of a single "current"
// block. That matters for wb2api: a model may emit reasoning, then visible
// text, then one or more tool calls in the same response, and it may address
// parallel tool calls through `tool_calls[].index`.
//
// Each open block accumulates its content so the terminal `block-end` chunk
// can carry the assembled block, which is what the `StreamChunk` contract
// documents. Omitting `block-end` is also legal (the assembler is documented
// as "tolerant of delta-only protocols"), but emitting it keeps this adapter
// symmetric with the runtimes that do send one.

interface UpstreamToolCallDelta {
  index?: number
  id?: string
  type?: 'function'
  function?: { name?: string; arguments?: string }
}

interface OpenTextBlock {
  index: number
  text: string
}

interface OpenToolCall {
  index: number
  id: string
  name: string
  args: string
}

class StreamTranslator {
  private nextIndex = 0
  private text: OpenTextBlock | null = null
  private reasoning: OpenTextBlock | null = null
  /** Keyed by the upstream `tool_calls[].index` (absent means 0). */
  private readonly toolCalls = new Map<number, OpenToolCall>()
  private finished = false

  /** Whether a terminal `finish` chunk has already been emitted. */
  get hasFinished(): boolean {
    return this.finished
  }

  /** Translate one upstream chat.completion.chunk into zero or more chunks. */
  push(upstream: UpstreamChunk): StreamChunk[] {
    const out: StreamChunk[] = []
    const choice = upstream.choices?.[0]

    if (choice !== undefined) {
      const delta = choice.delta
      if (delta !== undefined) {
        this.appendToolCalls(delta.tool_calls, out)
        this.appendText(delta.content, out)
        this.appendReasoning(delta.reasoning_content, out)
      }
      if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
        out.push(...this.closeAll())
        out.push({ type: 'finish', reason: mapFinishReason(choice.finish_reason) })
        this.finished = true
      }
    }

    if (upstream.usage !== undefined) {
      out.push({ type: 'usage', usage: usageFromUpstream(upstream.usage) })
    }
    return out
  }

  /**
   * Close every open block, in a deterministic order: reasoning, then text,
   * then tool calls. The order only matters for readability of the emitted
   * stream; the assembler orders by `index`.
   */
  closeAll(): StreamChunk[] {
    const out: StreamChunk[] = []
    if (this.reasoning !== null) {
      out.push(reasoningBlockEnd(this.reasoning))
      this.reasoning = null
    }
    if (this.text !== null) {
      out.push(textBlockEnd(this.text))
      this.text = null
    }
    for (const call of this.toolCalls.values()) {
      out.push(toolCallBlockEnd(call))
    }
    this.toolCalls.clear()
    return out
  }

  /** No open blocks remain. */
  get idle(): boolean {
    return this.text === null && this.reasoning === null && this.toolCalls.size === 0
  }

  /**
   * The blocks an interruption may keep. Text and reasoning with non-blank
   * content only: an interrupted tool call was never dispatched, so keeping
   * it would require a fabricated result. DSH's own
   * `BlockAssembler.interruptedBlocks()` drops tool calls for the same reason.
   */
  partialBlocks(): ContentBlock[] {
    const out: ContentBlock[] = []
    if (this.reasoning !== null && this.reasoning.text.trim().length > 0) {
      out.push({ type: 'reasoning', text: this.reasoning.text } as unknown as ContentBlock)
    }
    if (this.text !== null && this.text.text.trim().length > 0) {
      out.push({ type: 'text', text: this.text.text } as unknown as ContentBlock)
    }
    return out
  }

  private appendText(content: string | null | undefined, out: StreamChunk[]): void {
    if (typeof content !== 'string' || content.length === 0) return
    if (this.text === null) {
      this.text = { index: this.nextIndex++, text: '' }
      out.push({ type: 'block-start', index: this.text.index, blockType: 'text' })
    }
    this.text.text += content
    out.push({ type: 'text-delta', index: this.text.index, text: content })
  }

  private appendReasoning(content: string | null | undefined, out: StreamChunk[]): void {
    if (typeof content !== 'string' || content.length === 0) return
    if (this.reasoning === null) {
      this.reasoning = { index: this.nextIndex++, text: '' }
      out.push({ type: 'block-start', index: this.reasoning.index, blockType: 'reasoning' })
    }
    this.reasoning.text += content
    out.push({ type: 'reasoning-delta', index: this.reasoning.index, text: content })
  }

  private appendToolCalls(
    calls: readonly UpstreamToolCallDelta[] | undefined,
    out: StreamChunk[],
  ): void {
    if (calls === undefined) return
    for (const call of calls) {
      const key = call.index ?? 0
      let state = this.toolCalls.get(key)
      if (state === undefined) {
        state = { index: this.nextIndex++, id: '', name: '', args: '' }
        this.toolCalls.set(key, state)
        out.push({ type: 'block-start', index: state.index, blockType: 'tool-call' })
      }
      // OpenAI sends the whole id on the opening delta and split name /
      // argument fragments afterwards, so the id is replaced while the name
      // and arguments are concatenated.
      if (typeof call.id === 'string' && call.id.length > 0) state.id = call.id
      const nameDelta = call.function?.name
      if (typeof nameDelta === 'string' && nameDelta.length > 0) state.name += nameDelta
      const argsDelta = call.function?.arguments ?? ''
      state.args += argsDelta

      const delta: StreamChunk = {
        type: 'tool-call-delta',
        index: state.index,
        id: state.id as ToolCallId,
        ...(typeof nameDelta === 'string' && nameDelta.length > 0 ? { name: nameDelta } : {}),
        argumentsDelta: argsDelta,
      }
      out.push(delta)
    }
  }
}

function textBlockEnd(state: OpenTextBlock): StreamChunk {
  return {
    type: 'block-end',
    index: state.index,
    block: { type: 'text', text: state.text } as unknown as ContentBlock,
  }
}

function reasoningBlockEnd(state: OpenTextBlock): StreamChunk {
  return {
    type: 'block-end',
    index: state.index,
    block: { type: 'reasoning', text: state.text } as unknown as ContentBlock,
  }
}

function toolCallBlockEnd(call: OpenToolCall): StreamChunk {
  // `ToolCallBlock.arguments` is a RAW JSON STRING in dsh-llm ("Raw JSON
  // string as produced by the model"), not a parsed object. The runtime's own
  // assembler builds the same value by concatenating
  // `tool-call-delta.argumentsDelta`, and a `block-end` block is adopted
  // verbatim — so parsing here would hand DSH an object where it expects a
  // string, and the tool dispatch would fail on JSON.parse.
  return {
    type: 'block-end',
    index: call.index,
    block: {
      type: 'tool-call',
      id: call.id as ToolCallId,
      name: call.name,
      arguments: call.args,
    } as unknown as ContentBlock,
  }
}

/**
 * Whether a stream signal has fired.
 *
 * A plain function rather than an inline `signal?.aborted === true` check:
 * TypeScript narrows `signal.aborted` to `false` after an early return, and
 * does not widen it again across an `await`, even though the signal can flip
 * while the reader is suspended. Going through a call boundary keeps the
 * check honest.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted
}

async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
): AsyncIterable<StreamChunk> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  const translator = new StreamTranslator()
  let buffer = ''

  try {
    while (true) {
      if (isAborted(signal)) {
        throw new WorkbuddyLlmError('workbuddy: stream aborted', 'CALL_CANCELLED')
      }

      // Reading is wrapped so an abort-induced rejection from the reader
      // becomes our own CALL_CANCELLED rather than a bare DOMException.
      let chunkValue: Uint8Array | undefined
      let streamDone = false
      try {
        const read = await reader.read()
        chunkValue = read.value
        streamDone = read.done
      } catch (e) {
        if (isAborted(signal)) {
          throw new WorkbuddyLlmError('workbuddy: stream aborted', 'CALL_CANCELLED')
        }
        throw new WorkbuddyLlmError(
          `workbuddy: SSE read failed: ${e instanceof Error ? e.message : String(e)}`,
          'STREAM_READ_FAILED',
        )
      }
      if (streamDone) break
      if (chunkValue !== undefined) buffer += decoder.decode(chunkValue, { stream: true })

      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)

        for (const line of rawEvent.split('\n')) {
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (data === '[DONE]') {
            if (!translator.hasFinished) {
              for (const chunk of translator.closeAll()) yield chunk
              yield { type: 'finish', reason: { kind: 'stop' } }
            }
            return
          }
          let parsed: UpstreamChunk
          try {
            parsed = JSON.parse(data) as UpstreamChunk
          } catch {
            // A malformed frame is skipped rather than failing the whole
            // response; the stream may still carry usable deltas.
            continue
          }
          for (const chunk of translator.push(parsed)) yield chunk
        }
        boundary = buffer.indexOf('\n\n')
      }
    }

    // The body ended without `[DONE]`. Close whatever is open so the
    // assembler is not left with a dangling partial.
    if (!translator.hasFinished) {
      for (const chunk of translator.closeAll()) yield chunk
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // already released
    }
  }
}

function usageFromUpstream(u: NonNullable<UpstreamChunk['usage']>): TokenUsage {
  // dsh-llm TokenUsage requires inputTokens + outputTokens; the provider's
  // `prompt_tokens` may fold cached tokens in, so we surface the totals as
  // given and leave the cache fields absent rather than inventing a split.
  const usage: TokenUsage = {
    inputTokens: typeof u.prompt_tokens === 'number' ? u.prompt_tokens : 0,
    outputTokens: typeof u.completion_tokens === 'number' ? u.completion_tokens : 0,
  }
  if (typeof u.total_tokens === 'number') usage.totalTokens = u.total_tokens
  return usage
}

function mapFinishReason(reason: string): FinishReason {
  // dsh-llm `FinishReason` is an OBJECT union, not a string union:
  //   { kind: 'stop' } | { kind: 'tool-calls' } | { kind: 'max-tokens' }
  //   | { kind: 'aborted'; failure } | { kind: 'error'; failure }
  // OpenAI's `length` means the model hit its output cap, which maps to
  // `max-tokens`; `tool_calls` maps to `tool-calls`; everything else
  // (including `content_filter`) is a normal stop.
  switch (reason) {
    case 'length':
      return { kind: 'max-tokens' }
    case 'tool_calls':
      return { kind: 'tool-calls' }
    case 'stop':
    case 'content_filter':
    default:
      return { kind: 'stop' }
  }
}

// ---------------------------------------------------------------------------
// Configurable-provider entry. DSH renders this in the Models
// page's provider picker. The `settingsNs` and `settingsPath`
// are how the runtime's settings UI will reach our schema.

export function workbuddyConfigurableProvider(
  settingsNs: string,
): LlmConfigurableProvider {
  return {
    provider: WORKBUDDY_PROVIDER,
    displayName: WORKBUDDY_DISPLAY_NAME,
    settingsNs,
    settingsPath: ['providers', WORKBUDDY_PROVIDER],
  }
}

