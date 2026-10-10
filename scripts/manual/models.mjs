/**
 * Inspect what the gateway actually advertises, verbatim.
 *
 * Written because the model list is the input to sorting, and a sort built on a
 * guessed field shape produces a silently wrong order. It prints the raw
 * metadata, the `credits` values exactly as they arrive, and which fields vary
 * between entries.
 *
 * Usage:
 *   node scripts/manual/models.mjs            # dump + field census
 *   node scripts/manual/models.mjs --ttl      # also measure the adapter cache
 *
 * Requires a built `lib/`: run `pnpm run build` first.
 */

import { WorkbuddyLlmAdapter, WORKBUDDY_PROVIDER } from '../../lib/host/llm-adapter.js'
import { WorkbuddyClient } from '../../lib/host/workbuddy-client.js'
import { resolveGateway, describeGateway } from './gateway.mjs'

const gateway = resolveGateway()
describeGateway(gateway)

let gatewayHits = 0
const realFetch = globalThis.fetch
const countingFetch = async (input, init) => {
  const path = new URL(typeof input === 'string' ? input : input.toString()).pathname
  if (path === '/v1/models') gatewayHits += 1
  return realFetch(input, init)
}

const client = new WorkbuddyClient({
  baseURL: gateway.baseURL,
  apiKey: gateway.apiKey,
  fetchImpl: countingFetch,
})
const adapter = new WorkbuddyLlmAdapter(client, { fetchImpl: countingFetch })

// --- raw endpoint, untouched -------------------------------------------------

const raw = await realFetch(`${gateway.baseURL}/v1/models`, {
  headers: { Authorization: `Bearer ${gateway.apiKey}` },
}).then((r) => r.json())

console.log(`\nraw /v1/models advertises ${raw.data.length} models\n`)

// --- field census ------------------------------------------------------------

const fieldCounts = new Map()
for (const entry of raw.data) {
  for (const name of Object.keys(entry)) {
    fieldCounts.set(name, (fieldCounts.get(name) ?? 0) + 1)
  }
}
console.log('field census (how many of the entries carry it):')
for (const [name, count] of [...fieldCounts.entries()].sort((a, b) => b[1] - a[1])) {
  const flag = count === raw.data.length ? '' : '   <-- NOT on every entry'
  console.log(`  ${String(count).padStart(2)}/${raw.data.length}  ${name}${flag}`)
}

// --- credits, exactly as they arrive ----------------------------------------

console.log('\ncredits, verbatim:')
for (const entry of raw.data) {
  const value = Object.hasOwn(entry, 'credits') ? entry.credits : '(absent)'
  console.log(`  ${String(entry.id).padEnd(24)} ${JSON.stringify(value)}`)
}

/**
 * A first cut at the parser, so the shape problems are visible rather than
 * assumed. Handles the two spellings seen so far plus the absent case:
 *
 *   "x0.79"          -> 0.79
 *   "x0.08 credits"  -> 0.08
 *   absent           -> undefined
 */
function parseCredits(value) {
  if (typeof value !== 'string') return undefined
  const match = /^x\s*([0-9]+(?:\.[0-9]+)?)/i.exec(value.trim())
  if (match === null) return undefined
  const parsed = Number(match[1])
  return Number.isFinite(parsed) ? parsed : undefined
}

const parsed = raw.data.map((entry) => ({
  id: String(entry.id).replace(/^cn:/, ''),
  multiplier: parseCredits(entry.credits),
}))
const unparsed = parsed.filter((m) => m.multiplier === undefined)
console.log(
  `\nparser: ${parsed.length - unparsed.length}/${parsed.length} parsed` +
    (unparsed.length > 0 ? `; unparsed -> ${unparsed.map((m) => m.id).join(', ')}` : ''),
)

console.log('\nsorted cheapest-first as the adapter would return them:')
for (const m of [...parsed].sort((a, b) => (a.multiplier ?? Infinity) - (b.multiplier ?? Infinity))) {
  console.log(`  x${(m.multiplier ?? NaN).toFixed(2).padStart(5)}  ${m.id}`)
}

// --- what the adapter currently returns --------------------------------------

const viaAdapter = await adapter.listModels(WORKBUDDY_PROVIDER)
console.log(`\nadapter returned ${viaAdapter.length} models (gateway hits so far: ${gatewayHits})`)
console.log(`  first: ${viaAdapter[0]?.id}`)
console.log(`  gateway order, not sorted: ${viaAdapter.map((m) => m.id).join(', ')}`)

// --- cache behaviour ---------------------------------------------------------

if (process.argv.includes('--ttl')) {
  const probe = async (label) => {
    const started = Date.now()
    const models = await adapter.listModels(WORKBUDDY_PROVIDER)
    console.log(
      `  ${label.padEnd(24)} ${models.length} models | ${String(Date.now() - started).padStart(4)} ms | gateway hits = ${gatewayHits}`,
    )
  }
  console.log('\ncache behaviour:')
  await probe('immediately again')
  console.log('  waiting 62 s for the 60 s TTL to lapse ...')
  await new Promise((r) => setTimeout(r, 62_000))
  await probe('after TTL')
  await probe('again after TTL')
}
