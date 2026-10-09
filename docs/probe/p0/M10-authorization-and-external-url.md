# M10 — OAuth flow + 外部 URL 打开机制

> Date: 2026-10-10
> Sources: DSH `packages/credentials/authorization`, `packages/host/open-in-app`, `packages/shell/shell`, dsh-llm-pi-ai `src/login.ts`, wb2api `cmd/login/main.go`

## TL;DR

DSH 提供 `ctx.authorization.registerFlow()` 标准 OAuth 流程。**Plan V2.2.1 §6.1.1 的"copy URL 按钮 always-on" 走这条路径自动实现**——不需要 DSH 单独的 `shell.openExternal` service，UI 侧 dsh-authorization 客户端会渲染 URL + 复制按钮。

## OAuth flow 协议

```ts
ctx.inject(['authorization'], (authorization) => {
  authorization.registerFlow({
    key: 'WORKBUDDY_OAUTH',         // 凭证记录 key
    label: 'WorkBuddy / CodeBuddy Account',
    methods: [
      { id: 'oauth', label: 'Sign in with Tencent WorkBuddy' },
    ],
    async run(session) {
      // session.method  : 'oauth' | 'api-key'
      // session.signal  : AbortSignal（用户取消时 abort）
      
      // 1. 拿 wb2api /panel/api/login/start 的 {url, state}
      const { url, state } = await wb2api.loginStart(realm)
      
      // 2. session.notify 把 URL 推给用户 UI（DSH 显示 URL + 复制按钮）
      session.notify({
        message: '在浏览器中打开此 URL 完成登录',
        url: url,
      })
      
      // 3. 轮询 wb2api /panel/api/login/poll?state=...
      while (!session.signal.aborted) {
        await new Promise(r => setTimeout(r, 3000))
        session.notify({ message: '等待浏览器登录完成…' })
        const result = await wb2api.loginPoll(state)
        if (result.done) {
          // 4. 凭证由 wb2api 自己落盘到 <wb2api>/auths/workbuddy-<uid>.json
          //    不需要 plugin 持有
          return
        }
      }
      throw new Error('用户取消登录')
    },
  })
})
```

### 关键来源验证

**`dsh-llm-pi-ai/src/login.ts` line 131-171** 的 `registerPiAiFlows`：
```ts
ctx.authorization.registerFlow({
  key: recordKeyFor(providerId),
  label: provider.name,
  methods: [first, ...rest],
  async run(session) {
    const type: AuthType = session.method === 'oauth' ? 'oauth' : 'api_key'
    await models.login(providerId, type, {
      signal: session.signal,
      notify: (event) => { relay(event, session) },     // ← 关键：notify 是把事件传回 DSH UI
      prompt: prompt => session.prompt(restate(prompt)),
    })
  },
})
```

`session.notify` 接受 `{ message, url?, code? }`，DSH UI 自动渲染。

## URL 在哪里被"打开"

**DSH 不提供显式"openExternal" service**。`packages/host/open-in-app` 是"open in installed app"（VS Code、Terminal 等），不是浏览器。

**三种方案**：
1. **`ctx.shell.execute({ command: 'start <url>' | 'open <url>' | 'xdg-open <url>' })`** —— 可行但需要平台判断 + 间接，且 shell service 在某些环境（无头、Linux）可能不可用
2. **依赖 DSH UI 自动渲染 URL** —— `session.notify({ url })` 触发 dsh-authorization 客户端 UI，**DSH Desktop 通常会在 webview 顶部 / 侧栏显示 URL + 复制按钮**。**用户自己点链接**或**复制到剪贴板**——这与 plan V2.2.1 §6.1.1 "copy URL 按钮 always-on" 完全一致
3. **注册自定义 slot 让 client.js 弹一个 modal** —— DSH 客户端自己写 modal，主动 `window.open(url)` 在新标签打开

**P1 推荐方案 = 方案 2（完全靠 DSH UI）+ 方案 3（client.js 主动 window.open 作为兜底）**：
- host 端用 `session.notify({ url })` 推 URL
- client.js 注册一个 slot（待 M10.1 探针——看 dsh-cost-meter 怎么注入 sidebar），如果 host 环境有浏览器桥，调用之
- **绝不**用 ctx.shell.execute 开浏览器（污染模型可见的 shell history，且 permission 风险）

## wb2api `cmd/login` 的实际行为

`cmd/login/main.go`:
```go
// login url 子命令：POST /v2/plugin/auth/state?platform=CLI 拿 state+authUrl
//   state 落 /tmp/wb2api-login-state.json
//   stdout 打印授权 URL
// login poll 子命令：GET /v2/plugin/auth/token?state=<state> 轮询

fmt.Fprintln(out, st.AuthURL)
```

