/**
 * Host half of dsh-workbuddy-bridge.
 *
 * Plan reference: V2.2.1 §0, §3.2, §5, §6, M01-M10 evidence.
 *
 * The host does **not** extend a class. It exports three cordis-plugin
 * symbols plus an `apply` entry, the same shape as
 * `@deepseek-ai/dsh-llm-pi-ai/src/index.ts` (M02 evidence line 93-94,
 * 149) and `dsh-cost-meter/lib/index.js` line 45, 3237 — the two real
 * host plugins we have on disk.
 *
 * Pipeline inside `apply`:
 *
 *   1. resolve the workbuddy route config (default: empty)
 *   2. read the API key from `ctx.credentials` (or fall back to the
 *      `apiKey` literal override, used in tests)
 *   3. start the local management HTTP server (dsh-cost-meter contract)
 *   4. register the LLM adapter (route "workbuddy")
 *   5. register model discovery against `/v1/models`
 *   6. register the configurable provider so it shows in the Models page
 *   7. register the OAuth flow via `ctx.authorization`
 *   8. return disposers via `ctx.effect`
 *
 * Step 1-2 may fail (no route, no key) — when so, we log and skip the
 * downstream steps; the plugin is always loaded and the UI always
 * available, so the user can fix the config and the host hot-reloads
 * (`Config` is `.volatile()`).
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only imports from the DSH LLM seam. The runtime instance of the `llm`
// service is provided by the DSH desktop bundle; the plugin never imports this
// package at runtime (the bundle has its own copy).
import type {
  LlmDiscoveredModel,
  LlmModelDiscoveryRequest,
  LlmRuntime,
} from '@deepseek-ai/dsh-llm'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { Config, type WorkbuddyConfig, type WorkbuddyProviderConfig } from './schema.js'
import {
  PLUGIN_NAME,
  DEFAULT_WB2API_BASEURL,
  COST_METER_CREDITS_PATH,
  MANAGEMENT_KEY_CREDENTIAL,
} from '../shared/constants.js'
import { WorkbuddyClient } from './workbuddy-client.js'
import {
  WorkbuddyLlmAdapter,
  WORKBUDDY_PROVIDER,
  workbuddyConfigurableProvider,
} from './llm-adapter.js'
import {
  startManagementServer,
  defaultManagementKey,
  type ManagementServerHandle,
} from './http-server.js'
import {
  registerWorkbuddyOAuthFlow,
  type AuthorizationService,
  type CredentialsService,
} from './auth-flow.js'

export const name = PLUGIN_NAME

/**
 * Services the host depends on at apply time.
 *
 * - `llm` — the LLM registry; we register a workbuddy route against it
 * - `authorization` — the dsh-authorization seam; we register the OAuth flow
 * - `credentials` — used to read the wb2api API key + write the bound marker
 */
export const inject = ['llm', 'authorization', 'credentials'] as const

export { Config }

/**
 * DSH bundle shape of `ctx.inject([name], cb)` (M02 evidence: the bundle
 * invokes the callback with the resolved service, or `undefined` if the
 * service is not mounted).
 */
export interface InjectCallback<T> {
  (service: T): void
}

export interface InjectFn {
  <K extends string>(names: readonly K[], cb: InjectCallback<unknown>): void
  /** Single-name convenience used by dsh-cost-meter (`ctx.inject(['settings'], cb)`). */
  <K extends string>(name: K, cb: InjectCallback<unknown>): void
}

export interface EffectFn {
  (gen: (this: Context) => Generator<() => void, void, void>, label: string): void
}

export interface EventOnFn {
  (event: string, cb: (...args: unknown[]) => void): void
}

export interface GetFn {
  (name: string): unknown
}

export interface LoggerLike {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
  debug(message: string): void
}

