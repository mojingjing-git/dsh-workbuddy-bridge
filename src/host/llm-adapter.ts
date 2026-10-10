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
 * - `global:glm-5.2` → **ok=false, rejected**
 * - `cH:glm-5.2` / `CN:glm-5.2` / `GLOBAL:glm-5.2` → ok=false
 * - `openai:gpt-5` (any other prefix) → ok=false
 *
 * Bare ids default to CN because the user's wb2api has zero global
 * accounts (M06 evidence: `realm_totals.global.total = 0`).
 *
 * ## Why `global:` is rejected rather than stripped
 *
 * An earlier revision accepted `global:glm-5.2` and returned
 * `wireId=glm-5.2`. That is worse than rejecting it: wb2api routes a bare id
 * to CN, so a user who explicitly asked for the global realm would silently
 * get CN — the request succeeds and the answer comes from the wrong realm.
 * A model that cannot be served must fail loudly.
 *
 * v0.2 has no realm routing at all (the adapter sends no realm signal; wb2api
 * decides from the id). Until it does, `global:` is refused at every entry
 * point: here, in `listModels`, and in `resolveModel`.
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
  // Rejected, not stripped. `wireId` is left as the caller wrote it so a
  // log or error message shows what was actually asked for.
  if (id.startsWith('global:')) {
    return {
      wireId: id,
      realm: 'global',
      hasRealmPrefix: true,
      ok: false,
      rejection: {
        code: 'PROVIDER_REJECTED_GLOBAL',
        message:
          `workbuddy: model id "${id}" asks for the global realm, which this ` +
          `plugin does not route yet. This gateway has no global accounts ` +
          `(M06 evidence: realm_totals.global.total = 0), and wb2api routes a ` +
          `bare id to CN - so stripping the prefix would silently answer from ` +
          `the wrong realm. Use the CN id instead, e.g. "cn:${id.slice(7)}".`,
      },
    }
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
      // Entry-point 1 of 3 for the global block. `parseModelId` rejects
      // `global:` so this also covers the upstream ever advertising one; the
      // explicit realm test keeps a model the user cannot call out of the
      // picker even if the parser's rules change later.
      if (!parsed.ok || parsed.realm === 'global') continue
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
    // Entry-point 2 of 3 for the global block: `parseModelId` refuses
    // `global:` outright, so this throws PROVIDER_REJECTED_GLOBAL.
    const parsed = parseModelId(model)
    if (!parsed.ok || parsed.realm === 'global') {
      const rejection = parsed.rejection ?? {
        code: 'PROVIDER_REJECTED_GLOBAL',
        message: `workbuddy: the global realm is not routable in v0.2 (model "${model}")`,
      }
      throw new WorkbuddyLlmError(rejection.message, rejection.code)
    }
    return {
      provider: WORKBUDDY_PROVIDER,
      id: parsed.wireId,
      name: parsed.wireId,
      hasRealmPrefix: parsed.hasRealmPrefix,
      realm: parsed.realm,
      // Load-bearing, not decorative. `LlmRuntime.stream()` projects image
      // blocks into text placeholders only when `inputModalities` is declared
      // and omits `image` ("absent means unknown, while an explicit omission
      // is negative capability"). This adapter serializes text only and cannot
      // resolve an `ImageAttachmentRef` to bytes, so declaring text-only is
      // both honest and what makes the runtime hand it pre-projected content
      // instead of raw image blocks it would have to drop.
      inputModalities: ['text'],
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

    // Entry-point 3 of 3 for the global block. All three are guarded
    // separately on purpose: `listModels` keeps the model out of the picker,
    // `resolveModel` rejects it before the call is prepared, and this one
    // rejects it even if a caller reaches `stream` directly with a
    // hand-built `GenerateOptions` - which the runtime permits.
    const parsed = parseModelId(options.model)
    if (!parsed.ok || parsed.realm === 'global') {
      const rejection = parsed.rejection ?? {
        code: 'PROVIDER_REJECTED_GLOBAL',
        message: `workbuddy: the global realm is not routable in v0.2 (model "${options.model}")`,
      }
      throw new WorkbuddyLlmError(rejection.message, rejection.code)
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
//
// Every DSH message carries `content: readonly ContentBlock[]` - never a
// string. Translating that to the wire is not a pass-through, because the two
// sides disagree on three things:
//
//   - The provider correlates a tool result with its call through
//     `tool_call_id` (on the tool-role message) and `tool_calls` (on the
//     assistant message that requested it). DSH carries the same correlation
//     in `ToolResultMessage.toolCallId` and in `tool-call` content blocks.
//     Drop either and the provider cannot match the result to the call.
//   - `reasoning` blocks are model scratchpad, not conversation. They are
//     returned to no provider.
//   - `tool-addition` / `tool-removal` blocks are session bookkeeping. The
//     runtime's `projectToolUpdates` has already turned them into the `tools`
//     argument, so they are not sent as message content.
//
// Content that the runtime projects before dispatch: file blocks become
// handle text for every route, and image blocks become placeholders for routes
// whose `inputModalities` omits `image`. This adapter declares text-only input
// (see `resolveModel`), so by the time `stream()` runs both are already text.
// The image/file branches below are a defensive fallback for a block that
// survives projection: rendering a neutral placeholder loses less than
// dropping the block silently.

/** OpenAI tool declaration as sent on the wire. */
interface WireTool {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

/** OpenAI tool call on an assistant message. */
interface WireToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/**
 * One message on the wire. `content` is `null` only for an assistant turn that
 * carries tool calls and no text, which is the shape the provider expects.
 */
interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: WireToolCall[]
  tool_call_id?: string
}

interface ChatCompletionsBody {
  model: string
  messages: WireMessage[]
  stream: true
  temperature?: number
  max_tokens?: number
  stop?: string[]
  tools?: WireTool[]
  tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } }
  reasoning_effort?: string
}

/** Separator for consecutive text blocks inside one message. */
const TEXT_BLOCK_JOINER = '\n\n'

/** Placeholder for an image block that reached the adapter unprojected. */
const UNPROJECTED_IMAGE_TEXT = '[image omitted: this route accepts text only]'

/** Placeholder for a file block that reached the adapter unprojected. */
const UNPROJECTED_FILE_TEXT = '[file omitted: this route receives file handles as text]'

function buildChatCompletionsBody(wireId: string, opts: GenerateOptions): ChatCompletionsBody {
  const messages: WireMessage[] = []

  // A one-shot caller's system prompt is mapped to the provider's system slot
  // ahead of the conversation; loop-built requests carry it as the leading
  // system message instead and leave `system` undefined.
  if (opts.system !== undefined && opts.system.length > 0) {
    messages.push({ role: 'system', content: opts.system })
  }

  for (const message of opts.messages) {
    const wire = toWireMessage(message)
    if (wire !== null) messages.push(wire)
  }

  const body: ChatCompletionsBody = { model: wireId, stream: true, messages }
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

/** Convert one DSH message, or `null` when it carries nothing the model sees. */
function toWireMessage(message: GenerateOptions['messages'][number]): WireMessage | null {
  const blocks = message.content

  if (message.role === 'assistant') {
    const text = textOf(blocks)
    const toolCalls = toolCallsOf(blocks)
    if (text.length === 0 && toolCalls.length === 0) return null
    return {
      role: 'assistant',
      // An assistant turn that only requests tools sends `content: null`.
      content: text.length > 0 ? text : null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    }
  }

  if (message.role === 'tool') {
    // `toolCallId` is what lets the provider pair this result with the
    // assistant turn that asked for it. Without it the provider sees an
    // orphan tool message and rejects or ignores the result.
    return {
      role: 'tool',
      tool_call_id: String(message.toolCallId),
      content: textOf(blocks),
    }
  }

  const text = textOf(blocks)
  // `developer` messages carry tool add/remove bookkeeping, which
  // `projectToolUpdates` has already folded into the `tools` argument. Any
  // remaining prose is advice about how to behave, so it travels in the
  // system slot; a developer message with no prose at all is dropped.
  if (message.role === 'developer') {
    return text.length > 0 ? { role: 'system', content: text } : null
  }
  if (message.role === 'system') {
    return { role: 'system', content: text }
  }
  return { role: 'user', content: text }
}

/**
 * Flatten a message's model-visible text.
 *
 * Drops `reasoning` (scratchpad, not conversation), `tool-call` (carried
 * separately as `tool_calls`), and `tool-addition` / `tool-removal`
 * (bookkeeping already folded into the tool declarations).
 */
function textOf(blocks: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        parts.push((block as { text: string }).text)
        break
      case 'image':
        parts.push(UNPROJECTED_IMAGE_TEXT)
        break
      case 'file':
        parts.push(UNPROJECTED_FILE_TEXT)
        break
      default:
        // `reasoning`, `tool-call`, `tool-addition`, `tool-removal`, and any
        // block type a future DSH version adds.
        break
    }
  }
  return parts.filter((p) => p.length > 0).join(TEXT_BLOCK_JOINER)
}

