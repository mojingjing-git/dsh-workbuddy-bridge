/**
 * LLM adapter for the workbuddy provider.
 *
 * Plan reference: V2.2.1 §5 (model list), §6.2 (auth), M02 evidence.
 *
 * The adapter speaks the **OpenAI Chat Completions** wire format (plan §0.3
 * rule 1) and talks to a user-managed wb2api process. It is intentionally
 * duck-typed against `@deepseek-ai/dsh-llm`'s `LlmAdapter` shape rather
 * than extending the class, because:
 *
 * 1. The class is internal to the DSH bundle; importing it forces a peer
 *    dependency on a path that may move between DSH releases.
 * 2. dsh-cost-meter, the most-shipped plugin to date, uses the same
 *    "plain object that satisfies the registry" pattern.
 *
 * The methods implemented are the ones the DSH `LlmRuntime` actually
 * calls (M02 evidence, `registerAdapter` line 389 + the call sites of
 * `providerInfo`, `providerRetryPolicy`, `stream`, `listModels`,
 * `resolveModel`):
 *
 *   - providerInfo(provider)   — required, exact id+name
 *   - providerRetryPolicy()    — optional, return undefined
 *   - imageRequestPricing()    — optional, return undefined
 *   - listModels(provider)     — registry offers this for catalog-driven UI
 *   - resolveModel(provider, model) — required for capability lookup
 *   - prepareCall(provider, model) — optional, default wires stream
 *   - stream(options)          — required, the only one without a default
 */

import { WorkbuddyClient, WorkbuddyClientError } from './workbuddy-client.js'
import { MODELS_CACHE_TTL_MS } from '../shared/constants.js'

/** The provider route name we register. */
export const WORKBUDDY_PROVIDER = 'workbuddy'

/**
 * The minimal subset of `LlmAdapter` the runtime actually needs.
 *
 * Kept structural so the DSH bundle's `LlmAdapter` is the only place that
 * knows the full surface. Plan reference: M02 evidence, line 208-291.
 */
export interface WorkbuddyLlmAdapterShape {
  providerInfo(provider: string): { id: string; name: string }
  providerRetryPolicy(provider: string): unknown
  imageRequestPricing(provider: string, model: string): unknown
  listModels(provider: string): Promise<readonly WorkbuddyModelView[]>
  resolveModel(provider: string, model: string): Promise<WorkbuddyModelView>
  prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
    model: WorkbuddyModelView
    stream: (options: WorkbuddyStreamOptions) => AsyncIterable<WorkbuddyStreamChunk>
  }>
  stream(options: WorkbuddyStreamOptions): AsyncIterable<WorkbuddyStreamChunk>
}

export interface WorkbuddyModelView {
  provider: string
  id: string
  name: string
  contextWindow?: number
  maxTokens?: number
  /** True if the id carries a `cn:` / `global:` prefix; false for bare. */
  hasRealmPrefix: boolean
  /** Parsed realm, if the id carries one. */
  realm: 'cn' | 'global' | null
}

export interface WorkbuddyStreamOptions {
  /** Resolved API key; the runtime hands this in per request. */
  apiKey: string
  /** The bare or prefixed model id the user picked. */
  model: string
  /** The chat history + tools + system + temperature, in OpenAI wire shape. */
  body: unknown
  signal?: AbortSignal
}

export interface WorkbuddyStreamChunk {
  type: 'text' | 'reasoning' | 'usage' | 'finish' | 'error'
  text?: string
  reasoning?: string
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
  finishReason?: string
  error?: { message: string; code?: string; type?: string }
}

/**
 * Parse a model id: returns the realm the wire must address, the bare id
 * to send on the wire, and a flag for the plugin's case-sensitivity guard.
 *
 * M05 evidence: `cH:glm-5.2` is rejected upstream (HTTP 400) and `global:`
 * on a CN-only list is rejected upstream (HTTP 503). The plugin must
 * therefore reject anything that is not a lower-case `cn:` / `global:`
 * prefix or a bare id.
 */
export interface ParsedModelId {
  /** Wire id: bare model name. */
  wireId: string
  /** Realm hint, used by the adapter when calling wb2api. */
  realm: 'cn' | 'global' | null
  /** True iff the id carried a `cn:` / `global:` prefix. */
  hasRealmPrefix: boolean
  /** True iff the id is well-formed for this plugin. */
  ok: boolean
  /** Reason rejected, when ok is false. */
  rejection?: { code: string; message: string }
}