export interface WorkbuddyPluginContext {
  inject: InjectFn
  effect: EffectFn
  on: EventOnFn
  get: GetFn
  logger: LoggerLike
  /**
   * The `llm` service as cordis exposes it on the context.
   *
   * `dsh-llm-pi-ai` reaches the runtime this way (`ctx.llm.registerAdapter(…)`)
   * rather than through `ctx.get('llm')`. The difference is not cosmetic: a
   * cordis service property is a proxy that binds `this.ctx` to the *caller's*
   * context at call time, which is what routes the registration's effect into
   * this plugin's fiber so unloading disposes it. `ctx.get()` returns the raw
   * service, whose effects land on the service's own fiber.
   */
  llm?: LlmRuntime
  /**
   * The `authorization` service as cordis exposes it on the context.
   *
   * Same reasoning as `llm` above, and it matters for the same reason.
   * `AuthorizationService.registerFlow()` registers the flow through
   * `this.ctx.effect()`, so **which context it is called on decides which fiber
   * owns the registration**. Reached via `ctx.get('authorization')` the raw
   * service is used, the effect lands on the service's own fiber, and the flow
   * is never withdrawn when this plugin unloads — a reload then hits
   * `DUPLICATE_FLOW`, and the stale flow keeps offering a sign-in that can no
   * longer complete.
   *
   * The property form binds `this.ctx` to this plugin's context at call time,
   * which puts the registration in this plugin's fiber.
   */
  authorization?: AuthorizationService
}

/** Where the mount journal is written. Readable from outside the app. */
const MOUNT_JOURNAL_PATH = join(homedir(), '.dsh', 'workbuddy-bridge-mount.json')

export function apply(ctx: WorkbuddyPluginContext, config: WorkbuddyConfig): void {
  // A mount journal on disk. `ctx.logger` goes to the Electron console, which
  // is not readable from outside the app, so a failed mount is otherwise
  // invisible: `apply()` returns, the fiber stays alive, and the only symptom
  // is a route that never appears. Recording each step turns that into
  // something diagnosable after the fact.
  const journal = new MountJournal()

  /**
   * Revoked when this fiber unloads, or when a re-apply supersedes this call.
   *
   * Registering the revoker **synchronously**, before the first await, is the
   * point: everything below runs in a promise chain that outlives `apply()`,
   * and without a revocation check a mount that was already abandoned still
   * runs to completion — starting a management server on a random port and
   * registering an LLM route with the previous key and URL, on a fiber that no
   * longer exists to dispose either.
   *
   * `apply` is synchronous, so the fiber is necessarily active here and this
   * effect cannot be refused.
   */
  let revoked = false
  ctx.effect(function* () {
    yield () => {
      revoked = true
    }
  }, 'workbuddy: mount attempt revocation')

  const isRevoked = (): boolean => revoked

  journal.record('apply', 'entered', {
    hasConfig: config !== undefined && config !== null,
    providers: config?.providers === undefined ? 'undefined' : Object.keys(config.providers),
  })

  const route = config.providers.workbuddy

  if (route === undefined) {
    journal.record('apply', 'aborted', { reason: 'no providers.workbuddy in the delivered config' })
    ctx.logger.info(
      'workbuddy: no provider route configured yet. Set providers.workbuddy in DSH Models page to attach.',
    )
    // Still mount a thin shell so the UI can prompt the user.
    ctx.inject(['authorization'], () => {
      // No-op until route is configured.
    })
    return
  }

  journal.record('apply', 'route resolved', {
    apiKeyEnv: route.apiKeyEnv,
    baseURL: route.baseURL,
    realm: route.realm,
  })

  // Removing `apiKey` from the schema does not keep it out of the config.
  //
  // schemastery objects do not strip undeclared keys. Verified against
  // @deepseek-ai/schemastery 3.18.4: `z.object({ a })({ a: '1', secret: 'x' })`
  // returns `{ a: '1', secret: 'x' }`, and neither `.loose()` nor `.extra()`
  // changes that — there is no `.strict()`. So a literal key written into
  // `cordis.patch.yml` still arrives here.
  //
  // The schema removal is still worth doing (the field is no longer advertised
  // to the settings surface, so nothing invites anyone to paste a secret into a
  // plaintext file), but the actual protection is refusing to *read* it. Only
  // the credential store is a supported source.
  const strayApiKey = (route as { apiKey?: unknown }).apiKey
  if (typeof strayApiKey === 'string' && strayApiKey.length > 0) {
    journal.record('apply', 'ignored a literal apiKey', { length: strayApiKey.length })
    ctx.logger.warn(
      'workbuddy: this route carries a literal apiKey, which is ignored. A key in the ' +
        'config file is a plaintext secret in the profile directory and in any copy of ' +
        `it. Use credentials: store the key under "${route.apiKeyEnv}" instead.`,
    )
  }

  // Resolve API key. We try (in order):
  //   1. route.apiKey (test override or literal user value)
  //   2. ctx.credentials resolving the env-var name from route.apiKeyEnv
  //   3. the env var directly (fallback when no credentials service exists)
  //
  // Written as one async function rather than a `.then()` chain so that every
  // await is followed by a revocation check. The chain form made the gaps
  // invisible: `resolveApiKey` and the management-server bind are both awaits,
  // and a config change during either one previously let the rest of the mount
  // proceed against values that were already superseded.
  void (async () => {
    try {
      const apiKey = await resolveApiKey(ctx, route)
      if (isRevoked()) {
        journal.record('resolveApiKey', 'abandoned', { reason: 'fiber unloaded or re-applied' })
        return
      }

      if (apiKey === undefined) {
        journal.record('resolveApiKey', 'failed', {
          apiKeyEnv: route.apiKeyEnv,
          hint: 'not in the credential store and not in process.env',
        })
        ctx.logger.warn(
          `workbuddy: no API key resolved (apiKeyEnv="${route.apiKeyEnv}"). ` +
            'Set the env var or enter the key in DSH Models page.',
        )
        // Mount the OAuth flow anyway so the user can sign in. This is the
        // no-key path, so there is no LLM route to wait on first — but the
        // credential lookups above already awaited.
        await mountOAuthFlow(ctx, route, journal, isRevoked)
        return
      }

      journal.record('resolveApiKey', 'resolved', { length: apiKey.length })
      await mountEverything(ctx, route, apiKey, journal, isRevoked)
    } catch (e) {
      journal.recordFailure('mount', e)
      ctx.logger.error(`workbuddy host mount failed: ${(e as Error).message}`)
    }
  })()
}

