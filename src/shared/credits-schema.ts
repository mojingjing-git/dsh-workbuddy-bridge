/**
 * The credit payload dsh-cost-meter reads for the workbuddy provider.
 *
 * Source of truth: `dsh-cost-meter@1.8.15`,
 * `lib/gateway-quota-adapters.js#parseWorkBuddyCredits`.
 *
 * ## The mistake this file used to make
 *
 * The parser reads **`total_*`** names off the wire and then builds an
 * internal `{used, remaining, limit}` object:
 *
 *     const totalUsed   = toInt(pickField(creditsRaw, 'total_used',   'totalUsed'))
 *     const totalRemain = toInt(pickField(creditsRaw, 'total_remain', 'totalRemain'))
 *     const totalSize   = toInt(pickField(creditsRaw, 'total_size',   'totalSize'))
 *     …
 *     const credits = { unit: 'credits', used: totalUsed, remaining: totalRemain, limit: totalSize, … }
 *
 * This module previously emitted `{used, remaining, limit}` — the parser's
 * *output* names — so every `pickField` returned undefined, `totalUsed` and
 * `totalSize` stayed null, no window was produced, and each account came back
 * `status: 'unknown'` with the message "无使用信号,额度状态未知(不视为耗尽)".
 * The balance panel would have shown nothing, and nothing would have errored:
 * the payload was well-formed JSON of the wrong shape.
 *
 * Its tests passed because they asserted against this module's own converter
 * rather than the consumer's parser. The tests here now call the real
 * `parseWorkBuddyCredits`, which is the only assertion that could have caught it.
 *
 * ## Shape
 *
 * Wire (what we send):
 *
 *     { accounts: [ { auth_index, credits: {
 *         total_used, total_remain, total_size, fetched_at,
 *         packages: [ { name, used, remain, size, cycle_start, cycle_end } ] } } ] }
 *
 * Note the asymmetry: the top level is `total_*`, but each package is
 * `used` / `remain` / `size`. That is the parser's reading, not a typo.
 *
 * ## Privacy
 *
 * wb2api's `/status` carries `uid` and `nickname` per account. Neither crosses
 * this boundary: `auth_index` is the array index, which is what the parser
 * keys on and what cost-meter displays.
 *
 * Plan reference: V2.2.1 §6.2, M08 evidence.
 */

/** One package inside an account's credit block, in the parser's input names. */
export interface WorkbuddyPackageCredits {
  /** Package label, exactly as wb2api returned it. */
  name: string
  /** Credits used in the current cycle (null = unknown). */
  used: number | null
  /** Credits still available (null = unknown). */
  remain: number | null
  /** Credits allotted for the cycle (null = unknown). */
  size: number | null
  /** ISO 8601 cycle start, or empty string if not reported. */
  cycle_start: string
  /** ISO 8601 cycle end, or empty string if not reported. */
  cycle_end: string
}

export interface WorkbuddyAccountCredits {
  /**
   * Position of the account in wb2api's own `accounts` array.
   *
   * The position in the source list, **not** the position in the emitted list:
   * cost-meter joins this against its own discovered accounts, so it is an
   * identity rather than a row number. Renumbering after a skipped row would
   * shift the identity of every account after it.
   *
   * The wb2api uid is PII and never leaves the host, so this index is the only
   * identifier that crosses.
   */
  auth_index: number
  credits: {
    total_used: number | null
    total_remain: number | null
    total_size: number | null
    /** ISO 8601 timestamp; empty string if not reported. */
    fetched_at: string
    packages: WorkbuddyPackageCredits[]
  }
}

export interface WorkbuddyCreditsPayload {
  accounts: WorkbuddyAccountCredits[]
}

/**
 * Adapt one wb2api `/status` response to the payload cost-meter parses.
 *
 * wb2api reports **remaining** in `credits` and the pool size in
 * `credits_total`; the used amount is the difference. Both must be present
 * before a used figure is claimed — reporting `0` for a missing field would
 * render as a fully-spent account rather than an unknown one.
 *
 * Per-package rollups are reported as empty: wb2api v1.13 returns an account
 * pool without a package breakdown, and an invented breakdown is worse than
 * none.
 *
 * @param status - the JSON object returned by `GET /status`
 * @param now    - ISO 8601 timestamp supplied by the caller, so `fetched_at`
 *                 records when **we** observed the balance rather than when the
 *                 parser happened to run. The consumer deliberately does not
 *                 substitute its own clock for a missing `fetched_at`.
 */
export function adaptWb2apiStatusToWorkbuddyCredits(
  status: unknown,
  now: string,
): WorkbuddyCreditsPayload {
  if (status === null || typeof status !== 'object') {
    return { accounts: [] }
  }
  const s = status as { accounts?: unknown }
  if (!Array.isArray(s.accounts)) {
    return { accounts: [] }
  }

  const out: WorkbuddyAccountCredits[] = []
  for (let i = 0; i < s.accounts.length; i++) {
    const row = s.accounts[i]
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
    const r = row as Record<string, unknown>

    const remainingRaw = r.credits
    const totalRaw = r.credits_total
    const remaining = typeof remainingRaw === 'number' ? remainingRaw : null
    const total = typeof totalRaw === 'number' ? totalRaw : null
    const used = remaining !== null && total !== null ? Math.max(0, total - remaining) : null

    out.push({
      auth_index: i,
      credits: {
        total_used: used,
        total_remain: remaining,
        total_size: total,
        fetched_at: now,
        packages: [],
      },
    })
  }
  return { accounts: out }
}
