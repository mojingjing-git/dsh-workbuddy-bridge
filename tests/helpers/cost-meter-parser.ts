/**
 * Load the **real** `parseWorkBuddyCredits` from an installed dsh-cost-meter.
 *
 * The bug this guards against was not a broken function — it was a payload of
 * the wrong shape, produced by code whose tests asserted against its own
 * converter. Only the consumer's parser can catch that, so the tests feed it
 * the real one wherever it can be found.
 *
 * Resolution order:
 *
 *   1. `DSH_COST_METER_PATH` — an explicit path to a `dsh-cost-meter` directory
 *   2. every `~/.dsh/profiles/<profile>/node_modules/dsh-cost-meter`
 *
 * dsh-cost-meter is a DSH plugin, not an npm package this repository can depend
 * on, so it may legitimately be absent — on a CI box, or on a machine that has
 * never run DSH. When it is absent the caller is expected to say so loudly
 * rather than pretend the contract was checked.
 */

import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Relative path of the parser inside the package. */
const PARSER_RELATIVE = 'lib/gateway-quota-adapters.js'

export type WorkbuddyParserOutcome = {
  status: string
  message: string
  accounts: Array<{
    authIndex: unknown
    status: string
    message: string
    windows: Array<{ id?: string; percent?: number }>
    credits: {
      unit: string
      used: number | null
      remaining: number | null
      limit: number | null
      fetchedAt: string
      packages: Array<{ id: string; label: string }>
    } | null
  }>
  [key: string]: unknown
}

export type WorkbuddyParser = (payload: unknown) => WorkbuddyParserOutcome

export interface ResolvedParser {
  parse: WorkbuddyParser
  /** Where it was found, for the test output. */
  path: string
  /** True when this is the real installed parser rather than a stand-in. */
  installed: true
}

export interface MissingParser {
  installed: false
  /** Candidate paths that were tried, for an actionable failure message. */
  tried: string[]
}

function candidateDirs(): string[] {
  const dirs: string[] = []
  const explicit = process.env.DSH_COST_METER_PATH
  if (typeof explicit === 'string' && explicit.trim() !== '') dirs.push(explicit.trim())

  const profiles = join(homedir(), '.dsh', 'profiles')
  try {
    for (const entry of readdirSync(profiles, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(join(profiles, entry.name, 'node_modules', 'dsh-cost-meter'))
    }
  } catch {
    // No DSH profile on this machine; the explicit path is the only option.
  }
  return dirs
}

/** Resolve the installed parser, or report why it could not be found. */
export async function resolveWorkbuddyParser(): Promise<ResolvedParser | MissingParser> {
  const tried: string[] = []
  for (const dir of candidateDirs()) {
    const file = join(dir, PARSER_RELATIVE)
    tried.push(file)
    if (!existsSync(file)) continue
    const mod = (await import(pathToFileURL(file).href)) as {
      parseWorkBuddyCredits?: WorkbuddyParser
    }
    if (typeof mod.parseWorkBuddyCredits !== 'function') continue
    return { parse: mod.parseWorkBuddyCredits, path: file, installed: true }
  }
  return { installed: false, tried }
}
