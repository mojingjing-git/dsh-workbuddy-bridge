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

  it('defaults the management port so the cost-meter endpoint is stable', () => {
    const parsed = Config({ providers: { workbuddy: { apiKeyEnv: 'X' } } })
    expect(parsed.providers.workbuddy?.managementPort).toBe(7710)
  })

  it('rejects a management port outside the usable range', () => {
    // Caught here rather than at listen(), where it would surface as an opaque
    // EACCES/EADDRINUSE after the mount had already begun.
    expect(() => Config({ providers: { workbuddy: { apiKeyEnv: 'X', managementPort: 70000 } } })).toThrow()
    expect(() => Config({ providers: { workbuddy: { apiKeyEnv: 'X', managementPort: -1 } } })).toThrow()
  })

  it('does not advertise an apiKey field to the settings surface', () => {
    // The field was removed on purpose: a literal key in the schema means the
    // Models page offers a box to paste a plaintext secret into, and it lands
    // in cordis.patch.yml and the profile directory.
    //
    // Asserted on the projected *field names* rather than on the serialized
    // blob, which would also match the `apiKeyEnv` field this schema does have.
    const projected = Config.toJSON() as { refs?: Record<string, { dict?: Record<string, number> }> }
    const fieldNames = Object.values(projected.refs ?? {}).flatMap((node) =>
      Object.keys(node.dict ?? {}),
    )
    expect(fieldNames).toContain('apiKeyEnv')
    expect(fieldNames).not.toContain('apiKey')
  })

  it('cannot strip an undeclared apiKey, which is why apply() ignores it', () => {
    // This asserts the schemastery behaviour that makes the check in `apply()`
    // necessary rather than optional. Verified against
    // @deepseek-ai/schemastery 3.18.4: object schemas pass undeclared keys
    // through, and there is no `.strict()`, `.loose()`, or `.extra()` that
    // changes it.
    //
    // If this expectation ever flips — a future schemastery that strips unknown
    // keys — the belt-and-braces check in `apply()` becomes redundant, and this
    // failing test is how anyone would find that out.
    const parsed = Config({
      providers: { workbuddy: { apiKeyEnv: 'X', apiKey: 'sk-plaintext-should-not-survive' } },
    })
    expect(JSON.stringify(parsed)).toContain('sk-plaintext-should-not-survive')
  })
})