/**
 * Append-only record of how far the mount got.
 *
 * Writes the whole document after every step so the file is readable even when
 * the process dies mid-mount. Deliberately never throws: a diagnostic that can
 * break the thing it diagnoses is worse than no diagnostic.
 */
class MountJournal {
  private readonly steps: Array<Record<string, unknown>> = []

  constructor() {
    this.record('module', 'apply() called')
  }

  record(step: string, outcome: string, detail?: Record<string, unknown>): void {
    const entry = {
      at: new Date().toISOString(),
      step,
      outcome,
      ...redactDetail(detail),
    }
    this.steps.push(entry)
    // Bounded, oldest-first: the journal is a diagnostic, not a log sink. A
    // mount that retries on every config change could otherwise grow it without
    // limit in the user's home directory.
    if (this.steps.length > MAX_JOURNAL_STEPS) {
      this.steps.splice(0, this.steps.length - MAX_JOURNAL_STEPS)
    }
    try {
      writeFileSync(MOUNT_JOURNAL_PATH, JSON.stringify({ steps: this.steps }, null, 2), 'utf8')
    } catch {
      // A diagnostic must never be the reason a mount fails.
    }
    try {
      // eslint-disable-next-line no-console
      console.log(`workbuddy[mount] ${step}: ${outcome}`, entry)
    } catch {
      // console may be absent in a packaged renderer; ignore.
    }
  }

