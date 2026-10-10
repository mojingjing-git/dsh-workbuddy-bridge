/**
 * Plugin configuration schema.
 *
 * ## Why schemastery and not zod
 *
 * The loader projects a plugin's `Config` export into the settings surface, and
 * it only understands `@deepseek-ai/schemastery`. A zod schema is reported as
 * `status: "unsupported"` by the host's Config inspector — which is exactly
 * what happened on the first real install — and an unsupported schema means the
 * Models page gets no editor and no "discover models" affordance for this
 * route, which is the plugin's main reason to exist.
 *
 * ## Why `z.dict` and not a fixed key
 *
 * `z.object({ workbuddy: Profile })` makes the field **required**: an empty
 * config throws `$.providers.workbuddy.apiKeyEnv missing required value`, so the
 * plugin could never mount before the user had configured a route. Verified
 * against schemastery 3.18.4; `.required(false)` on the inner schema does not
 * change it. `z.dict(...)` yields `undefined` for an absent key, which is the
 * behaviour `apply()` needs, and it is the same shape `dsh-llm-pi-ai` uses
 * (`providers: z.dict(profile).default({}).volatile()`).
 *
 * ## Other schemastery differences from zod
 *
 *   - `.required()` rather than `.optional()`; a bare `z.string()` is already
 *     omissible and simply drops out of the normalized output.
 *   - No `z.enum`; a closed set is `z.union([z.const('a'), z.const('b')])`.
 *   - `.default(v)` supplies the fallback for absent input and makes the output
 *     definite.
 *
 * `.volatile()` is deliberately not used. It would let the loader re-read this
 * subtree on change without a restart, but it wraps the value in a `Volatile<>`
 * accessor, and v0.2 mounts once per process. A config change needs a restart;
 * that is recorded in the README rather than hidden here.
 */

import z from '@deepseek-ai/schemastery'

/** The realms wb2api can route. v0.2 serves `cn` only; `global` is refused. */
export const REALM_VALUES = ['cn', 'global'] as const
export type Realm = (typeof REALM_VALUES)[number]

/**
 * The shape this plugin's config has after normalization.
 *
 * Declared by hand rather than inferred from the schema. `z.object(…)`'s
 * inferred type names `@deepseek-ai/cosmokit`, which is a transitive dependency
 * of schemastery and not importable here, so `tsc --declaration` refuses to
 * emit the public `.d.ts` that names it (TS2742). The drift guard below is what
 * keeps this declaration honest.
 */
export interface WorkbuddyProviderConfig {
  apiKeyEnv: string
  baseURL: string
  realm: Realm
  apiKey?: string
}

export interface WorkbuddyConfig {
  providers: Record<string, WorkbuddyProviderConfig>
}

/**
 * A schemastery node as this module needs to name it: callable (a schema is
 * called directly — `Config(input)` — and returns its normalized output) and
 * serializable for the settings surface.
 */
export interface CallableSchema<T> {
  (data?: unknown): T
  toJSON(): unknown
}

const workbuddyProviderSchema = z.object({
  /** Environment-variable-shaped name DSH resolves the API key from. */
  apiKeyEnv: z
    .string()
    // The credential-reference grammar (`CredentialRef`), enforced here rather
    // than only at lookup time. `required()` alone accepts an empty string —
    // schemastery has no `min(1)` and treats `required` as "not null" — which
    // would sail through config loading and only surface as "no API key
    // resolved" much later, with nothing pointing at the real cause.
    .pattern(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .required()
    .description(
      'Name of the credential holding the wb2api API key. DSH stores the ' +
        'secret under this name, so the variable does not also have to be exported.',
    ),
  /** Base URL of the running wb2api. */
  baseURL: z
    .string()
    // schemastery has no `z.url()`; this catches the mistake that actually
    // happens (a bare host with no scheme) without pretending to be a full URL
    // grammar. A wrong-but-well-formed URL fails later, at the first request.
    .pattern(/^https?:\/\/[^\s]+$/)
    .default('http://127.0.0.1:7863')
    .description('Base URL of the local wb2api. Its default port is 7863.'),
  /**
   * Realm to route. `global` is accepted by the schema so a future version can
   * honour it, but the adapter refuses it at every entry point while this
   * gateway has no global accounts: wb2api routes a bare model id to CN, so
   * stripping a `global:` prefix would answer from the wrong realm with nothing
   * to indicate it.
   */
  realm: z
    .union([z.const('cn'), z.const('global')])
    .default('cn')
    .description('Realm to route. `cn` only in v0.2; `global` is refused at every entry point.'),
  /** Literal key override. Intended for tests; prefer `apiKeyEnv`. */
  apiKey: z
    .string()
    .description(
      'Literal API key. Prefer apiKeyEnv so the secret stays in the credential store.',
    ),
})

const configSchema = z.object({
  providers: z.dict(workbuddyProviderSchema).default({}),
})

/**
 * Drift guard.
 *
 * The declared interfaces above are hand-written for portability, so something
 * has to prove they still describe what the schema produces. These two
 * assignments are that proof and cost nothing at runtime: if a field is added,
 * removed, retyped, or stopped being optional, one of them stops compiling.
 */
const assertSchemaMatchesConfig = (value: ReturnType<typeof configSchema>): WorkbuddyConfig => value
const assertProviderSchemaMatches = (
  value: ReturnType<typeof workbuddyProviderSchema>,
): WorkbuddyProviderConfig => value
void assertSchemaMatchesConfig
void assertProviderSchemaMatches

export const Config: CallableSchema<WorkbuddyConfig> =
  configSchema as unknown as CallableSchema<WorkbuddyConfig>
