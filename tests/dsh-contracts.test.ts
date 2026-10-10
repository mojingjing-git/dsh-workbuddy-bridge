/**
 * The two DSH contracts the adapter was silently violating.
 *
 * Both were invisible from inside the plugin: one because a wrong header still
 * gets an answer, the other because a discarded error code still produces an
 * error. Neither breaks a conversation, which is exactly why neither was
 * noticed until a review read the runtime's normalization code.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { attributionHeaders, attributionUserAgent } from '../src/host/attribution.js'
import { WorkbuddyLlmError } from '../src/host/llm-adapter.js'
import { PLUGIN_NAME, PLUGIN_VERSION } from '../src/shared/constants.js'

describe('attribution headers', () => {
  it('carries a user-agent that names the harness, not `node`', () => {
    // The symptom this fixes: DSH's own requests arrived at the gateway as
    // `deepseek-harness/0.2.0-rc.2 (+https://github.com/deepseek-ai/deepseek-harness)`
    // while this plugin's arrived as `node` — undici's default, which names
    // nothing and defeats the point of an attribution header.
    const ua = attributionUserAgent()
    expect(ua).not.toBe('node')
    expect(ua).toContain('deepseek-harness')
    expect(ua).toContain('https://github.com/deepseek-ai/deepseek-harness')
  })

  it('names this plugin, so the traffic is not just "some harness"', () => {
    expect(attributionUserAgent()).toContain(`${PLUGIN_NAME}/${PLUGIN_VERSION}`)
  })

  it('uses lowercase header names, matching attributionHeaders()', () => {
    expect(Object.keys(attributionHeaders())).toEqual(['user-agent'])
  })

  it('reports the pinned application version when one is supplied', () => {
    const previous = process.env.DSH_APP_VERSION
    process.env.DSH_APP_VERSION = '9.9.9-test'
    try {
      expect(attributionUserAgent()).toContain('deepseek-harness/9.9.9-test')
    } finally {
      if (previous === undefined) delete process.env.DSH_APP_VERSION
      else process.env.DSH_APP_VERSION = previous
    }
  })

  it('refuses a version that could inject a second header value', () => {
    const previous = process.env.DSH_APP_VERSION
    // A newline is the one that matters: it would split the header on the wire.
    process.env.DSH_APP_VERSION = '1.0\nX-Evil: 1'
    try {
      const ua = attributionUserAgent()
      expect(ua).not.toContain('\n')
      expect(ua).not.toContain('X-Evil')
      // Falls back to the versionless product token.
      expect(ua.startsWith('deepseek-harness ')).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.DSH_APP_VERSION
      else process.env.DSH_APP_VERSION = previous
    }
  })

  it('keeps PLUGIN_VERSION equal to the package version', () => {
    // A header reporting a version the package does not have is worse than one
    // reporting none, and constants drift silently.
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      version: string
    }
    expect(PLUGIN_VERSION).toBe(pkg.version)
  })
})

describe('WorkbuddyLlmError failure snapshot', () => {
  it('exposes code as an own property the runtime can read', () => {
    // `ownErrorCode` uses Object.getOwnPropertyDescriptor(error, 'code'), so an
    // inherited or prototype-level code is invisible to the runtime.
    const error = new WorkbuddyLlmError('boom', 'PROVIDER_HTTP')
    expect(Object.getOwnPropertyDescriptor(error, 'code')?.value).toBe('PROVIDER_HTTP')
  })

  it('exposes failure as an own property holding a frozen snapshot', () => {
    // `ownFailureSnapshot` reads Object.getOwnPropertyDescriptor(error, 'failure').
    const error = new WorkbuddyLlmError('boom', 'PROVIDER_HTTP')
    const descriptor = Object.getOwnPropertyDescriptor(error, 'failure')
    expect(descriptor).toBeDefined()
    expect(Object.isFrozen(descriptor?.value)).toBe(true)
  })

  it('keeps failure.code equal to code, which is the runtime\'s condition', () => {
    // The runtime's escape hatch is:
    //
    //   const carried = ownFailureSnapshot(error)
    //   if (carried !== undefined && carried.code === ownErrorCode(error)) return carried
    //   return { message: errorMessage(error), code: harnessErrorCode(error) }   // -> "UNKNOWN"
    //
    // `harnessErrorCode` is `error instanceof HarnessError ? error.code : 'UNKNOWN'`,
    // and this class cannot extend HarnessError. So equality here is the entire
    // difference between the plugin's own code and UNKNOWN.
    for (const code of ['PROVIDER_HTTP', 'STREAM_TRUNCATED', 'CALL_CANCELLED', 'FETCH_FAILED']) {
      const error = new WorkbuddyLlmError('boom', code)
      expect(error.failure.code).toBe(error.code)
      expect(error.failure.code).toBe(code)
    }
  })

  it('carries the message and an optional status into the snapshot', () => {
    const error = new WorkbuddyLlmError('workbuddy: HTTP 429 slow down', 'PROVIDER_HTTP', {
      status: 429,
    })
    expect(error.failure.message).toBe('workbuddy: HTTP 429 slow down')
    expect(error.failure.status).toBe(429)
  })

  it('omits status rather than storing undefined for it', () => {
    const error = new WorkbuddyLlmError('boom', 'FETCH_FAILED')
    expect(Object.keys(error.failure).sort()).toEqual(['code', 'message'])
  })

  it('keeps working as an ordinary Error for callers that only log it', () => {
    const error = new WorkbuddyLlmError('boom', 'FETCH_FAILED')
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('boom')
    expect(error.name).toBe('WorkbuddyLlmError')
  })
})