  /**
   * Record a thrown value without writing a stack trace to disk.
   *
   * Stacks were the one genuinely sensitive thing this file used to carry: they
   * contain absolute paths and, through embedded frame arguments, whatever the
   * failing call happened to hold. The class name, message and code are what
   * make a failure diagnosable; the frames are not, and they are the part that
   * should not be sitting in a file under the user's home directory.
   */
  recordFailure(step: string, error: unknown): void {
    const e = error as { name?: string; message?: string; code?: string; status?: number }
    this.record(step, 'THREW', {
      name: e?.name,
      message: e?.message,
      code: e?.code,
      status: e?.status,
    })
  }
}

/** How many steps the journal keeps. Enough for a full mount, then it rolls. */
const MAX_JOURNAL_STEPS = 200

/** Longest string kept per field, so one value cannot bloat the file. */
const MAX_JOURNAL_VALUE_CHARS = 400

/**
 * Strip the parts of a diagnostic value that should not be written to disk.
 *
 * Three things, and only three, because a journal that drops everything is a
 * journal nobody can use:
 *
 *   - **Stacks** are removed entirely (see `recordFailure`).
 *   - **URLs keep their origin and lose the rest.** `http://127.0.0.1:7863` is
 *     the fact worth recording; a path or query could carry a token, and
 *     userinfo definitely could.
 *   - **Long strings are truncated.** An upstream response body pasted into a
 *     message is both unbounded and the likeliest place for a leaked secret.
 *
 * Errors and other objects are reduced to their own enumerable scalars, one
 * level deep, so a nested request object cannot smuggle a header through.
 */
function redactDetail(detail: Record<string, unknown> | undefined): Record<string, unknown> {
  if (detail === undefined) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(detail)) {
    if (key === 'stack') continue
    out[key] = redactValue(value)
  }
  return out
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (value === undefined) return undefined
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) }
  }
  if (Array.isArray(value)) return value.slice(0, 20).map(redactValue)
  if (typeof value === 'object') {
    const nested: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'stack') continue
      nested[key] = redactValue(inner)
    }
    return nested
  }
  return String(value)
}

function redactString(text: string): string {
  // Keep origin, drop path/query/fragment/userinfo.
  const trimmed = text.trim()
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).origin
    } catch {
      return '<unparseable url>'
    }
  }
  // A URL embedded in a longer message (e.g. "connect http://x/y failed").
  const scrubbed = trimmed.replace(/https?:\/\/[^\s"')]+/gi, (match) => {
    try {
      return new URL(match).origin
    } catch {
      return '<url>'
    }
  })
  return scrubbed.length > MAX_JOURNAL_VALUE_CHARS
    ? `${scrubbed.slice(0, MAX_JOURNAL_VALUE_CHARS)}…[truncated]`
    : scrubbed
}

