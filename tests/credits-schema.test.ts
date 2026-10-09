import { describe, expect, it } from 'vitest'
import { adaptWb2apiStatusToWorkbuddyCredits } from '../src/shared/credits-schema.js'

describe('adaptWb2apiStatusToWorkbuddyCredits', () => {
  it('returns empty accounts when input is not an object', () => {
    const out = adaptWb2apiStatusToWorkbuddyCredits(null, '2026-10-10T00:00:00Z')
    expect(out.accounts).toEqual([])
  })

  it('returns empty accounts when accounts field is missing', () => {
    const out = adaptWb2apiStatusToWorkbuddyCredits({}, '2026-10-10T00:00:00Z')
    expect(out.accounts).toEqual([])
  })

  it('maps credits and credits_total correctly', () => {
    // Synthetic inputs. The values are round numbers that keep the
    // `used = total - remaining` arithmetic checkable by eye; no real
    // account figures belong in this repository.
    const out = adaptWb2apiStatusToWorkbuddyCredits(
      {
        accounts: [
          { uid: 'secret-uid', nickname: 'PII-NAME', credits: 3000, credits_total: 4000 },
          { uid: 'secret-uid-2', nickname: 'PII-NAME-2', credits: 1500, credits_total: 2000 },
        ],
      },
      '2030-01-01T00:00:00Z',
    )
    expect(out.accounts).toEqual([
      {
        authIndex: 0,
        credits: {
          unit: 'credits',
          used: 1000,
          remaining: 3000,
          limit: 4000,
          fetchedAt: '2030-01-01T00:00:00Z',
          packages: [],
        },
      },
      {
        authIndex: 1,
        credits: {
          unit: 'credits',
          used: 500,
          remaining: 1500,
          limit: 2000,
          fetchedAt: '2030-01-01T00:00:00Z',
          packages: [],
        },
      },
    ])
  })

  it('MUST NOT include uid or nickname (PII)', () => {
    // This is the load-bearing property for dsh-cost-meter compatibility
    // (M08 evidence: "nickname/uid 是 PII，绝不复制进输出").
    const out = adaptWb2apiStatusToWorkbuddyCredits(
      {
        accounts: [{ uid: 'secret-uid', nickname: 'real name', credits: 1, credits_total: 2 }],
      },
      '2030-01-01T00:00:00Z',
    )
    const text = JSON.stringify(out)
    expect(text).not.toContain('secret-uid')
    expect(text).not.toContain('real name')
    expect(text).not.toContain('uid')
    expect(text).not.toContain('nickname')
  })

  it('handles missing credits_total by leaving used null', () => {
    const out = adaptWb2apiStatusToWorkbuddyCredits(
      { accounts: [{ credits: 100 }] },
      '2026-10-10T00:00:00Z',
    )
    expect(out.accounts[0]?.credits.used).toBe(null)
    expect(out.accounts[0]?.credits.remaining).toBe(100)
    expect(out.accounts[0]?.credits.limit).toBe(null)
  })

  it('handles missing credits field by leaving all null', () => {
    const out = adaptWb2apiStatusToWorkbuddyCredits(
      { accounts: [{}] },
      '2026-10-10T00:00:00Z',
    )
    expect(out.accounts[0]?.credits.remaining).toBe(null)
    expect(out.accounts[0]?.credits.limit).toBe(null)
    expect(out.accounts[0]?.credits.used).toBe(null)
  })

  it('skips rows that are not objects', () => {
    const out = adaptWb2apiStatusToWorkbuddyCredits(
      { accounts: [null, 'string', [], { credits: 1, credits_total: 2 }] },
      '2026-10-10T00:00:00Z',
    )
    expect(out.accounts.length).toBe(1)
    expect(out.accounts[0]?.credits.remaining).toBe(1)
  })

  it('uses caller-supplied fetchedAt (does not fabricate timestamp)', () => {
    // The dsh-cost-meter parser is explicit (M08 evidence): "fetchedAt
    // 缺失置空串, 绝不用请求时刻顶替".
    const out = adaptWb2apiStatusToWorkbuddyCredits(
      { accounts: [{ credits: 100, credits_total: 200 }] },
      '1999-01-01T00:00:00Z',
    )
    expect(out.accounts[0]?.credits.fetchedAt).toBe('1999-01-01T00:00:00Z')
  })
})
