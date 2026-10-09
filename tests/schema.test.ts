import { describe, expect, it } from 'vitest'
import { Config } from '../src/host/schema.js'

describe('Config schema', () => {
  it('accepts a minimal cn route with default baseURL', () => {
    const parsed = Config.parse({
      providers: { workbuddy: { apiKeyEnv: 'WB2API_API_KEY' } },
    })
    expect(parsed.providers.workbuddy?.baseURL).toBe('http://127.0.0.1:7863')
    expect(parsed.providers.workbuddy?.realm).toBe('cn')
  })

  it('rejects an empty apiKeyEnv', () => {
    expect(() =>
      Config.parse({ providers: { workbuddy: { apiKeyEnv: '' } } }),
    ).toThrow()
  })

  it('rejects a malformed baseURL', () => {
    expect(() =>
      Config.parse({
        providers: { workbuddy: { apiKeyEnv: 'X', baseURL: 'not-a-url' } },
      }),
    ).toThrow()
  })

  it('accepts realm=global', () => {
    const parsed = Config.parse({
      providers: { workbuddy: { apiKeyEnv: 'X', realm: 'global' } },
    })
    expect(parsed.providers.workbuddy?.realm).toBe('global')
  })

  it('rejects an unknown realm', () => {
    expect(() =>
      Config.parse({
        providers: { workbuddy: { apiKeyEnv: 'X', realm: 'japan' } },
      }),
    ).toThrow()
  })

  it('tolerates a missing workbuddy route (volatile default {})', () => {
    const parsed = Config.parse({})
    expect(parsed.providers.workbuddy).toBeUndefined()
  })
})
