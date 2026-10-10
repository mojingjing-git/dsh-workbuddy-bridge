import { describe, expect, it } from 'vitest'
import { Config } from '../src/host/schema.js'

/**
 * A schemastery schema is called directly — `Config(input)` — and returns its
 * normalized output. There is no `.parse()`; that was zod's API, and this file
 * previously used it.
 */
describe('Config schema', () => {
  it('accepts a minimal cn route with default baseURL', () => {
    const parsed = Config({ providers: { workbuddy: { apiKeyEnv: 'WB2API_API_KEY' } } })
    expect(parsed.providers.workbuddy?.baseURL).toBe('http://127.0.0.1:7863')
    expect(parsed.providers.workbuddy?.realm).toBe('cn')
  })

  it('rejects an empty apiKeyEnv', () => {
    expect(() => Config({ providers: { workbuddy: { apiKeyEnv: '' } } })).toThrow()
  })

  it('rejects a baseURL with no scheme', () => {
    expect(() =>
      Config({ providers: { workbuddy: { apiKeyEnv: 'X', baseURL: '127.0.0.1:7863' } } }),
    ).toThrow()
  })

  it('accepts realm=global at the schema level', () => {
    // The schema accepts it so a future version can honour it; the adapter
    // refuses it at every entry point while this gateway has no global
    // accounts. Both halves are asserted, in their own places.
    const parsed = Config({ providers: { workbuddy: { apiKeyEnv: 'X', realm: 'global' } } })
    expect(parsed.providers.workbuddy?.realm).toBe('global')
  })

  it('rejects an unknown realm', () => {
    // TypeScript already rejects `'japan'` statically, which is the stronger
    // guarantee. The cast exists so this also covers the runtime path: config
    // arrives as parsed YAML, so nothing has type-checked it by the time the
    // schema sees it.
    expect(() =>
      Config({ providers: { workbuddy: { apiKeyEnv: 'X', realm: 'japan' } } } as never),
    ).toThrow()
  })

  it('leaves workbuddy undefined when no route is configured', () => {
    // Load-bearing for the mount path: `apply()` treats an undefined route as
    // "not configured yet" and mounts only a thin shell. A schema that filled
    // in a default profile here would make the plugin try to reach a gateway
    // the user never named.
    const parsed = Config({})
    expect(parsed.providers.workbuddy).toBeUndefined()
  })

  it('survives an absent top-level argument', () => {
    const parsed = Config(undefined)
    expect(parsed.providers.workbuddy).toBeUndefined()
  })

  it('drops an omitted optional field rather than inventing one', () => {
    const parsed = Config({ providers: { workbuddy: { apiKeyEnv: 'X' } } })
    expect(parsed.providers.workbuddy?.apiKey).toBeUndefined()
  })
})