export function parseModelId(id: string): ParsedModelId {
  const lower = id.toLowerCase()
  if (lower.startsWith('cn:') && id.startsWith('cn:')) {
    return { wireId: id.slice(3), realm: 'cn', hasRealmPrefix: true, ok: true }
  }
  if (lower.startsWith('global:') && id.startsWith('global:')) {
    return { wireId: id.slice(7), realm: 'global', hasRealmPrefix: true, ok: true }
  }
  if (id.includes(':')) {
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
  return { wireId: id, realm: null, hasRealmPrefix: false, ok: true }
}

interface CachedModelList {
  fetchedAt: number
  models: WorkbuddyModelView[]
}

export class WorkbuddyLlmAdapter implements WorkbuddyLlmAdapterShape {
  private readonly client: WorkbuddyClient
  private readonly fetchImpl: typeof fetch
  private cache: CachedModelList | null = null

  constructor(client: WorkbuddyClient, opts?: { fetchImpl?: typeof fetch }) {
    this.client = client
    this.fetchImpl = opts?.fetchImpl ?? globalThis.fetch.bind(globalThis)
  }

  providerInfo(provider: string): { id: string; name: string } {
    if (provider !== WORKBUDDY_PROVIDER) {
      throw new WorkbuddyAdapterError(
        `workbuddy adapter: PROVIDER_MISMATCH cannot provide info for "${provider}"`,
        'PROVIDER_MISMATCH',
      )
    }
    return { id: WORKBUDDY_PROVIDER, name: 'WorkBuddy / CodeBuddy' }
  }

  providerRetryPolicy(_provider: string): unknown {
    return undefined
  }

  imageRequestPricing(_provider: string, _model: string): unknown {
    return undefined
  }

  async listModels(provider: string): Promise<readonly WorkbuddyModelView[]> {
    if (provider !== WORKBUDDY_PROVIDER) return []
    const now = Date.now()
    if (this.cache && now - this.cache.fetchedAt < MODELS_CACHE_TTL_MS) {
      return this.cache.models
    }
    const response = await this.client.listModels()
    const models: WorkbuddyModelView[] = []
    for (const entry of response.data) {
      const parsed = parseModelId(entry.id)
      // listModels is informational; the runtime will still ask resolveModel
      // before sending. We expose only OK ids.
      if (!parsed.ok) continue
      models.push({
        provider: WORKBUDDY_PROVIDER,
        id: entry.id,
        name: entry.name ?? entry.id,
        hasRealmPrefix: parsed.hasRealmPrefix,
        realm: parsed.realm,
      })
    }
    this.cache = { fetchedAt: now, models }
    return models
  }

  async resolveModel(provider: string, model: string): Promise<WorkbuddyModelView> {
    if (provider !== WORKBUDDY_PROVIDER) {
      throw new WorkbuddyAdapterError(
        `workbuddy adapter: PROVIDER_MISMATCH cannot resolve model for "${provider}"`,
        'PROVIDER_MISMATCH',
      )
    }
    const parsed = parseModelId(model)
    if (!parsed.ok) {
      // The rejection message already contains the original id; prefix the
      // code so callers that grep the message find it.
      throw new WorkbuddyAdapterError(
        `${parsed.rejection!.code}: ${parsed.rejection!.message}`,
        parsed.rejection!.code,
      )
    }
    return {
      provider: WORKBUDDY_PROVIDER,
      id: model,
      name: model,
      hasRealmPrefix: parsed.hasRealmPrefix,
      realm: parsed.realm,
    }
  }

  async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{
    model: WorkbuddyModelView
    stream: (options: WorkbuddyStreamOptions) => AsyncIterable<WorkbuddyStreamChunk>
  }> {
    const m = await this.resolveModel(provider, model)
    if (signal?.aborted) {
      throw new WorkbuddyAdapterError('workbuddy: prepareCall cancelled', 'CALL_CANCELLED')
    }
    return {
      model: m,
      stream: (options) => this.stream({ ...options, model }),
    }
  }

  async *stream(options: WorkbuddyStreamOptions): AsyncIterable<WorkbuddyStreamChunk> {
    const parsed = parseModelId(options.model)
    if (!parsed.ok) {
      yield {
        type: 'error',
        error: { message: parsed.rejection!.message, code: parsed.rejection!.code, type: 'invalid_request_error' },
      }
      return
    }

    // wb2api accepts the bare id on the wire and uses the realm by the user's
    // account config; we still send the bare id here.
    const body = { ...(options.body as Record<string, unknown>), model: parsed.wireId, stream: true }

    let response: Response
    try {
      // We use a fresh AbortController so the streaming request can outlive a
      // caller-cancelled parent (plan V2.2.1 §6.2: only finish at the last
      // user-visible token). The signal here is the caller's signal, which
      // the runtime owns.
      response = await this.fetchImpl(this.client.baseURL + '/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: options.signal,
      })
    } catch (e) {
      yield { type: 'error', error: { message: `workbuddy: stream fetch failed: ${(e as Error).message}` } }
      return
    }

    if (!response.ok || response.body === null) {
      const text = await response.text().catch(() => '')
      yield {
        type: 'error',
        error: {
          message: `workbuddy: stream HTTP ${response.status} ${text.slice(0, 200)}`,
          code: 'PROVIDER_HTTP',
        },
      }
      return
    }

    yield* parseSseResponse(response.body, options.signal)
  }
}

