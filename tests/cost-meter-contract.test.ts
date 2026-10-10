/**
 * The workbuddy credit payload, checked against the consumer's own parser.
 *
 * The previous version of this suite tested `adaptWb2apiStatusToWorkbuddyCredits`
 * against expectations written by reading the same file. It passed while the
 * payload was the wrong shape: `used` / `remaining` / `limit` where
 * `parseWorkBuddyCredits` reads `total_used` / `total_remain` / `total_size`.
 * Every `pickField` returned undefined, no window was built, and each account
 * came back `status: 'unknown'` — a well-formed payload that silently reported
 * nothing.
 *
 * So there are two layers here, and the order matters:
 *
 *   1. `handed to the real parser` — the assertion that can actually fail on a
 *      shape mistake. Runs whenever an installed dsh-cost-meter is findable.
 *   2. `the field names the parser reads` — a structural pin that always runs,
 *      so the contract is still asserted on a machine without DSH.
 *
 * Layer 2 is weaker by construction: it knows the names because a human read
 * them out of the parser. Layer 1 is what keeps that honest, which is why it is
 * reported loudly when it cannot run.
 */

import { describe, expect, it, beforeAll } from 'vitest'

import { adaptWb2apiStatusToWorkbuddyCredits } from '../src/shared/credits-schema.js'
import { resolveWorkbuddyParser, type ResolvedParser } from './helpers/cost-meter-parser.js'

/** A minimal wb2api /status body. Shape from a live `GET /status`. */
const STATUS = {
  accounts: [
    { uid: 'u-1', nickname: 'first', credits: 4863, credits_total: 6600 },
    { uid: 'u-2', nickname: 'second', credits: 5575, credits_total: 7465 },
  ],
}

const NOW = '2026-10-10T12:00:00+08:00'

let parser: ResolvedParser | null = null

beforeAll(async () => {
  const resolved = await resolveWorkbuddyParser()
  if (resolved.installed) {
    parser = resolved
    // Deliberately visible: a green run here means the real parser was used.
    console.log(`[cost-meter-contract] using the installed parser at ${resolved.path}`)
  } else {
    console.warn(
      '[cost-meter-contract] the installed dsh-cost-meter was NOT found, so the payload ' +
        'was not checked against the real parseWorkBuddyCredits. Set DSH_COST_METER_PATH ' +
        'to a dsh-cost-meter directory to run that check.\n  tried:\n' +
        resolved.tried.map((p) => `    ${p}`).join('\n'),
    )
  }
})

describe('adaptWb2apiStatusToWorkbuddyCredits', () => {
  it('derives used from credits_total - credits', () => {
    const payload = adaptWb2apiStatusToWorkbuddyCredits(STATUS, NOW)
    expect(payload.accounts).toHaveLength(2)
    // 6600 - 4863
    expect(payload.accounts[0]?.credits.total_used).toBe(1737)
    expect(payload.accounts[0]?.credits.total_remain).toBe(4863)
    expect(payload.accounts[0]?.credits.total_size).toBe(6600)
    // 7465 - 5575
    expect(payload.accounts[1]?.credits.total_used).toBe(1890)
  })

  it('carries fetched_at through rather than inventing one', () => {
    const payload = adaptWb2apiStatusToWorkbuddyCredits(STATUS, NOW)
    expect(payload.accounts[0]?.credits.fetched_at).toBe(NOW)
  })

  it('never lets uid or nickname cross the boundary', () => {
    const serialized = JSON.stringify(adaptWb2apiStatusToWorkbuddyCredits(STATUS, NOW))
    expect(serialized).not.toContain('u-1')
    expect(serialized).not.toContain('u-2')
    expect(serialized).not.toContain('first')
    expect(serialized).not.toContain('second')
    expect(serialized).not.toContain('uid')
    expect(serialized).not.toContain('nickname')
  })

  it('reports nulls, not zeros, when the pool size is missing', () => {
    // A zero would render as a fully-spent account rather than an unknown one.
    const payload = adaptWb2apiStatusToWorkbuddyCredits({ accounts: [{ credits: 100 }] }, NOW)
    expect(payload.accounts[0]?.credits.total_used).toBeNull()
    expect(payload.accounts[0]?.credits.total_remain).toBe(100)
    expect(payload.accounts[0]?.credits.total_size).toBeNull()
  })

  it('leaves every figure null when the account carries no credits at all', () => {
    const payload = adaptWb2apiStatusToWorkbuddyCredits({ accounts: [{}] }, NOW)
    expect(payload.accounts[0]?.credits.total_used).toBeNull()
    expect(payload.accounts[0]?.credits.total_remain).toBeNull()
    expect(payload.accounts[0]?.credits.total_size).toBeNull()
  })

  it('skips rows that are not objects and keeps each survivor\'s source index', () => {
    const payload = adaptWb2apiStatusToWorkbuddyCredits(
      { accounts: [null, 'string', [], { credits: 1, credits_total: 2 }] },
      NOW,
    )
    expect(payload.accounts).toHaveLength(1)
    // Index 3, not 0. `auth_index` is the account's identity — cost-meter joins
    // on it — so it has to be the position in wb2api's list, not the position in
    // our output. Renumbering would make a single malformed row shift the
    // identity of every account after it.
    expect(payload.accounts[0]?.auth_index).toBe(3)
    expect(payload.accounts[0]?.credits.total_remain).toBe(1)
  })

  it('returns an empty account list for a malformed body', () => {
    expect(adaptWb2apiStatusToWorkbuddyCredits(null, NOW).accounts).toEqual([])
    expect(adaptWb2apiStatusToWorkbuddyCredits({}, NOW).accounts).toEqual([])
    expect(adaptWb2apiStatusToWorkbuddyCredits({ accounts: 'nope' }, NOW).accounts).toEqual([])
  })
})