async function mountEverything(
  ctx: WorkbuddyPluginContext,
  route: WorkbuddyProviderConfig,
  apiKey: string,
  journal: MountJournal,
  isRevoked: () => boolean,
): Promise<void> {
  const baseURL = (route.baseURL ?? DEFAULT_WB2API_BASEURL).replace(/\/+$/, '')
  const realm = route.realm
  // The settings namespace is the plugin's registered name; it is how
  // the Models page addresses this route's configuration, and it must
  // be stable across restarts.
  const settingsNs = PLUGIN_NAME

  const client = new WorkbuddyClient({ baseURL, apiKey })
  // Stable across restarts, so the endpoint dsh-cost-meter is configured with
  // does not change out from under it. The key is never written to the journal.
  const management = await resolveManagementKey(ctx, journal)

  // The credential write inside `resolveManagementKey` is an await, and binding
  // a socket is the next one. A superseded mount must not do either.
  if (isRevoked()) {
    journal.record('managementKey', 'abandoned', { reason: 'fiber unloaded or re-applied' })
    return
  }

  // 1) Local management HTTP server (M08 contract).
  const mgmt: ManagementServerHandle = await startManagementServer({
    client,
    managementKey: management.key,
    ...(route.managementPort === undefined ? {} : { port: route.managementPort }),
  })

  // The server is listening before its disposer exists, and there is a real
  // window between those two facts: `startManagementServer` awaits, and the
  // fiber can go inactive during that await. `ctx.effect` on an inactive fiber
  // throws `INACTIVE_EFFECT`, so the disposer below would never be registered
  // and the listening socket would outlive the plugin with nothing able to
  // close it. Catching that specific case and closing here is the only thing
  // that keeps the socket from leaking; then the error is rethrown so the
  // caller still learns the mount failed.
  try {
    ctx.effect(function* () {
      yield async () => {
        await mgmt.close()
      }
    }, 'workbuddy: management server lifecycle')
  } catch (error) {
    await mgmt.close().catch(() => {
      // Already closing, or the socket is gone. Nothing further to do; the
      // original registration failure is the error worth reporting.
    })
    journal.record('managementServer', 'closed after effect refused', {
      port: mgmt.port,
      reason: (error as Error)?.message,
    })
    throw error
  }

  if (isRevoked()) {
    // Superseded while binding. The disposer is registered, so the socket is
    // reachable by the fiber's teardown — but a superseded mount must not go on
    // to register a route with the key and URL it was started with.
    journal.record('managementServer', 'abandoned after bind', { port: mgmt.port })
    return
  }

  ctx.logger.info(
    `workbuddy: management server bound at ${mgmt.baseURL}${COST_METER_CREDITS_PATH}`,
  )
  // Records everything needed to configure dsh-cost-meter, and nothing secret.
  // This is the delivery path that was missing: the consumer reads a user-typed
  // baseURL and a credential, so both have to be discoverable from outside the
  // app, and the journal is the only channel that survives it.
  journal.record('managementServer', 'listening', {
    port: mgmt.port,
    baseURL: mgmt.baseURL,
    path: COST_METER_CREDITS_PATH,
    keyCredentialRef: MANAGEMENT_KEY_CREDENTIAL,
    keySource: management.source,
    costMeter: {
      sourceType: 'workbuddy',
      baseURL: mgmt.baseURL,
      credentialToFill: `copy the value of ${MANAGEMENT_KEY_CREDENTIAL} into the credential dsh-cost-meter derives from your source id (CLIPROXYAPI_MANAGEMENT_KEY_<ID>_<HASH>)`,
    },
  })

  // 2) LLM adapter (M02 contract). The adapter implements the
  //    official `LlmAdapter` abstract class shape via a type-only
  //    import; the runtime duck-types it (no instanceof check).
  const adapter = new WorkbuddyLlmAdapter(client)
  journal.record('adapter', 'constructed')

  // 3) Reach the `llm` service. `ctx.llm` is the access the shipped
  //    dsh-llm-pi-ai uses; `ctx.get('llm')` is kept as a fallback so a
  //    context that exposes only the lookup still works. Which one answered
  //    is recorded, because the two are not equivalent: only the property
  //    form routes the registration's effect into this plugin's fiber.
  const llmProperty = ctx.llm
  const llmFromLookup = ctx.get('llm') as LlmRuntime | undefined
  const llm = llmProperty ?? llmFromLookup

  journal.record('llm service', llm === undefined ? 'UNAVAILABLE' : 'found', {
    via: llmProperty !== undefined ? 'ctx.llm' : llmFromLookup !== undefined ? "ctx.get('llm')" : 'neither',
    typeofLlm: typeof llmProperty,
    lookupTypeof: typeof llmFromLookup,
    hasRegisterAdapter: llm === undefined ? 'n/a' : typeof llm.registerAdapter,
  })

  if (llm === undefined) {
    ctx.logger.error('workbuddy: the llm service is unreachable; LLM route not registered')
  } else {
    // 3a) Register the adapter for the workbuddy route. The runtime
    //     validates `providerInfo().id === provider` and rejects
    //     duplicates (LlmRuntime.prepareRoutes).
    const handle = llm.registerAdapter([WORKBUDDY_PROVIDER], adapter)
    journal.record('registerAdapter', 'ok', { provider: WORKBUDDY_PROVIDER })
    ctx.effect(function* () {
      yield () => handle()
    }, 'workbuddy: llm adapter lifecycle')

    // 3b) Declare the provider as configurable so the Models page
    //     can show and edit it.
    const dirHandle = llm.registerConfigurableProviders([
      workbuddyConfigurableProvider(settingsNs),
    ])
    journal.record('registerConfigurableProviders', 'ok', { settingsNs })
    ctx.effect(function* () {
      yield () => dirHandle()
    }, 'workbuddy: llm directory lifecycle')

    // 3c) Offer endpoint interrogation for the settings namespace.
    //     The Models page calls this when the user clicks
    //     "discover models"; we answer from the route's own list.
    const discover = async (
      request: LlmModelDiscoveryRequest,
      _signal?: AbortSignal,
    ): Promise<readonly LlmDiscoveredModel[]> => {
      // A draft editing another route is not ours to answer.
      if (request.provider !== undefined && request.provider !== WORKBUDDY_PROVIDER) return []
      const list = await adapter.listModels(WORKBUDDY_PROVIDER)
      return list.map((m) => ({ id: m.id, ...(m.name !== undefined ? { name: m.name } : {}) }))
    }
    const discoverHandle = llm.registerModelDiscovery(settingsNs, discover)
    journal.record('registerModelDiscovery', 'ok', { settingsNs })
    ctx.effect(function* () {
      yield () => discoverHandle()
    }, 'workbuddy: model discovery lifecycle')

    // Probe the gateway once so the journal records whether the route can
    // actually answer, rather than only that it was accepted. This is an
    // upstream round trip, so it is also the longest await in the mount.
    try {
      const models = await adapter.listModels(WORKBUDDY_PROVIDER)
      journal.record('listModels', 'ok', {
        count: models.length,
        first: models.slice(0, 4).map((m) => m.id),
      })
    } catch (e) {
      journal.record('listModels', 'FAILED', {
        message: (e as Error)?.message,
        code: (e as { code?: string })?.code,
      })
    }

    if (isRevoked()) {
      journal.record('listModels', 'abandoned', { reason: 'superseded during the discovery probe' })
      return
    }

    ctx.logger.info(
      `workbuddy: LLM route "${WORKBUDDY_PROVIDER}" registered against ${baseURL} ` +
        `(management port ${mgmt.port}, realm ${realm}, settingsNs "${settingsNs}")`,
    )
    journal.record('mountEverything', 'complete', { managementPort: mgmt.port })
  }

  // 4) OAuth flow (M10 contract). Guarded because the LLM block above waited on
  // the network: registering an authorization flow on a fiber that has since
  // unloaded is exactly the leak this check exists to prevent.
  if (isRevoked()) {
    journal.record('oauth', 'abandoned', { reason: 'superseded before the flow was registered' })
    return
  }
  await mountOAuthFlow(ctx, route, journal, isRevoked, client)
}

