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
// Type-only imports from the DSH LLM seam. The runtime instance of
// the `llm` service is provided by the DSH desktop bundle via
// `ctx.get('llm')`; the plugin never imports this package at runtime
// (the bundle has its own copy).
import type {
  LlmDiscoveredModel,
  LlmModelDiscoveryRequest,
  LlmRuntime,
} from '@deepseek-ai/dsh-llm'

import { Config, type WorkbuddyConfig, type WorkbuddyProviderConfig } from './schema.js'
import {
  PLUGIN_NAME,
  DEFAULT_WB2API_BASEURL,
  COST_METER_CREDITS_PATH,
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
  /** Provided by the loader so the apply's child contexts can address us. */
  fiber?: { entry?: { options?: { id?: string } } }
}

export function apply(ctx: WorkbuddyPluginContext, config: WorkbuddyConfig): void {
  const route = config.providers.workbuddy

  if (route === undefined) {
    ctx.logger.info(
      'workbuddy: no provider route configured yet. Set providers.workbuddy in DSH Models page to attach.',
    )
    // Still mount a thin shell so the UI can prompt the user.
    ctx.inject(['authorization'], () => {
      // No-op until route is configured.
    })
    return
  }

  // Resolve API key. We try (in order):
  //   1. route.apiKey (test override or literal user value)
  //   2. ctx.credentials resolving the env-var name from route.apiKeyEnv
  //   3. the env var directly (fallback when no credentials service exists)
  resolveApiKey(ctx, route).then((apiKey) => {
    if (apiKey === undefined) {
      ctx.logger.warn(
        `workbuddy: no API key resolved (apiKeyEnv="${route.apiKeyEnv}"). ` +
          'Set the env var or enter the key in DSH Models page.',
      )
      // Mount the OAuth flow anyway so the user can sign in.
      mountOAuthFlow(ctx, route).catch((e) => ctx.logger.error(`workbuddy oauth: ${(e as Error).message}`))
      return
    }
    mountEverything(ctx, route, apiKey).catch((e) =>
      ctx.logger.error(`workbuddy host mount failed: ${(e as Error).message}`),
    )
  })
}

async function mountEverything(
  ctx: WorkbuddyPluginContext,
  route: WorkbuddyProviderConfig,
  apiKey: string,
): Promise<void> {
  const baseURL = (route.baseURL ?? DEFAULT_WB2API_BASEURL).replace(/\/+$/, '')
  const realm = route.realm
  // The settings namespace is the plugin's registered name; it is how
  // the Models page addresses this route's configuration, and it must
  // be stable across restarts.
  const settingsNs = PLUGIN_NAME

  const client = new WorkbuddyClient({ baseURL, apiKey })
  const managementKey = defaultManagementKey()

  // 1) Local management HTTP server (M08 contract).
  const mgmt: ManagementServerHandle = await startManagementServer({
    client,
    managementKey,
  })
  ctx.effect(function* () {
    yield async () => {
      await mgmt.close()
    }
  }, 'workbuddy: management server lifecycle')

  ctx.logger.info(
    `workbuddy: management server bound at ${mgmt.baseURL}${COST_METER_CREDITS_PATH}`,
  )

  // 2) LLM adapter (M02 contract). The adapter implements the
  //    official `LlmAdapter` abstract class shape via a type-only
  //    import; the runtime duck-types it (no instanceof check).
  const adapter = new WorkbuddyLlmAdapter(client)

  // 3) Get the `llm` service and register the route. We use the
  //    official `LlmRuntime` type so the calls below are checked
  //    against the shapes the DSH bundle actually provides.
  const llm = ctx.get('llm') as LlmRuntime | undefined

  if (llm === undefined) {
    ctx.logger.error('workbuddy: ctx.get("llm") returned undefined; LLM route not registered')
  } else {
    // 3a) Register the adapter for the workbuddy route. The runtime
    //     validates `providerInfo().id === provider` and rejects
    //     duplicates (M02 evidence, LlmRuntime.prepareRoutes).
    const handle = llm.registerAdapter([WORKBUDDY_PROVIDER], adapter)
    ctx.effect(function* () {
      yield () => handle()
    }, 'workbuddy: llm adapter lifecycle')

    // 3b) Declare the provider as configurable so the Models page
    //     can show and edit it.
    const dirHandle = llm.registerConfigurableProviders([
      workbuddyConfigurableProvider(settingsNs),
    ])
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
    ctx.effect(function* () {
      yield () => discoverHandle()
    }, 'workbuddy: model discovery lifecycle')

    ctx.logger.info(
      `workbuddy: LLM route "${WORKBUDDY_PROVIDER}" registered against ${baseURL} ` +
        `(management port ${mgmt.port}, realm ${realm}, settingsNs "${settingsNs}")`,
    )
  }

  // 4) OAuth flow (M10 contract).
  await mountOAuthFlow(ctx, route, client)
}

async function mountOAuthFlow(
  ctx: WorkbuddyPluginContext,
  route: WorkbuddyProviderConfig,
  client?: WorkbuddyClient,
): Promise<void> {
  // If we don't have a client (no key yet), build one without one. The flow
  // will resolve its own key from the credentials service.
  const c = client ?? new WorkbuddyClient({ baseURL: route.baseURL ?? DEFAULT_WB2API_BASEURL, apiKey: '' })

  const authorization = ctx.get('authorization') as AuthorizationService | undefined
  const credentials = ctx.get('credentials') as CredentialsService | undefined
  if (authorization === undefined || credentials === undefined) {
    ctx.logger.warn(
      'workbuddy: ctx.authorization or ctx.credentials not available; OAuth flow not registered. ' +
        'This usually means the DSH desktop bundle does not enable dsh-authorization or dsh-credentials.',
    )
    return
  }

  // For the OAuth flow, we need a WorkbuddyClient that can reach the auth
  // endpoints. The client needs a key for /panel/api/* which requires Bearer
  // auth (M03 evidence). We resolve the same key the LLM uses.
  if (!client) {
    const apiKey = await resolveApiKey(ctx, route)
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
): Promise<string | undefined> {
  if (route.apiKey !== undefined && route.apiKey.length > 0) {
    return route.apiKey
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
