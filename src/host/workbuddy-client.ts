/**
 * Minimal typed HTTP client for the wb2api REST surface.
 *
 * Plan reference: V2.2.1 §1.1 (real interface facts), M03-M07 evidence.
 *
 * This module is the **only** place that talks to wb2api over HTTP. Every
 * other host module goes through these helpers so the auth header, error
 * normalisation, and timeouts live in one place.
 *
 * The class is deliberately dependency-injection-friendly: it takes a
 * `fetchImpl` so the unit tests can hand in a stub without touching the
 * global `fetch`. In production it defaults to the platform `fetch`.
 */

import { setTimeout as sleep } from 'node:timers/promises'

import { attributionHeaders } from './attribution.js'

export interface WorkbuddyClientOptions {
  baseURL: string
  apiKey: string
  /** Override for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Per-request timeout in ms. Defaults to 30s. */
  requestTimeoutMs?: number
}

export interface WorkbuddyModelInfo {
  /** Canonical id wb2api advertises (always starts with `cn:` for v1.13). */
  id: string
  /** Optional display name; wb2api v1.13 returns the bare id. */
  name?: string
  /** Owner field per OpenAI /v1/models convention; wb2api returns "workbuddy2api". */
  owned_by?: string
}

export interface WorkbuddyListModelsResponse {
  object: 'list'
  data: WorkbuddyModelInfo[]
}

export interface WorkbuddyStatusResponse {
  accounts: Array<Record<string, unknown>>
  [key: string]: unknown
}

export interface WorkbuddyLoginStartResponse {
  ok: boolean
  realm: 'cn' | 'global'
  state: string
  url: string
}

export type WorkbuddyLoginPollResponse =
  | { done: false; message?: string; [k: string]: unknown }
  | { done: true; message?: string; uid?: string; nickname?: string; realm?: string; [k: string]: unknown }

export class WorkbuddyClientError extends Error {
  readonly status: number
  readonly body: string
  constructor(message: string, status: number, body: string) {
    super(message)
    this.name = 'WorkbuddyClientError'
    this.status = status
    this.body = body
  }
}

export class WorkbuddyClient {
  /** Public so `WorkbuddyLlmAdapter` can issue the streaming request directly. */
  readonly baseURL: string
  /** Mutable so the host can upgrade the key when the credentials service resolves late. */
  apiKey: string
  private readonly fetchImpl: typeof fetch
  private readonly requestTimeoutMs: number

  constructor(opts: WorkbuddyClientOptions) {
    this.baseURL = opts.baseURL.replace(/\/+$/, '')
    this.apiKey = opts.apiKey
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis)
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000
  }

  /** GET /healthz (no auth, plan §1.1). */
  async healthz(): Promise<unknown> {
    return this.request('GET', '/healthz', { auth: false })
  }

  /** GET /v1/models (Bearer auth, M04 evidence). */
  async listModels(): Promise<WorkbuddyListModelsResponse> {
    return this.request<WorkbuddyListModelsResponse>('GET', '/v1/models', { auth: true })
  }

  /** GET /status (Bearer auth, M06 evidence). */
  async status(): Promise<WorkbuddyStatusResponse> {
    return this.request<WorkbuddyStatusResponse>('GET', '/status', { auth: true })
  }

  /**
   * POST /panel/api/login/start (Bearer auth, M03 evidence).
   *
   * This **does not** open a browser; the caller must hand the returned `url`
   * to the user (via `ctx.authorization.registerFlow` `session.notify({url})`).
   */
  async loginStart(realm: 'cn' | 'global'): Promise<WorkbuddyLoginStartResponse> {
    return this.request<WorkbuddyLoginStartResponse>('POST', '/panel/api/login/start', {
      auth: true,
      json: { realm },
    })
  }

  /**
   * GET /panel/api/login/poll?state=... (Bearer auth, M03 evidence).
   *
   * `done: false` means "still waiting"; `done: true` means the account is
   * written to wb2api's `auths/` and is hot-loaded.
   */
  async loginPoll(state: string): Promise<WorkbuddyLoginPollResponse> {
    const q = `?state=${encodeURIComponent(state)}`
    return this.request<WorkbuddyLoginPollResponse>('GET', '/panel/api/login/poll' + q, {
      auth: true,
    })
  }

  /**
   * Internal: one HTTP request with the standard headers + timeout.
   */
  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    opts: {
      auth: boolean
      json?: Record<string, unknown>
    },
  ): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      // Attribution, on every request. Without it these arrive upstream as
      // `node` — undici's default, which names nothing.
      ...attributionHeaders(),
    }
    if (opts.auth) {
      headers['Authorization'] = `Bearer ${this.apiKey}`
    }
    if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json'
    }

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(new Error('workbuddy: request timeout')), this.requestTimeoutMs)

    let response: Response
    try {
      response = await this.fetchImpl(this.baseURL + path, {
        method,
        headers,
        body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
        signal: ac.signal,
      })
    } finally {
      clearTimeout(timer)
    }

    const text = await response.text()
    if (!response.ok) {
      throw new WorkbuddyClientError(
        `workbuddy: ${method} ${path} → HTTP ${response.status}`,
        response.status,
        text,
      )
    }
    if (text.length === 0) {
      // No body (e.g. 204). Caller is responsible for the void return type.
      return undefined as unknown as T
    }
    try {
      return JSON.parse(text) as T
    } catch (e) {
      throw new WorkbuddyClientError(
        `workbuddy: ${method} ${path} → invalid JSON in response: ${(e as Error).message}`,
        response.status,
        text,
      )
    }
  }
}

/**
 * Poll `loginPoll` until `done: true`, the abort signal fires, or
 * `maxDurationMs` elapses. Returns the terminal payload.
 *
 * Used by `auth-flow.ts`. Exposed here so the same helper is testable in
 * isolation.
 */
export async function pollUntilDone(
  client: WorkbuddyClient,
  state: string,
  signal: AbortSignal,
  intervalMs: number,
  maxDurationMs: number,
): Promise<WorkbuddyLoginPollResponse> {
  const startedAt = Date.now()
  while (!signal.aborted && Date.now() - startedAt < maxDurationMs) {
    // Sleep but wake early on abort.
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, intervalMs)
      const onAbort = () => {
        clearTimeout(t)
        reject(new Error('workbuddy: login poll cancelled'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
    })
    const resp = await client.loginPoll(state)
    if (resp.done) return resp
  }
  if (signal.aborted) {
    throw new Error('workbuddy: login poll cancelled')
  }
  throw new Error(`workbuddy: login poll timed out after ${maxDurationMs}ms`)
}

export { sleep }