async function mountOAuthFlow(
  ctx: WorkbuddyPluginContext,
  route: WorkbuddyProviderConfig,
  journal: MountJournal,
  isRevoked: () => boolean,
  client?: WorkbuddyClient,
): Promise<void> {
  // If we don't have a client (no key yet), build one without one. The flow
  // will resolve its own key from the credentials service.
  const c = client ?? new WorkbuddyClient({ baseURL: route.baseURL ?? DEFAULT_WB2API_BASEURL, apiKey: '' })

  // The property form first, for the same reason `llm` is reached that way:
  // `registerFlow()` calls `this.ctx.effect()` internally, so the context it is
  // invoked on decides which fiber owns the registration. Via `ctx.get()` the
  // raw service is used and the flow survives this plugin's unload, which turns
  // a reload into `DUPLICATE_FLOW` and leaves a sign-in button that cannot work.
  const authorizationProperty = ctx.authorization
  const authorizationFromLookup = ctx.get('authorization') as AuthorizationService | undefined
  const authorization = authorizationProperty ?? authorizationFromLookup
  const credentials = ctx.get('credentials') as CredentialsService | undefined

  journal.record('oauth', authorization === undefined ? 'service UNAVAILABLE' : 'service found', {
    via:
      authorizationProperty !== undefined
        ? 'ctx.authorization'
        : authorizationFromLookup !== undefined
          ? "ctx.get('authorization')"
          : 'neither',
    // Recorded because the two are not equivalent: only the property form ties
    // the flow's lifetime to this plugin's fiber.
    lifetimeOwnedByThisFiber: authorizationProperty !== undefined,
    credentials: credentials === undefined ? 'unavailable' : 'found',
  })

  if (authorization === undefined || credentials === undefined) {
    ctx.logger.warn(
      'workbuddy: authorization or credentials unavailable; OAuth flow not registered. ' +
        'This usually means the DSH desktop bundle does not enable dsh-authorization or dsh-credentials.',
    )
    return
  }

  // For the OAuth flow, we need a WorkbuddyClient that can reach the auth
  // endpoints. The client needs a key for /panel/api/* which requires Bearer
  // auth (M03 evidence). We resolve the same key the LLM uses.
  if (!client) {
    const apiKey = await resolveApiKey(ctx, route)
    if (isRevoked()) {
      journal.record('oauth', 'abandoned', { reason: 'superseded while resolving the key' })
      return
    }
    if (apiKey === undefined) {
      ctx.logger.warn('workbuddy: cannot register OAuth flow without a resolvable API key')
      return
    }
    c.apiKey = apiKey
  }

  registerWorkbuddyOAuthFlow({
    authorization,
    credentials,
    workbuddy: c,
    realm: route.realm,
  })
  journal.record('oauth', 'flow registered', {
    // `registerFlow` returns void and takes no disposer, so the flow's lifetime
    // is whatever `this.ctx.effect()` bound inside the service. With the
    // property form that is this plugin's fiber; with the lookup form it is not,
    // and the flow outlives the plugin. False here is a reload hazard, not a
    // cosmetic difference.
    lifetimeOwnedByThisFiber: authorizationProperty !== undefined,
  })
  ctx.logger.info('workbuddy: OAuth flow registered')
}

