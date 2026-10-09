# P0 探针验收报告（V2.2.1 §11 P0）

> Date: 2026-10-10
> DSH reference: `dsh-v0.2.1-alpha.2`
> wb2api reference: `linguo2625469/workbuddy2api-panel@main` (HEAD `REDACTED-UPSTREAM-SHA`)
> Local wb2api: `C:\Users\MoJingJing\Desktop\Workbuddy2api\wb2api.exe` on `127.0.0.1:7863`
> Source files: see sibling `M0X-*` files in this directory

## P0 探针任务清单验收状态

| ID | 探针项 | 状态 | Evidence |
|---|---|---|---|
| M01 | DSH `cordis.patch.yml` Loader 真实字段 | ✅ DONE | `M01-decoration-cordis-patch.yml` + `M01-mcp-cordis-patch.yml` + `M01-loader-and-bundle-fields.md` |
| M02 | dsh-llm-pi-ai 真实 Host 插件 layout + LLM register API | ✅ DONE | `M02-llm-pi-ai-src-*.ts` + `M02-llm-core-index.ts` + `M02-llm-types.ts` |
| M03 | wb2api OAuth login/start + login/poll 真实响应 | ✅ DONE（不真等完成） | `M03-auth-source.go` + `M03-panel-login.go` + `M03-login-start-cn.json` + `M03-login-start-global.json` + `M03-login-poll-cn.json` + `M03-login-poll-unknown.json` |
| M04 | /v1/models 真实列表 | ✅ DONE | `M04-v1-models.json`（19 模型，all `cn:`） |
| M05 | `cH:` 大小写敏感 + 真实错误体 | ✅ DONE | `M05-curl-samples.txt` + `M05c-curl.txt`（HTTP 400 + 11102）|
| M06 | /status schema（balance panel） | ✅ DONE | `M06-status.json`（含 model_locks、realm_totals、token_usage） |
| M07 | 503 三态边界 + /healthz schema | ⚠️ PARTIAL（健康/锁 测过；真 503 未触发但 plan §7.3 论断仍成立）| `M07-healthz-probes.txt` |

## 关键发现（影响 V2.2.1 计划与 P1 设计）

### 1. DSH 仓库真实路径

| Plan §3.2 假设 | 真实 |
|---|---|
| `deepseek-ai/dsh` | **`deepseek-ai/deepseek-harness`**（不是 `dsh`） |

### 2. DSH Host 插件协议（`@deepseek-ai/cordis`）

```ts
export const name = 'llm-pi-ai'                       // 插件 ID
export const inject = ['llm']                          // ctx 依赖服务
export const Config = z.object({…})                    // schema
export function apply(ctx: Context, config: Config): void
```

- `ctx.effect(function*, name)` —— **生命周期管理**（yield 的是 disposer）
- `ctx.on('loader/volatile-update', cb)` —— 热更新钩子
- `ctx.on('llm/adapters-updated', cb)` —— 路由变化广播
- `ctx.inject(['settings'\|'authorization'\|'fs'], cb)` —— 钩子
- `ctx.credentials.resolve(ref)` —— 读密钥

### 3. DSH LLM 适配器接口

```ts
class MyAdapter extends LlmAdapter {
  providerInfo(provider) { return {id, name} }
  resolveModel(provider, model) { return Promise<{provider, id, name, …}> }
  listModels(provider) { return Promise<LlmModelInfo[]> }
  abstract stream(options) { /* AsyncIterable<StreamChunk> */ }
}

// 注册：
ctx.llm.registerAdapter(['workbuddy'], adapter)            // 注册路由
ctx.llm.registerConfigurableProviders([                    // 注入可配置 provider
  { provider: 'workbuddy', displayName, settingsNs, settingsPath: ['providers','workbuddy'] }
])
ctx.llm.registerModelDiscovery('workbuddy', async (req, sig) => […])  // 端点发现
```

### 4. DSH Client 模块协议

```js
window.__ModuleLoader__.load({
  id: '@scope/plugin-name',
  factory(require) {
    const React = require('react');
    return {
      inject: ['slots', 'other-client-mod'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register({ name, id, order }, Component));
      },
    };
  },
});
```

