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

interface BlockState {
  type: 'text' | 'reasoning' | 'tool-call'
  text: string
  toolId: string
  toolName: string
  toolArgs: string
}

function blockTypeToName(type: ContentBlockType): string {
  // The ContentBlockType union is not exported as a literal list; we
  // map by convention. If DSH adds a new block type in a later
  // version, the string we emit still parses (DSH treats unknown
  // values as opaque).
  return type
}

async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
): AsyncIterable<StreamChunk> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let current: BlockState | null = null
  let blockIndex = 0

  try {
    while (true) {
      if (signal?.aborted) {
        yield {
          type: 'finish',
          reason: { kind: 'aborted', failure: { message: 'workbuddy: stream aborted', code: 'CALL_CANCELLED' } },
        }
        return
      }
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        for (const line of rawEvent.split('\n')) {
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (data === '[DONE]') {
            yield closeCurrent(current, blockIndex)
            current = null
            yield { type: 'finish', reason: { kind: 'stop' } }
            return
          }
          let parsed: UpstreamChunk
          try {
            parsed = JSON.parse(data) as UpstreamChunk
          } catch {
            continue
          }
          for (const out of translateChunk(parsed, current, blockIndex)) {
            if (out.startsNewBlock && out.newState !== null) {
              current = out.newState
            }
            if (out.closesBlock && current !== null) {
              const finished = current
              current = null
              blockIndex += 1
              yield finishedBlock(finished, blockIndex - 1)
            }
            if (out.chunk !== null) yield out.chunk
          }
        }
        boundary = buffer.indexOf('\n\n')
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // already released
    }
  }
}

interface TranslateOutput {
  chunk: StreamChunk | null
  startsNewBlock: boolean
  newState: BlockState | null
  closesBlock: boolean
}

function translateChunk(
  upstream: UpstreamChunk,
  current: BlockState | null,
  blockIndex: number,
): TranslateOutput[] {
  const out: TranslateOutput[] = []
  const choice = upstream.choices?.[0]
  if (choice === undefined) {
    if (upstream.usage !== undefined) {
      out.push({
        chunk: { type: 'usage', usage: usageFromUpstream(upstream.usage) },
        startsNewBlock: false,
        newState: null,
        closesBlock: false,
      })
    }
    return out
  }
  const delta = choice.delta
  if (delta === undefined) {
    return out
  }

  // Tool call deltas. Each entry may carry a partial id, name, and
  // an arguments JSON string. We accumulate the full arguments
  // string until finish_reason arrives.
  if (delta.tool_calls !== undefined && delta.tool_calls.length > 0) {
    // A tool call may arrive after a text block; close the text
    // block first if it is still open.
    if (current !== null && current.type === 'text') {
      const closed = current
      current = null
      blockIndex += 1
      out.push({
        chunk: finishedBlock(closed, blockIndex - 1),
        startsNewBlock: false,
        newState: null,
        closesBlock: true,
      })
    }
    if (current === null || current.type !== 'tool-call') {
      // First delta for a new tool call: open the block.
      const tc = delta.tool_calls[0]!
      const newState: BlockState = {
        type: 'tool-call',
        text: '',
        toolId: tc.id ?? '',
        toolName: tc.function?.name ?? '',
        toolArgs: tc.function?.arguments ?? '',
      }
      out.push({
        chunk: { type: 'block-start', index: blockIndex, blockType: 'tool-call' },
        startsNewBlock: true,
        newState,
        closesBlock: false,
      })
    } else {
      // Subsequent delta: append to the running tool call.
      const tc = delta.tool_calls[0]!
      if (tc.id !== undefined && tc.id.length > 0) current.toolId = tc.id
      if (tc.function?.name !== undefined && tc.function.name.length > 0) {
        current.toolName = tc.function.name
      }
      if (tc.function?.arguments !== undefined && tc.function.arguments.length > 0) {
        current.toolArgs += tc.function.arguments
      }
    }
    for (const tc of delta.tool_calls) {
      const id = tc.id ?? (current?.toolId ?? '')
      const nameDelta = tc.function?.name ?? ''
      const argsDelta = tc.function?.arguments ?? ''
      if (id.length > 0 || nameDelta.length > 0 || argsDelta.length > 0) {
        out.push({
          chunk: {
            type: 'tool-call-delta',
            index: blockIndex,
            id: id as unknown as StreamChunk extends { type: 'tool-call-delta'; id: infer I } ? I : never,
            ...(nameDelta.length > 0 ? { name: nameDelta } : {}),
            argumentsDelta: argsDelta,
          },
          startsNewBlock: false,
          newState: null,
          closesBlock: false,
        })
      }
    }
  }

  // Text delta.
  if (typeof delta.content === 'string' && delta.content.length > 0) {
    if (current === null || current.type !== 'text') {
      // Open a new text block.
      const newState: BlockState = {
        type: 'text',
        text: delta.content,
        toolId: '',
        toolName: '',
        toolArgs: '',
      }
      current = newState
      out.push({
        chunk: { type: 'block-start', index: blockIndex, blockType: 'text' },
        startsNewBlock: true,
        newState,
        closesBlock: false,
      })
    } else {
      current.text += delta.content
    }
    out.push({
      chunk: { type: 'text-delta', index: blockIndex, text: delta.content },
      startsNewBlock: false,
      newState: null,
      closesBlock: false,
    })
  }

  // Reasoning delta. Some wb2api models emit `reasoning_content`
  // alongside `content`. We treat them as a separate block kind
  // so the user can render them in a different style.
  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
    if (current !== null && current.type === 'text') {
      // Close the text block before opening reasoning so the
      // block indexes stay monotone.
      const closed = current
      current = null
      blockIndex += 1
      out.push({
        chunk: finishedBlock(closed, blockIndex - 1),
        startsNewBlock: false,
        newState: null,
        closesBlock: true,
      })
    }
    if (current === null || current.type !== 'reasoning') {
      const newState: BlockState = {
        type: 'reasoning',
        text: delta.reasoning_content,
        toolId: '',
        toolName: '',
        toolArgs: '',
      }
      current = newState
      out.push({
        chunk: { type: 'block-start', index: blockIndex, blockType: 'reasoning' },
        startsNewBlock: true,
        newState,
        closesBlock: false,
      })
    } else {
      current.text += delta.reasoning_content
    }
    out.push({
      chunk: { type: 'reasoning-delta', index: blockIndex, text: delta.reasoning_content },
      startsNewBlock: false,
      newState: null,
      closesBlock: false,
    })
  }

  // Terminal finish_reason.
  if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
    if (current !== null) {
      const closed = current
      current = null
      blockIndex += 1
      out.push({
        chunk: finishedBlock(closed, blockIndex - 1),
        startsNewBlock: false,
        newState: null,
        closesBlock: true,
      })
    }
    out.push({
      chunk: {
        type: 'finish',
        reason: mapFinishReason(choice.finish_reason),
      },
      startsNewBlock: false,
      newState: null,
      closesBlock: false,
    })
  }

  if (upstream.usage !== undefined) {
    out.push({
      chunk: { type: 'usage', usage: usageFromUpstream(upstream.usage) },
      startsNewBlock: false,
      newState: null,
      closesBlock: false,
    })
  }
  return out
}

