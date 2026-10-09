/**
 * Plugin configuration schema.
 *
 * Plan reference: V2.2.1 §3.2, §6.2, M02 evidence (`Config` shape).
 *
 * The user stores ONE provider route `workbuddy` pointing at their local
 * wb2api process. Because the route set is structurally a single key
 * (a user can only attach to one wb2api at a time), we model it as
 * `providers: { workbuddy: {…} }` so the shape mirrors dsh-llm-pi-ai.
 *
 * Note: dsh-llm-pi-ai uses `@deepseek-ai/schemastery` which has
 * `.volatile()` to mark sections that should re-run the apply effects
 * on change without a plugin restart. We use plain `zod` (peer-friendly)
 * and let the host's `ctx.on('loader/volatile-update', …)` mechanism
 * (M02 evidence, line 310) treat the whole `providers` object as
 * volatile by convention.
 */

import { z } from 'zod'

export const Realm = z.enum(['cn', 'global'])

export const WorkbuddyProviderConfig = z.object({
  /** Environment variable name holding the wb2api API key. */
  apiKeyEnv: z.string().min(1),
  /** Base URL of the user's running wb2api (default port 7863). */
  baseURL: z
    .string()
    .url()
    .default('http://127.0.0.1:7863'),
  /** Active realm. V1: `cn` only; `global` is wired but not exercised in P1. */
  realm: Realm.default('cn'),
  /**
   * Optional override of the API key value (used in unit tests where no
   * credential service is wired). When both `apiKeyEnv` and `apiKey` are
   * set, `apiKey` wins. Production users should prefer `apiKeyEnv`.
   */
  apiKey: z.string().min(1).optional(),
})

export const Config = z.object({
  providers: z
    .object({
      workbuddy: WorkbuddyProviderConfig.optional(),
    })
    .default({}),
})

export type WorkbuddyConfig = z.infer<typeof Config>
export type WorkbuddyProviderConfig = z.infer<typeof WorkbuddyProviderConfig>
export type Realm = z.infer<typeof Realm>
