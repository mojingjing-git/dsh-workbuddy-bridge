/**
 * Attribution headers for every request this plugin sends upstream.
 *
 * DSH's contract is that an adapter sends `attributionHeaders()` from
 * `@deepseek-ai/dsh-llm`, whose whole body is:
 *
 *     function attributionHeaders(identity = APP_IDENTITY) {
 *       return { 'user-agent': userAgent(identity) }
 *     }
 *     function userAgent(identity = APP_IDENTITY) {
 *       return `${identity.product}/${identity.version} (+${identity.url})`
 *     }
 *
 * A plugin cannot call it. The plugin runtime may not import `@deepseek-ai/*`
 * at runtime — those packages are provided through `ctx` — and the function is
 * not reachable through any service. So the value is reproduced here.
 *
 * The omission was visible in the wild: DSH's own traffic arrives at the
 * gateway as
 *
 *     deepseek-harness/0.2.0-rc.2 (+https://github.com/deepseek-ai/deepseek-harness)
 *
 * while this plugin's arrived as `node` — Node's undici default, which names
 * nothing. That is what the header exists to prevent.
 *
 * The version is the one part that cannot be reproduced faithfully:
 * `APP_IDENTITY.version` is the running application's version, injected when
 * DSH is built, and no stable path exposes it to a plugin. Rather than guess a
 * number that would silently rot, this sends the product and URL (which is what
 * makes the traffic attributable at all) and names the plugin with its real
 * version as a second product token, which RFC 9110 §10.1.5 permits.
 *
 * Set `DSH_APP_VERSION` to send the exact application version instead.
 *
 * @module
 */

import { PLUGIN_NAME, PLUGIN_VERSION } from '../shared/constants.js'

const HARNESS_PRODUCT = 'deepseek-harness'
const HARNESS_URL = 'https://github.com/deepseek-ai/deepseek-harness'

/**
 * The application version to report, or `undefined` to omit it.
 *
 * Read from the environment on each call rather than captured at module load,
 * so a caller that sets it before mounting still takes effect.
 */
function harnessVersion(): string | undefined {
  const raw = process.env.DSH_APP_VERSION
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  // The header value must stay a single line and must not be able to inject a
  // second product token or a newline into the header.
  if (trimmed.length === 0 || !/^[0-9A-Za-z.+-]+$/.test(trimmed)) return undefined
  return trimmed
}

/**
 * Headers to merge into every upstream request.
 *
 * Header names are lowercase, matching `attributionHeaders()`.
 */
export function attributionHeaders(): Record<string, string> {
  const version = harnessVersion()
  const harness = version === undefined ? HARNESS_PRODUCT : `${HARNESS_PRODUCT}/${version}`
  return {
    'user-agent': `${harness} (+${HARNESS_URL}) ${PLUGIN_NAME}/${PLUGIN_VERSION}`,
  }
}

/** The exact `user-agent` value, for tests and diagnostics. */
export function attributionUserAgent(): string {
  const value = attributionHeaders()['user-agent']
  // `attributionHeaders` always sets it; the fallback keeps the type honest.
  return value ?? `${HARNESS_PRODUCT} (+${HARNESS_URL})`
}