/** The `tool_calls` array for an assistant turn, in block order. */
function toolCallsOf(blocks: readonly ContentBlock[]): WireToolCall[] {
  const calls: WireToolCall[] = []
  for (const block of blocks) {
    if (block.type !== 'tool-call') continue
    const call = block as { id: string; name: string; arguments: string }
    calls.push({
      id: String(call.id),
      type: 'function',
      // Already a raw JSON string, which is what the wire wants.
      function: { name: call.name, arguments: call.arguments },
    })
  }
  return calls
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
  /**
   * Token accounting for the frame.
   *
   * `| null` is load-bearing, not defensive noise. wb2api sends
   * `"usage": null` on **every** frame and fills it only on the last one —
   * captured verbatim from the gateway:
   *
   *     data: {…,"finish_reason":null,…,"usage":null}
   *     …
   *     data: {…,"finish_reason":"stop",…,"usage":{…}}
   *
   * A `!== undefined` test therefore passes for null and the accounting code
   * dereferences null. That is the crash the first real desktop run hit
   * (`Cannot read properties of null (reading 'prompt_tokens')`) — the gateway
   * had answered HTTP 200 and streamed the whole reply.
   */
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    /** Read from the prompt cache. Three spellings across gateways. */
    prompt_cache_hit_tokens?: number
    cache_read_input_tokens?: number
    cached_tokens?: number
    /** Written to the prompt cache. Two spellings. */
    prompt_cache_write_tokens?: number
    cache_creation_input_tokens?: number
    /** Reasoning tokens, billed as output. Two spellings. */
    completion_thinking_tokens?: number
    completion_tokens_details?: { reasoning_tokens?: number } | null
  } | null
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
  /**
   * The reason from the frame that carried `finish_reason`, held back until
   * the stream ends.
   *
   * The contract is "adapters emit usage before the terminal finish and
   * nothing afterward", and OpenAI-shaped streams violate that if the adapter
   * passes the finish through immediately: with `stream_options.include_usage`
   * the usage arrives in a *separate frame after* the one carrying
   * `finish_reason`. Emitting `finish` on sight would put usage after the
   * terminal chunk. Deferring it means the finish is emitted once, last, by
   * `terminalChunks()` - by which point any trailing usage frame has already
   * produced its `usage` chunk.
   */
  private pendingFinish: FinishReason | null = null
  /** Whether `terminalChunks()` has already run. */
  private finished = false

  /** Whether a terminal `finish` chunk has already been emitted. */
  get hasFinished(): boolean {
    return this.finished
  }

  /** Whether the upstream reported a `finish_reason`. */
  get sawFinishReason(): boolean {
    return this.pendingFinish !== null
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
      if (
        choice.finish_reason !== null &&
        choice.finish_reason !== undefined &&
        this.pendingFinish === null
      ) {
        // Close the open blocks now: their `block-end` chunks are not
        // terminal, so they may precede usage without breaking the contract.
        out.push(...this.closeAll())
        this.pendingFinish = mapFinishReason(choice.finish_reason)
      }
    }

    // Before the finish, always - whatever order the frames arrived in. The
    // null test is the load-bearing half: wb2api sends `"usage": null` on every
    // frame but the last, and `!== undefined` alone lets null through to the
    // accounting code, which then dereferences it.
    if (upstream.usage !== undefined && upstream.usage !== null) {
      out.push({ type: 'usage', usage: usageFromUpstream(upstream.usage) })
    }
    return out
  }

  /**
   * The chunks that end the stream: any still-open blocks, then exactly one
   * terminal `finish`. Empty once the terminal chunk has been emitted, so a
   * caller cannot emit two.
   *
   * @param fallback - reason to report when the upstream never sent one,
   *   which is the normal case for `[DONE]` without a `finish_reason` frame.
   */
  terminalChunks(fallback: FinishReason = { kind: 'stop' }): StreamChunk[] {
    if (this.finished) return []
    this.finished = true
    return [...this.closeAll(), { type: 'finish', reason: this.pendingFinish ?? fallback }]
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
      if (chunkValue !== undefined) {
        // Normalize CRLF as the buffer grows. SSE frames may be terminated by
        // `\n\n` or `\r\n\r\n`, and the two are not interchangeable to
        // `indexOf('\n\n')` - a CRLF stream would never split into events and
        // the whole response would arrive as one unsplittable blob. Doing the
        // replace after concatenating (rather than per chunk) also handles a
        // `\r\n` straddling a chunk boundary: the `\r` sits at the tail of one
        // buffer and the `\n` at the head of the next, and the pair is
        // normalized on the following pass.
        buffer = (buffer + decoder.decode(chunkValue, { stream: true })).replace(/\r\n/g, '\n')
      }

      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)

        for (const line of rawEvent.split('\n')) {
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (data === '[DONE]') {
            for (const chunk of translator.terminalChunks()) yield chunk
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

    // The body ended without `[DONE]`. Whether that is a normal end depends
    // on whether the upstream ever reported a `finish_reason`:
    //
    //   - It did. Some deployments close the connection after the final frame
    //     instead of writing `[DONE]`. The turn is complete; finish normally.
    //   - It did not. The connection dropped mid-turn. Reporting `stop` here
    //     would hand the agent a truncated answer that looks complete, so fail
    //     instead and let `LlmRuntime.stream()` normalize it to a terminal
    //     error the loop can act on.
    if (!translator.hasFinished) {
      if (!translator.sawFinishReason) {
        throw new WorkbuddyLlmError(
          'workbuddy: upstream closed the stream before reporting finish_reason ' +
            '(response is truncated, not complete)',
          'STREAM_TRUNCATED',
        )
      }
      for (const chunk of translator.terminalChunks()) yield chunk
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // already released
    }
  }
}

