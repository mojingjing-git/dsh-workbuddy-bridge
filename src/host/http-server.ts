/**
 * Local HTTP server that exposes the path dsh-cost-meter@1.8.15 expects:
 *   GET /v0/management/plugins/workbuddy/credits
 *
 * Plan reference: V2.2.1 §6.2, M08 evidence, M09 evidence (decision:
 * Node built-in `http` + 127.0.0.1:0 — no @deepseek-ai/dsh-host-webserver
 * dependency because its npm version lags the DSH desktop bundle).
 *
 * The server is read-only. Any non-GET method is a 405. It does not expose
 * the OAuth URL (that's a typert service call, not HTTP).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { WorkbuddyClient, WorkbuddyClientError } from './workbuddy-client.js'
import {
  adaptWb2apiStatusToWorkbuddyCredits,
  type WorkbuddyCreditsPayload,
} from '../shared/credits-schema.js'
import { COST_METER_CREDITS_PATH } from '../shared/constants.js'

export interface ManagementServerOptions {
  /** Pre-built wb2api client used to fetch /status. */
  client: WorkbuddyClient
  /**
   * Expected value of the `X-Management-Key` header. When undefined, the
   * server refuses all requests (safe default).
   */
  managementKey: string
  /**
   * Port to listen on. Defaults to 0 (OS picks a free one).
   *
   * The consumer of this endpoint — dsh-cost-meter — is configured with a
   * baseURL the user types in, so a port that changes every restart has to be
   * re-typed every restart. A fixed default makes that configuration a one-off;
   * 0 remains available for callers that want isolation instead.
   */
  port?: number
  /** Override for tests. Defaults to global fetch (unused here). */
  fetchImpl?: typeof fetch
  /** Override for tests (real Node listen). */
  listenImpl?: (server: Server) => Promise<{ port: number }>
}

export interface ManagementServerHandle {
  /** Bound host:port (e.g. `http://127.0.0.1:7710`). */
  baseURL: string
  /** The port actually bound, whatever was requested. */
  port: number
  /** Close the server. */
  close(): Promise<void>
}

/**
 * Start the management server.
 *
 * - Listens on `127.0.0.1` only. The port is the caller's choice, defaulting
 *   to an OS-assigned one; see `ManagementServerOptions.port`.
 * - Verifies `X-Management-Key` with a constant-time compare so a brute
 *   force scan does not leak the key through timing.
 * - Returns 200 + JSON body on success, 401 on bad key, 405 on non-GET,
 *   502 on wb2api failure.
 */
export async function startManagementServer(
  opts: ManagementServerOptions,
): Promise<ManagementServerHandle> {
  const expectedKeyBuf = Buffer.from(opts.managementKey, 'utf8')
  const requestedPort = opts.port ?? 0
  const server = createServer((req, res) => {
    void handle(req, res, opts, expectedKeyBuf)
  })

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    // 127.0.0.1, never `0.0.0.0`: this endpoint answers with account balances
    // and is gated only by a bearer-style header.
    server.listen(requestedPort, '127.0.0.1', () => {
      const addr = server.address()
      if (addr === null || typeof addr === 'string') {
        reject(new Error('workbuddy management server: cannot get bound address'))
        return
      }
      resolve(addr.port)
    })
  })

  return {
    port,
    baseURL: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ManagementServerOptions,
  expectedKeyBuf: Buffer,
): Promise<void> {
  try {
    if (req.method !== 'GET') {
      writeText(res, 405, 'text/plain', 'method not allowed')
      return
    }
    if (!req.url || !req.url.startsWith(COST_METER_CREDITS_PATH)) {
      writeText(res, 404, 'text/plain', 'not found')
      return
    }
    const provided = headerValue(req, 'x-management-key')
    const providedBuf = Buffer.from(provided, 'utf8')
    const match =
      providedBuf.length === expectedKeyBuf.length &&
      timingSafeEqual(providedBuf, expectedKeyBuf)
    if (!match) {
      writeText(res, 401, 'text/plain', 'bad management key')
      return
    }

    let status: unknown
    try {
      status = await opts.client.status()
    } catch (e) {
      const status =
        e instanceof WorkbuddyClientError ? e.status : 0
      writeJson(res, status === 0 ? 502 : status, { error: 'WORKBUDDY_PLUGIN_UNAVAILABLE', message: (e as Error).message })
      return
    }

    const now = new Date().toISOString()
    const payload: WorkbuddyCreditsPayload = adaptWb2apiStatusToWorkbuddyCredits(status, now)
    writeJson(res, 200, payload)
  } catch (e) {
    writeText(res, 500, 'text/plain', `internal: ${(e as Error).message}`)
  }
}

function headerValue(req: IncomingMessage, name: string): string {
  const v = req.headers[name]
  if (typeof v === 'string') return v
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'string') return v[0]
  return ''
}

function writeText(res: ServerResponse, status: number, type: string, text: string): void {
  writeJson(res, status, text, type)
}

function writeJson(res: ServerResponse, status: number, body: unknown, contentType = 'application/json'): void {
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' })
  if (contentType === 'application/json') {
    res.end(JSON.stringify(body))
  } else {
    res.end(body as string)
  }
}

/**
 * Management key for the loopback management server.
 *
 * `randomBytes`, not a hash of `Math.random()`. The server is bound to
 * loopback, which lowers the exposure but is not a reason to weaken the
 * credential: loopback is reachable by every local process and every browser
 * page on the machine, and a V8 `Math.random()` stream is not a CSPRNG — its
 * internal state is recoverable from a handful of outputs.
 *
 * 32 bytes, hex-encoded, matching the length the DSH credential store and
 * dsh-cost-meter's management-key field both accept.
 */
export function defaultManagementKey(): string {
  return randomBytes(32).toString('hex')
}
