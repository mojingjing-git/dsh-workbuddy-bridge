/**
 * Shared constants for dsh-workbuddy-bridge.
 *
 * Used by both the host (`src/host/`) and client (`src/client/`) halves.
 * Plan reference: V2.2.1 §1.1, §7.2.
 */

export const PLUGIN_NAME = 'workbuddy'

/**
 * The package version, for the upstream `user-agent`.
 *
 * Must equal `version` in package.json; `tests/attribution.test.ts` fails if the
 * two drift, because a header that reports a version the package does not have
 * is worse than one that reports none.
 */
export const PLUGIN_VERSION = '0.1.0'

/** wb2api default listening address (plan §1.1: `:7863` not loopback-only). */
export const DEFAULT_WB2API_BASEURL = 'http://127.0.0.1:7863'

/** Path dsh-cost-meter v1.8.15 reads for the workbuddy provider (M08 evidence). */
export const COST_METER_CREDITS_PATH = '/v0/management/plugins/workbuddy/credits'

/** Poll interval for wb2api /panel/api/login/poll (M03 evidence: 3s). */
export const OAUTH_POLL_INTERVAL_MS = 3_000

/**
 * Credential reference holding this plugin's management key.
 *
 * dsh-cost-meter authenticates against the plugin's loopback management server
 * with a key the user stores under a name derived from their gateway-source id:
 * `CLIPROXYAPI_MANAGEMENT_KEY_<ID>_<HASH>` (see `managementKeyVarOf` in
 * dsh-cost-meter). That name is not knowable from here — the user picks the id —
 * so this plugin keeps its own copy under this reference instead, and the two
 * are made to agree by copying the value once.
 *
 * Persisting it is what makes the endpoint configurable at all: a key
 * regenerated per start could never be pasted anywhere durable.
 */
export const MANAGEMENT_KEY_CREDENTIAL = 'WORKBUDDY_MANAGEMENT_KEY'

/** Hard cap on an OAuth attempt so an abandoned window does not pin resources. */
export const OAUTH_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Reserved credential key for the workbuddy flow in the DSH credential store.
 * The actual refresh token is held by wb2api itself; this entry only records
 * whether the user has at least one signed-in account.
 */
export const WORKBUDDY_OAUTH_CREDENTIAL_KEY = 'WORKBUDDY_OAUTH'

/**
 * How long the adapter serves its last `/v1/models` answer before re-asking.
 *
 * The list is **not** static, and an earlier version of this comment wrongly
 * said it was. Two fetches an hour apart returned the same 19 ids in a
 * different order — the gateway orders by account health, so models move as
 * accounts cool down or recover, and the set itself changes as accounts are
 * added:
 *
 *   10:34  hy3, glm-5.3, glm-5.2, glm-5.1, …
 *   11:4x  minimax-m3, hy3-x, glm-5.3, glm-5.2, kimi-k3-1, …
 *
 * `LlmRuntime.listModels()` holds no cache of its own — it delegates to this
 * adapter on every call — so this TTL is the only staleness the model list
 * has. Short enough that a new gateway model appears without a DSH restart;
 * long enough that a page redraw does not hit the network.
 */
export const MODELS_CACHE_TTL_MS = 60 * 1000