/**
 * Local mirror of `@deepseek-ai/dsh-credentials`' `REF_PATTERN`.
 *
 * Duplicated rather than imported because the plugin must not import that
 * package at runtime: DSH provides it through `ctx`, and importing it would
 * load a second copy beside the bundle's own. If the upstream pattern ever
 * widens, `credentialRef()` would accept names this rejects — the failure mode
 * is a warning and a fall-through to the environment, not a crash.
 */
const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Branded credential reference; the brand is compile-time only. */
type CredentialRef = string & { readonly __credentialRef?: unique symbol }

/** The slice of the credentials service this plugin uses. */
interface CredentialsLike {
  resolve(ref: CredentialRef): Promise<{ value: string; source: string } | undefined>
  /**
   * Write a credential. Two positional arguments, verified against
   * `@deepseek-ai/dsh-credentials`:
   *
   *     abstract set(ref: CredentialRef, value: string): Promise<void>
   *
   * Optional here because a context without the credentials service still
   * mounts — the key then lives only for the life of the process.
   */
  set?(ref: CredentialRef, value: string): Promise<void>
}

/**
 * Reserve the management key so it survives a restart.
 *
 * dsh-cost-meter reads the management endpoint with a key the user stores in
 * DSH's credential store under a deterministic name derived from their source
 * id (`managementKeyVarOf` in dsh-cost-meter). That only works if **our** key is
 * stable: a fresh `randomBytes` per start would invalidate the user's
 * configuration on every restart, and the two values could never be made to
 * agree by hand.
 *
 * So: use the stored key when there is one, otherwise generate 32 bytes and
 * persist them. Returns the key plus where it came from, which is what the
 * diagnostics file reports — the key itself never is.
 */