describe('the payload as the consumer reads it', () => {
  it('uses the field names parseWorkBuddyCredits reads', () => {
    // Pinned because these exact names are the bug that shipped. Provenance:
    // dsh-cost-meter@1.8.15, lib/gateway-quota-adapters.js#parseWorkBuddyCredits
    //   pickField(row, 'auth_index', 'authIndex')
    //   pickField(creditsRaw, 'total_used',   'totalUsed')
    //   pickField(creditsRaw, 'total_remain', 'totalRemain')
    //   pickField(creditsRaw, 'total_size',   'totalSize')
    //   pickField(creditsRaw, 'fetched_at',   'fetchedAt')
    const payload = adaptWb2apiStatusToWorkbuddyCredits(STATUS, NOW)
    const row = payload.accounts[0] as unknown as Record<string, unknown>

    expect(Object.keys(row)).toContain('auth_index')
    expect(row).not.toHaveProperty('authIndex')

    const credits = row.credits as Record<string, unknown>
    expect(Object.keys(credits).sort()).toEqual(
      ['fetched_at', 'packages', 'total_remain', 'total_size', 'total_used'].sort(),
    )
    // The parser's *output* names must not appear on the wire.
    expect(credits).not.toHaveProperty('used')
    expect(credits).not.toHaveProperty('remaining')
    expect(credits).not.toHaveProperty('limit')
    expect(credits).not.toHaveProperty('fetchedAt')
    expect(credits).not.toHaveProperty('unit')
  })
})

describe('handed to the real parseWorkBuddyCredits', () => {
  it('produces an ok account with a rendered window', () => {
    if (parser === null) {
      // Loudly skipped rather than silently green: the structural test above
      // ran, but only the real parser proves the shape is readable.
      console.warn('[cost-meter-contract] SKIPPED: no installed parser available')
      return
    }
    const payload = adaptWb2apiStatusToWorkbuddyCredits(STATUS, NOW)
    const parsed = parser.parse(payload)

    expect(parsed.accounts).toHaveLength(2)
    for (const account of parsed.accounts) {
      // 'unknown' here is exactly the old failure: no signal was readable.
      expect(account.status).toBe('ok')
      expect(account.message).toBe('')
      expect(account.credits).not.toBeNull()
    }

    const first = parsed.accounts[0]
    expect(first?.authIndex).toBe(0)
    expect(first?.credits?.used).toBe(1737)
    expect(first?.credits?.remaining).toBe(4863)
    expect(first?.credits?.limit).toBe(6600)
    expect(first?.credits?.fetchedAt).toBe(NOW)

    // A window is the thing the panel actually renders, and it is only built
    // when total_size > 0 and total_used is known.
    expect(first?.windows).toHaveLength(1)
  })

  it('reads the account index so rows join to discovered accounts', () => {
    if (parser === null) return
    const parsed = parser.parse(adaptWb2apiStatusToWorkbuddyCredits(STATUS, NOW))
    expect(parsed.accounts.map((a) => a.authIndex)).toEqual([0, 1])
  })

  it('keeps a missing pool size as unknown rather than fully spent', () => {
    if (parser === null) return
    const parsed = parser.parse(
      adaptWb2apiStatusToWorkbuddyCredits({ accounts: [{ credits: 100 }] }, NOW),
    )
    const account = parsed.accounts[0]
    // No total → no window → 'unknown'. Crucially not 'ok' with 0%.
    expect(account?.status).toBe('unknown')
    expect(account?.windows).toEqual([])
  })
})