/** First defined number among the candidates, or undefined. */
function firstNumber(...values: Array<number | undefined | null>): number | undefined {
  for (const v of values) {
    if (typeof v === 'number') return v
  }
  return undefined
}

function usageFromUpstream(u: NonNullable<UpstreamChunk['usage']>): TokenUsage {
  // dsh-llm's TokenUsage requires inputTokens and outputTokens; everything else
  // is optional. The gateway's final frame carries far more than the two
  // totals, and dropping the rest under-reports cost: reasoning tokens are
  // billed as output, and cache reads are billed at a different rate than fresh
  // input. Field capture from the live gateway:
  //
  //   prompt_tokens 13, completion_tokens 38, total_tokens 51,
  //   prompt_cache_hit_tokens 0, prompt_cache_miss_tokens 13,
  //   prompt_cache_write_tokens 0, cache_read_input_tokens 0,
  //   cache_creation_input_tokens 0, cached_tokens 0,
  //   completion_thinking_tokens 27,
  //   completion_tokens_details { reasoning_tokens: 27, … }
  //
  // The same quantity arrives under several names because the gateway
  // normalizes more than one upstream dialect. Each lookup prefers the most
  // specific spelling and falls back, rather than picking one and silently
  // reading zero from the others.
  const usage: TokenUsage = {
    inputTokens: firstNumber(u.prompt_tokens) ?? 0,
    outputTokens: firstNumber(u.completion_tokens) ?? 0,
  }

  const total = firstNumber(u.total_tokens)
  if (total !== undefined) usage.totalTokens = total

  const cacheRead = firstNumber(
    u.prompt_cache_hit_tokens,
    u.cache_read_input_tokens,
    u.cached_tokens,
  )
  if (cacheRead !== undefined) usage.cacheReadTokens = cacheRead

  const cacheWrite = firstNumber(u.prompt_cache_write_tokens, u.cache_creation_input_tokens)
  if (cacheWrite !== undefined) usage.cacheWriteTokens = cacheWrite

  const reasoning = firstNumber(
    u.completion_thinking_tokens,
    u.completion_tokens_details?.reasoning_tokens,
  )
  if (reasoning !== undefined) usage.reasoningTokens = reasoning

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