async function resolveManagementKey(
  ctx: WorkbuddyPluginContext,
  journal: MountJournal,
): Promise<{ key: string; source: 'stored' | 'generated' | 'ephemeral' }> {
  const credentials = ctx.get('credentials') as CredentialsLike | undefined
  const ref = MANAGEMENT_KEY_CREDENTIAL as CredentialRef

  if (credentials !== undefined) {
    try {
      const resolved = await credentials.resolve(ref)
      if (resolved !== undefined && resolved.value.length > 0) {
        return { key: resolved.value, source: 'stored' }
      }
    } catch (e) {
      journal.recordFailure('managementKey', e)
    }
  }

  const generated = defaultManagementKey()

  if (credentials?.set === undefined) {
    journal.record('managementKey', 'generated, NOT persisted', {
      reason: 'no credentials service on this context',
      consequence: 'the key changes on every restart and the cost-meter source must be re-keyed',
    })
    return { key: generated, source: 'ephemeral' }
  }

  try {
    await credentials.set(ref, generated)
    journal.record('managementKey', 'generated and persisted', { ref: MANAGEMENT_KEY_CREDENTIAL })
    return { key: generated, source: 'generated' }
  } catch (e) {
    journal.recordFailure('managementKey', e)
    return { key: generated, source: 'ephemeral' }
  }
}

/**
 * Resolve the wb2api API key for the workbuddy route.
 *
 * Order:
 *   1. `route.apiKey` (literal, intended for tests and one-off local use)
 *   2. `ctx.credentials.resolve(route.apiKeyEnv)` (DSH credential store)
 *   3. `process.env[route.apiKeyEnv]` (plain environment, no DSH)
 */
async function resolveApiKey(
  ctx: WorkbuddyPluginContext,
  route: WorkbuddyProviderConfig,
  /**
   * Test seam: a literal key supplied programmatically.
   *
   * Deliberately a parameter rather than a config field. The config schema has
   * no `apiKey`, so a plaintext secret cannot be written into
   * `cordis.patch.yml` or round-tripped through the Models page — which is the
   * only way to keep it out of the profile directory, its backups, and anything
   * that reads them. Nothing in the config path can reach this argument.
   */
  literalApiKey?: string,
): Promise<string | undefined> {
  if (literalApiKey !== undefined && literalApiKey.length > 0) {
    return literalApiKey
  }

  // DSH's credential seam takes ONE branded reference, not the
  // `{ name, value }` pair v0.1 invented. Verified against
  // `@deepseek-ai/dsh-credentials`:
  //
  //   abstract resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>
  //   interface ResolvedCredential { value: string; source: string }
  //
  // A reference is a POSIX-shell-shaped name (`REF_PATTERN` is
  // `^[A-Za-z_][A-Za-z0-9_]*$`). `credentialRef()` would brand it, but that
  // helper lives in a package this plugin must not import at runtime, so the
  // name is validated here with the same pattern and passed as a cast — the
  // brand is a compile-time marker and the runtime value is the string.
  //
  // This is the path that makes an ordinary `apiKeyEnv` work: DSH stores the
  // key in its credential file under the env var's name, so requiring the user
  // to ALSO export a real environment variable would be wrong.
  if (!CREDENTIAL_REF_PATTERN.test(route.apiKeyEnv)) {
    ctx.logger.warn(
      `workbuddy: apiKeyEnv "${route.apiKeyEnv}" is not a valid credential reference ` +
        `(must match ${String(CREDENTIAL_REF_PATTERN)}); skipping the credential lookup`,
    )
  } else {
    const credentials = ctx.get('credentials') as CredentialsLike | undefined
    if (credentials !== undefined) {
      try {
        const hit = await credentials.resolve(route.apiKeyEnv as CredentialRef)
        if (hit !== undefined && hit.value.length > 0) return hit.value
      } catch (e) {
        ctx.logger.warn(
          `workbuddy: credential lookup for "${route.apiKeyEnv}" failed: ` +
            `${e instanceof Error ? e.message : String(e)}`,
        )
      }
    }
  }

  // Plain environment fallback, for a deployment that exports the variable
  // rather than storing it in DSH's credential file.
  const v = process.env[route.apiKeyEnv]
  if (typeof v === 'string' && v.length > 0) return v
  return undefined
}