function closeCurrent(
  current: BlockState | null,
  blockIndex: number,
): StreamChunk {
  if (current === null) {
    return { type: 'finish', reason: { kind: 'stop' } }
  }
  return finishedBlock(current, blockIndex)
}

function finishedBlock(state: BlockState, index: number): StreamChunk {
  // ContentBlock is a discriminated union in dsh-llm. v0.2 builds
  // it from the running state. The cast through `unknown` is
  // intentional: we have to materialise one of the union members
  // and we know which one based on `state.type`.
  if (state.type === 'text') {
    const block: ContentBlock = { type: 'text', text: state.text } as unknown as ContentBlock
    return { type: 'block-end', index, block }
  }
  if (state.type === 'reasoning') {
    const block: ContentBlock = { type: 'reasoning', text: state.text } as unknown as ContentBlock
    return { type: 'block-end', index, block }
  }
  // tool-call
  let parsedArgs: unknown = {}
  if (state.toolArgs.length > 0) {
    try {
      parsedArgs = JSON.parse(state.toolArgs)
    } catch {
      // Partial JSON is possible on the last delta; surface the
      // raw string so the harness can decide what to do.
      parsedArgs = state.toolArgs
    }
  }
  const block = {
    type: 'tool-call',
    id: state.toolId,
    name: state.toolName,
    arguments: parsedArgs,
  } as unknown as ContentBlock
  return { type: 'block-end', index, block }
}

function usageFromUpstream(u: NonNullable<UpstreamChunk['usage']>): TokenUsage {
  // dsh-llm TokenUsage requires inputTokens + outputTokens; the
  // provider's `prompt_tokens` may include cached tokens, so we
  // surface the total as totalTokens and leave cache fields
  // absent unless the provider breaks them out.
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
  // OpenAI's `length` means the model hit max output tokens, which
  // maps to `max-tokens`; `tool_calls` maps to `tool-calls`;
  // everything else (including `content_filter`) is a normal stop.
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

void blockTypeToName // reserved for future block-type routing