**wb2api CLI 也不打开浏览器——只 print URL**。这印证了"URL 必须由用户自己处理"的方案 2。

## 完整 P1 OAuth 流程（修订版）

```
[User] 在 DSH UI 点 "Sign in with WorkBuddy"
  ↓
[DSH] dsh-authorization 客户端调 remote.workbuddy.runOAuth(session)
  ↓
[Host: workbuddy-bridge apply()] 
  ↓ ctx.authorization.registerFlow.run()
  ↓
[Host] POST wb2api /panel/api/login/start {realm:'cn'}
  ↓ 收到 {url, state, realm}
  ↓ session.notify({ message, url })  // DSH UI 渲染
  ↓
[User] 浏览器手动打开 URL（或点 DSH UI 的"打开"按钮）→ 在腾讯登录页登录
  ↓
[Host] 每 3s 轮询 wb2api /panel/api/login/poll?state=...
  ↓ session.notify({ message: '等待登录…' })
  ↓
[wb2api] 用户完成登录 → 写 auths/workbuddy-<uid>.json → 热加载
  ↓ poll 返回 {done: true, ...}
  ↓
[Host] ctx.credentials.set('WORKBUDDY_OAUTH', marker)  // 仅作完成标记
       // 真正的 refresh token 一直在 wb2api 自己手里
  ↓
[User] UI 看到"登录成功，账号已添加"
```

## 与 plan V2.2.1 的差异

| plan V2.2.1 假设 | 真实 | 修正 |
|---|---|---|
| "用 browser-bridge openExternal" | DSH **没有** shell.openExternal service | 改用 dsh-authorization `session.notify({url})` + DSH UI 自动渲染 + 兜底 client.js 写 `window.open` |
| "若 openExternal 不可用, 需 copy URL 按钮 always-on" | dsh-authorization UI **默认就有 URL 显示 + 复制按钮** | 计划里"always-on copy" 已被 DSH 官方 UI 默认提供；plugin 只需 `session.notify({url})` |
| §6.1.1 "DSH Host 进程能否加载 electron module 是不确定" | **DSH 走 webview + 客户端 module loader**，host 端不直接调 electron | plan §6.1.1 的担心可以解除——**plugin 永远不直接调 electron**，由 DSH desktop bundle 内部处理 |

## 给 P1 编码的 contract

```ts
// host/src/authorization.ts (P1 草图)
import type { Context } from '@deepseek-ai/cordis'
import { fetchWorkbuddyStart, fetchWorkbuddyPoll } from './workbuddy-client.js'

export function registerWorkbuddyOAuthFlow(
  ctx: Context,
  workbuddyBaseURL: string,
  workbuddyApiKey: string
): void {
  ctx.inject(['authorization'], (authorization) => {
    authorization.registerFlow({
      key: 'WORKBUDDY_OAUTH',
      label: 'WorkBuddy / CodeBuddy',
      methods: [{ id: 'oauth', label: 'Sign in with WorkBuddy' }],
      async run(session) {
        const realm = 'cn'  // V1 只支持 cn;global 是 P3
        session.notify({ message: '正在生成授权 URL…' })
        const { url, state } = await fetchWorkbuddyStart(workbuddyBaseURL, workbuddyApiKey, realm)
        
        session.notify({
          message: '在浏览器中打开此 URL 以登录 WorkBuddy / CodeBuddy 账号',
          url,
        })
        
        const POLL_INTERVAL_MS = 3000
        const MAX_DURATION_MS = 5 * 60 * 1000  // 5 min
        const startTime = Date.now()
        
        while (!session.signal.aborted && Date.now() - startTime < MAX_DURATION_MS) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, POLL_INTERVAL_MS)
            session.signal.addEventListener('abort', () => {
              clearTimeout(timer)
              reject(new Error('登录已取消'))
            }, { once: true })
          })
          
          const result = await fetchWorkbuddyPoll(workbuddyBaseURL, workbuddyApiKey, state)
          if (result.done) {
            session.notify({ message: '登录成功！账号已添加。' })
            return
          }
          // result.done === false → 继续轮询
        }
        
        throw new Error('登录超时（5 分钟）')
      },
    })
  })
}
```

**剩余 3 个细节待 P1 实测**：
1. **`ctx.authorization` 真的能用吗？** —— 取决于 DSH desktop bundle 是否注入此 service。需要 P1 在真机启动 dsh desktop 试。
2. **`session.notify` 在客户端是否真的渲染 URL？** —— dsh-cost-meter 没注册 flow，看不到例子。**参考 dsh-llm-pi-ai 是最直接的真实例子**。
3. **session.signal 在用户取消时是否真触发？** —— 文档暗示是，需要真测。
