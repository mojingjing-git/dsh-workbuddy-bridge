import { describe, expect, it } from 'vitest'
import { parseModelId } from '../src/host/llm-adapter.js'

describe('parseModelId', () => {
  it('accepts bare ids (default CN)', () => {
    const r = parseModelId('glm-5.2')
    expect(r.ok).toBe(true)
    expect(r.wireId).toBe('glm-5.2')
    expect(r.realm).toBe(null)
    expect(r.hasRealmPrefix).toBe(false)
  })

  it('accepts lowercase cn: prefix', () => {
    const r = parseModelId('cn:glm-5.2')
    expect(r.ok).toBe(true)
    expect(r.wireId).toBe('glm-5.2')
    expect(r.realm).toBe('cn')
    expect(r.hasRealmPrefix).toBe(true)
  })

  it('accepts lowercase global: prefix', () => {
    const r = parseModelId('global:gpt-5')
    expect(r.ok).toBe(true)
    expect(r.wireId).toBe('gpt-5')
    expect(r.realm).toBe('global')
    expect(r.hasRealmPrefix).toBe(true)
  })

  // M05 evidence: cH:glm-5.2 is rejected upstream (HTTP 400 11102). The
  // plugin must reject it client-side too — letting it through means a
  // user sees an opaque upstream error rather than our own actionable
  // message.
  it('rejects mixed-case cH: prefix', () => {
    const r = parseModelId('cH:glm-5.2')
    expect(r.ok).toBe(false)
    expect(r.rejection?.code).toBe('PROVIDER_REJECTED_CASE')
    expect(r.rejection?.message).toContain('cH:glm-5.2')
  })

  it('rejects uppercase CN: prefix', () => {
    const r = parseModelId('CN:glm-5.2')
    expect(r.ok).toBe(false)
    expect(r.rejection?.code).toBe('PROVIDER_REJECTED_CASE')
  })

  it('rejects uppercase GLOBAL: prefix', () => {
    const r = parseModelId('GLOBAL:gpt-5')
    expect(r.ok).toBe(false)
    expect(r.rejection?.code).toBe('PROVIDER_REJECTED_CASE')
  })

  it('rejects empty-looking prefix', () => {
    const r = parseModelId(':foo')
    expect(r.ok).toBe(false)
    expect(r.rejection?.code).toBe('PROVIDER_REJECTED_CASE')
  })

  it('rejects unknown vendor prefix', () => {
    const r = parseModelId('openai:gpt-5')
    expect(r.ok).toBe(false)
    expect(r.rejection?.code).toBe('PROVIDER_REJECTED_CASE')
    // The message must name the actual id so users can copy-paste a fix.
    expect(r.rejection?.message).toContain('openai:gpt-5')
  })

  it('accepts ids with colons internally when the prefix is exact', () => {
    // Real example: not present in v1.13 catalog, but the rule should be
    // forward-compatible.
    const r = parseModelId('cn:foo:bar')
    expect(r.ok).toBe(true)
    expect(r.wireId).toBe('foo:bar')
    expect(r.realm).toBe('cn')
  })
})
