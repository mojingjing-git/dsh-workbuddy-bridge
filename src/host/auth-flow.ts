/**
 * OAuth flow for adding a new WorkBuddy / CodeBuddy account.
 *
 * Plan reference: V2.2.1 §6.1, M10 evidence (DSH `ctx.authorization` flow
 * protocol + `session.notify({ url })` UI rendering).
 *
 * Flow summary:
 *   1. POST wb2api /panel/api/login/start {realm}
 *   2. Receive {url, state} — wb2api has already opened a session for the
 *      device code (M03 evidence: cn → copilot.tencent.com, global →
 *      www.workbuddy.ai). It is the user's job to open the URL and sign in.
 *   3. session.notify({ message, url }) — the DSH UI shows the URL plus a
 *      copy button (M10: dsh-authorization 客户端 UI 默认渲染).
 *   4. Poll wb2api /panel/api/login/poll?state=... every 3 s, with a
 *      5-minute hard cap.
 *   5. On `done: true`, wb2api has already written the credential into its
 *      own `auths/workbuddy-<uid>.json` and hot-loaded the account. The
 *      plugin does NOT touch the refresh token — it only marks the DSH
 *      credential store that at least one account is bound.
 *   6. On `done: false` after the cap, or on signal abort, throw so the
 *      DSH UI surfaces the failure to the user.
 */

import { WorkbuddyClient, pollUntilDone, type WorkbuddyLoginPollResponse } from './workbuddy-client.js'
import { OAUTH_POLL_INTERVAL_MS, OAUTH_TIMEOUT_MS, WORKBUDDY_OAUTH_CREDENTIAL_KEY } from '../shared/constants.js'

/** Minimal shape of the dsh-authorization session this flow needs. */
export interface AuthorizationSession {
  method: 'oauth' | 'api-key'
  signal: AbortSignal
  notify(event: { message?: string; url?: string; code?: string }): void
}

/** Minimal shape of the dsh-authorization service this flow needs. */
export interface AuthorizationService {
  registerFlow(flow: AuthorizationFlow): void
}

export interface AuthorizationFlow {
  key: string
  label: string
  methods: Array<{ id: 'oauth' | 'api-key'; label: string }>
  run(session: AuthorizationSession): Promise<void>
}

/** Minimal shape of the DSH credentials service this flow needs. */
export interface CredentialsService {
  set(ref: { name: string; value: string }): Promise<void>
  describe(ref: { name: string; value: string }): Promise<{ configured: boolean; writable: boolean }>
}

export interface WorkbuddyAuthFlowDeps {
  authorization: AuthorizationService
  credentials: CredentialsService
  workbuddy: WorkbuddyClient
  realm: 'cn' | 'global'
  /** When true, only register the flow when `realm` matches the user's
   *  configured realm. V1 always passes `true` (cn only). */
  enabled?: boolean
}

export function registerWorkbuddyOAuthFlow(deps: WorkbuddyAuthFlowDeps): void {
  if (deps.enabled === false) return

  deps.authorization.registerFlow({
    key: WORKBUDDY_OAUTH_CREDENTIAL_KEY,
    label: 'WorkBuddy / CodeBuddy',
    methods: [{ id: 'oauth', label: 'Sign in with WorkBuddy' }],
    async run(session) {
      await runWorkbuddyOAuth(deps, session)
    },
  })
}

export async function runWorkbuddyOAuth(
  deps: Pick<WorkbuddyAuthFlowDeps, 'workbuddy' | 'credentials' | 'realm'>,
  session: AuthorizationSession,
): Promise<void> {
  if (session.signal.aborted) {
    throw new Error('workbuddy: sign-in cancelled before start')
  }
  session.notify({ message: '正在向 wb2api 请求授权会话…' })
  const { url, state } = await deps.workbuddy.loginStart(deps.realm)
  session.notify({
    message: '在浏览器中打开此 URL 完成登录（DSH UI 顶部会显示复制按钮）：',
    url,
  })

  let result: WorkbuddyLoginPollResponse
  try {
    result = await pollUntilDone(
      deps.workbuddy,
      state,
      session.signal,
      OAUTH_POLL_INTERVAL_MS,
      OAUTH_TIMEOUT_MS,
    )
  } catch (e) {
    session.notify({ message: `登录未完成：${(e as Error).message}` })
    throw e
  }

  // Mark the DSH credential store that at least one wb2api account is bound.
  // The actual refresh token lives in wb2api's own auths/ directory; we
  // only persist a marker so the client UI can show "signed in".
  const ref = { name: WORKBUDDY_OAUTH_CREDENTIAL_KEY, value: 'bound' }
  const info = await deps.credentials.describe(ref).catch(() => ({ configured: false, writable: true }))
  if (info.writable) {
    await deps.credentials.set(ref)
  }
  session.notify({ message: '登录成功，账号已添加到 wb2api。' })
}