export class WorkbuddyAdapterError extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(message)
    this.name = 'WorkbuddyAdapterError'
    this.code = code
  }
}

/**
 * Parse an OpenAI-compatible SSE stream from wb2api into WorkbuddyStreamChunks.
 *
 * wb2api v1.13 returns the standard `data: {…}` lines terminated by
 * `data: [DONE]`. Each line is a Chat Completions chunk with a `choices` array
 * carrying `delta.content` (text) and `delta.reasoning_content` (reasoning).
 *
 * The final chunk carries a `usage` block when the upstream sends one.
 */
export async function* parseSseResponse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<WorkbuddyStreamChunk> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  try {
    while (true) {
      if (signal?.aborted) {
        yield { type: 'error', error: { message: 'workbuddy: stream aborted', code: 'CALL_CANCELLED' } }
        return
      }
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // SSE lines end with a blank line. Split on \n\n first.
      let boundary: number
      // eslint-disable-next-line no-cond-assign
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        for (const line of rawEvent.split('\n')) {
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (data === '[DONE]') {
            yield { type: 'finish', finishReason: 'stop' }
            return
          }
          let parsed: unknown
          try {
            parsed = JSON.parse(data)
          } catch {
            continue
          }
          const chunk = sseChunkToWorkbuddyChunk(parsed)
          if (chunk) yield chunk
        }
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

function sseChunkToWorkbuddyChunk(payload: unknown): WorkbuddyStreamChunk | null {
  if (payload === null || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>

  // Error chunk?
  const err = p.error
  if (err !== undefined) {
    const e = err as Record<string, unknown>
    return {
      type: 'error',
      error: {
        message: typeof e.message === 'string' ? e.message : 'workbuddy: upstream error',
        code: typeof e.code === 'string' ? e.code : undefined,
        type: typeof e.type === 'string' ? e.type : undefined,
      },
    }
  }

  const choices = p.choices
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] as Record<string, unknown>
    const delta = first.delta as Record<string, unknown> | undefined
    const finishReason = typeof first.finish_reason === 'string' ? first.finish_reason : undefined
    if (delta !== undefined && delta !== null) {
      const text = typeof delta.content === 'string' ? delta.content : undefined
      const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : undefined
      if (text !== undefined && text.length > 0) {
        const c: WorkbuddyStreamChunk = { type: 'text', text }
        if (finishReason !== undefined) c.finishReason = finishReason
        return c
      }
      if (reasoning !== undefined && reasoning.length > 0) {
        const c: WorkbuddyStreamChunk = { type: 'reasoning', reasoning }
        if (finishReason !== undefined) c.finishReason = finishReason
        return c
      }
    }
    if (finishReason !== undefined && finishReason !== null) {
      return { type: 'finish', finishReason }
    }
  }

  const usage = p.usage
  if (usage !== undefined && usage !== null && typeof usage === 'object') {
    const u = usage as Record<string, unknown>
    return {
      type: 'usage',
      usage: {
        promptTokens: numberOrZero(u.prompt_tokens),
        completionTokens: numberOrZero(u.completion_tokens),
        totalTokens: numberOrZero(u.total_tokens),
      },
    }
  }
  return null
}

function numberOrZero(v: unknown): number {
  return typeof v === 'number' ? v : 0
}
