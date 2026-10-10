/**
 * Resolve the gateway endpoint and key for the manual scripts.
 *
 * The key is never logged and never written by these scripts; they only read
 * it. Precedence:
 *
 *   1. `WB2API_API_KEY` + `WB2API_BASEURL` in the environment
 *   2. the `api_key` field of the JSON file named by `WB2API_CONFIG`
 *   3. the same field of the default local wb2api config
 */

import { readFileSync } from 'node:fs'

const DEFAULT_CONFIG = 'C:/Users/MoJingJing/Desktop/Workbuddy2api/config.json'
const DEFAULT_BASEURL = 'http://127.0.0.1:7863'

export function resolveGateway() {
  const baseURL = (process.env.WB2API_BASEURL ?? DEFAULT_BASEURL).replace(/\/+$/, '')

  const fromEnv = process.env.WB2API_API_KEY
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    return { baseURL, apiKey: fromEnv, source: 'WB2API_API_KEY' }
  }

  const configPath = process.env.WB2API_CONFIG ?? DEFAULT_CONFIG
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'))
    const key = parsed?.api_key
    if (typeof key === 'string' && key.length > 0) {
      return { baseURL, apiKey: key, source: `api_key in ${configPath}` }
    }
    throw new Error(`no api_key field in ${configPath}`)
  } catch (e) {
    console.error('cannot resolve a gateway key.')
    console.error(`  set WB2API_API_KEY, or point WB2API_CONFIG at a wb2api config.json.`)
    console.error(`  tried: ${configPath}`)
    console.error(`  error: ${e.message}`)
    process.exit(2)
  }
}

/** Announce what is about to be contacted, without printing the secret. */
export function describeGateway({ baseURL, source }) {
  console.log(`gateway : ${baseURL}`)
  console.log(`key from: ${source}`)
}
