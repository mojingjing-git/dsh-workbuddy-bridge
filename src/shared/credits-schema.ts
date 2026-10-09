/**
 * The credit-payload schema dsh-cost-meter@1.8.15 expects for the workbuddy
 * provider (M08 evidence: `lib/gateway-quota-adapters.js#parseWorkBuddyCredits`).
 *
 * This is the **only** type wb2api `/status` data crosses — we never let the
 * raw wb2api shape through, and we never include PII (uid, nickname) in the
 * response, even though wb2api's own /status carries it.
 *
 * Plan reference: V2.2.1 §6.2 (balance observation), M08 evidence §"响应 schema".
 */

export interface WorkbuddyPackageCredits {
  /** Stable package id derived from package name + index (e.g. "pkg-trial-0"). */
  id: string
  /** Human-readable label, exactly as wb2api returned. */
  label: string
  /** Credits already used in the current cycle (null = unknown). */
  used: number | null
  /** Credits still available in the current cycle (null = unknown). */
  remaining: number | null
  /** Total credits allotted for the cycle (null = unknown). */
  limit: number | null
  /** ISO 8601 cycle start, or empty string if not reported. */
  startsAt: string
  /** ISO 8601 cycle end, or empty string if not reported. */
  resetsAt: string
}

export interface WorkbuddyAccountCredits {
  /**
   * Account index, stable for the lifetime of the wb2api `auths/` directory.
   * We use the array index (0, 1, 2, ...) because the wb2api uid is PII
   * (the dsh-cost-meter parser is explicit: "nickname/uid 是 PII,
   * 绝不复制进输出").
   */
  authIndex: number
  /** Credits block: derived from wb2api `credits` + `credits_total`. */
  credits: {
    unit: 'credits'
    used: number | null
    remaining: number | null
    limit: number | null
    /** ISO 8601 timestamp; empty string if not reported. */
    fetchedAt: string
    packages: WorkbuddyPackageCredits[]
  }
}

export interface WorkbuddyCreditsPayload {
  accounts: WorkbuddyAccountCredits[]
}

/**
 * Adapt one wb2api `/status` response to the dsh-cost-meter contract.
 *
 * - Never include `uid` / `nickname` (PII).
 * - The wb2api `credits` field is the *remaining* balance; the *used* amount
 *   is `credits_total - credits` (or null when `credits_total` is missing).
 * - `packages[]` is left empty in V1 because wb2api v1.13 does not return
 *   per-package rollups; this is P1-known and tracked for P3.
 *
 * @param status - the JSON object returned by `GET /status`
 * @param now    - ISO 8601 timestamp injected by the caller (so the
 *                 "fetchedAt" reflects when **we** observed it, not when
 *                 the parser runs).
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

    const creditsRaw = r.credits
    const totalRaw = r.credits_total
    const credits = typeof creditsRaw === 'number' ? creditsRaw : null
    const total = typeof totalRaw === 'number' ? totalRaw : null
    const used = credits !== null && total !== null ? Math.max(0, total - credits) : null

    out.push({
      authIndex: i,
      credits: {
        unit: 'credits',
        used,
        remaining: credits,
        limit: total,
        fetchedAt: now,
        packages: [],
      },
    })
  }
  return { accounts: out }
}