### 5. DSH `package.json#dsh` 字段

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {
    "platform": "web",
    "immediately": true,
    "inject": ["@deepseek-ai/dsh-client-ui-conversation"]
  }
}
```

- `bundle.patch` 必须存在（host 注册用）
- `client` 整段可省（纯 host 插件）——mcp 模板就这么干
- `client.inject` 是 **DSH 客户端包名列表**，不是文件路径
- `exports` 子路径：`.`、`./client`（如有）、`./locale/*.json`、`./icon`

### 6. wb2api 真实响应（与 plan §1.1 表交叉验证）

| 探针 | 计划预测 | 真实 | 修正 |
|---|---|---|---|
| `cn:glm-5.2` | 200 | 200 ✅ | 保持 |
| `glm-5.2` bare | 200 (默认 CN) | 200 ✅ | 保持 |
| `cH:glm-5.2` | "(cn, cH:glm-5.2) 透传" | **HTTP 400 `model_unavailable: 11102 model not available`** | 上游**无此模型**——**plugin 必须强制 reject** 一切非小写 `cn:`/`global:` |
| `CN:glm-5.2` | 同 cH | **HTTP 400** | 同上 |
| `global:glm-5.2` | "(global, glm-5.2) 200" | **HTTP 503** | 因 `/v1/models` 列表无 global，wb2api 透传给上游**返回 503 而非 400**——plugin 仍必须 reject（global 列表为空） |
| `auto` | "上游自动路由" | 200 + `model: hy4-preview-f` | 保持，模型名是 wb2api 自己定义的别名 |

### 7. `/healthz` schema（M07 重新校准 plan §1.1）

```json
{
  "healthy": 2,
  "realm_servable": {"cn": true, "global": false},
  "service": "workbuddy2api",
  "total": 2
}
```

- 无鉴权（plan 预测正确）
- **status code 始终 200**——M07 未观察到 503 路径。**Plugin 应通过 `realm_servable.{cn,global}` + `/status` 的 `model_locks` 综合判定可用性，不要把 HTTP 503 当 liveness 失败的判据**（plan §7.3 论断仍正确——但实际触发条件是 model lock + 账号全 cooling，而不是 `wb2api.exe` 死亡）
- M07 探针发现：HTTP 401 = API key 错；HTTP 400 = 模型名错或锁了；HTTP 503 = 上游拒绝（global 域空等）；HTTP 200 = 通

### 8. `/status` schema（M06）

`accounts[].{uid, nickname, credits, credits_total, credits_earliest_expiry, credits_earliest_remaining, cooling, rate_limited_models[], realm, disabled, success_count, last_success, last_err, token_usage, model_costs, consecutive_fails, degrade_until, in_flight, breaker_fails, breaker_until}`

顶层：
- `model_locks[]` —— `{model, realm, total, servable, locked, state, unlock_at, fully_unlock_at, reason}`
- `realm_totals.{cn, global}.{cooling, disabled, healthy, in_flight_full, total}`
- `credit_floor` 阈值（默认 100）
- `total` 总账号数
- `redis_mode: "noop"` — 印证 plan §1.1 描述"未启用 redis"

### 9. wb2api OAuth schema（M03）

`POST /panel/api/login/start` (Bearer token required, body `{}` 或 `{"realm":"global"}`):
```json
{"ok": true, "realm": "cn"|"global", "state": "<uuid>", "url": "<authorize URL>"}
```

- `realm=cn` → `url = https://copilot.tencent.com/login?platform=CLI&state=...`
- `realm=global` → `url = https://www.workbuddy.ai/login?platform=CLI&state=...`

`GET /panel/api/login/poll?state=<state>`:
- 进行中：`HTTP 200 {"done":false, "message":"code=11217 msg=11217:login ing..."}`
- 未知/过期：`HTTP 404 {"error":"unknown or expired state...","ok":false}`
- 完成（推测）：`HTTP 200 {"ok":true, "done":true, "uid":"...", "nickname":"...", "realm":"..."}`

**OAuth 设备流间隔 = 3s**（来自源码注释）

### 10. 当前真实账号状态（M06 反映）

**已脱敏**：真实 `uid` / nickname / 精确 credit 与 token 计数**不记录在本仓库**。
下表只保留结构性事实（账号数量、realm 分布、是否存在 global 账号），
这些是 P0 → P1 的设计依据。

| 账号 | 冷却 | realm | 有 model lock 过 |
|---|---|---|---|
| `<account-1>` | 否 | cn | 是（`CN:glm-5.2` / `cH:glm-5.2`） |
| `<account-2>` | 否 | cn | 是（同上） |

- `global` 域账号数 = **0**（这是 v0.2 阶段禁用 `global:` 的直接依据）
- `model_locks[CN:glm-5.2]` 曾被上游 11102 锁过约 5 分钟，之后自行解锁
- 两个账号的 OAuth 有效期足以覆盖 P0 探针周期

## P0 → P1 设计决策（基于证据更新）

### DSH-1: 用现成 `@deepseek-ai/dsh-llm-pi-ai` 还是新写 `LlmAdapter`？
**决策**：新写 `LlmAdapter`（`@deepseek-ai/dsh-llm` API）。
**理由**：`dsh-llm-pi-ai` 只接受 pi-ai 兼容的 baseURL + apiKeyEnv + 静态 models；wb2api 19 模型 + OAuth 凭据 + 每账号轮询选择 + cooldown 路由选择都需要 `LlmAdapter` 的 `stream()` + `listModels()` + `resolveModel()` 自定义实现。**不能直接复用**。

### DSH-2: 客户端模块依赖什么 DSH 包？
**待 P1 探针**：要看 dsh-cost-meter client、dsh-client-settings、dsh-client-ui-conversation 实际导出哪些 Slot。M01 evidence 给出至少 1 个 client 依赖：`@deepseek-ai/dsh-client-ui-conversation`。

### DSH-3: settings 入口在哪？
**待 P1 探针**：`ctx.inject(['settings'], cb)` 可拿到 settings service，模型注册由 `registerConfigurableProviders` 自动挂到 Models 页面；用户填写 API key 用 `ctx.credentials.resolve('WB2API_API_KEY')`。Plugin 的 host 端不直接维护 settings UI。

### DSH-4: 大小写强制 reject 必须在 plugin 层
**决策**：plugin 在 `LlmAdapter.stream()` 入口检查 model 名：必须是 `cn:<bare>` / `global:<bare>` / bare 三者之一；其他（cH:、CN:、C:、前缀含冒号但非小写 `cn:`/`global:`）一律 `LlmError('PROVIDER_REJECTED_CASE', …)` 抛出。**这是 P1 必须落地的硬约束**。

### DSH-5: attach 模式的 "wb2api host:port" 怎么让用户填？
**决策**：plugin schema 暴露：
```yaml
providers:
  workbuddy:
    apiKeyEnv: WB2API_API_KEY  # 用户从 wb2api config.json 读
    baseURL: http://127.0.0.1:7863/v1
    realm: cn
```
`registerModelDiscovery` 接到 `/v1/models` 拉真实列表。**不主动管理 wb2api 进程**（plan §0.2 路线 A 的 attach 部分）。

## 开放给 P1 的探针

1. **dsh-cost-meter client 协议** —— `/v0/management/plugins/workbuddy/credits` 是 Han-1413141 提供的 provider；plugin 要不要自己写 sidebar？还是要走 cost-meter 的统一 panel？需要看 dsh-cost-meter 源码（计划 P1 探针 M10）
2. **shell.openExternal 桥** —— plan V2.2.1 §6.1.1 说"copy URL 按钮 always-on"，P1 必须确认 DSH Host 进程能否打开系统浏览器
3. **wb2api 1.x → 1.13 兼容性** —— M06 的 `model_locks[].realm` 字段、M05 的 11102 上游错误、M07 的 `realm_servable` 字段都是 v1.13 新增——pin 1.13
4. **17 个非 auto 模型的 Agent tool-call 兼容性** —— plan §0.3 规则 6：M01-M10 验过才能标"Agent 验证通过"
5. **ctx.inject(['authorization'], cb) 实际怎么注册 OAuth 流程** —— dsh-llm-pi-ai 在 `login.ts` 里有 `registerPiAiFlows`；P1 要看 dsh-authorization 暴露什么 API

## 状态

**P0 验收：** ✅ 大部分完成。M07 的 "503 真触发" 留给 P1 故意把账号全 cooling 时再补。
**P1 进入条件：** P0 探针报告完成 + plan V2.2.1 §0.3 规则 6 复审。本报告即作为 P1 起点。
