/**
 * Shared constants for dsh-workbuddy-bridge.
 *
 * Used by both the host (`src/host/`) and client (`src/client/`) halves.
 * Plan reference: V2.2.1 §1.1, §7.2.
 */

export const PLUGIN_NAME = 'workbuddy'

/** wb2api default listening address (plan §1.1: `:7863` not loopback-only). */
export const DEFAULT_WB2API_BASEURL = 'http://127.0.0.1:7863'

/** Path dsh-cost-meter v1.8.15 reads for the workbuddy provider (M08 evidence). */
export const COST_METER_CREDITS_PATH = '/v0/management/plugins/workbuddy/credits'

/** Poll interval for wb2api /panel/api/login/poll (M03 evidence: 3s). */
export const OAUTH_POLL_INTERVAL_MS = 3_000

/** Hard cap on an OAuth attempt so an abandoned window does not pin resources. */
export const OAUTH_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Reserved credential key for the workbuddy flow in the DSH credential store.
 * The actual refresh token is held by wb2api itself; this entry only records
 * whether the user has at least one signed-in account.
 */
export const WORKBUDDY_OAUTH_CREDENTIAL_KEY = 'WORKBUDDY_OAUTH'

/** Cache TTL for /v1/models (the wb2api response is a static 19-entry list). */
export const MODELS_CACHE_TTL_MS = 60 * 1000
