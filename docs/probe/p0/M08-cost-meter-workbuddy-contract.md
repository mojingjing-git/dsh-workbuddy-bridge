# M08 — dsh-cost-meter ↔ workbuddy plugin 契约

> Date: 2026-10-10
> Source: `C:\Users\MoJingJing\.dsh\profiles\desktop\node_modules\dsh-cost-meter@1.8.15`
> Primary file: `lib/gateway-quota-adapters.js` lines 220-960
> Plan reference: V2.2.1 §1.1 "balance observation" + §6.2 余额面板

## TL;DR

**dsh-cost-meter v1.8.15 已经为 workbuddy 写好 adapter 桩**。workbuddy-bridge **不需要**自己写余额 UI；只要在 host 端 expose 一个 HTTP route：

```
GET <DSH baseURL>/v0/management/plugins/workbuddy/credits
```

返回约定的 JSON shape，dsh-cost-meter 会在 sidebar 的 gateway quota 面板里自动显示。

## Adapter 注册（dsh-cost-meter 侧）

`GATEWAY_PROVIDER_ADAPTERS.workbuddy`:
```js
{
  id: 'workbuddy',
  transport: 'plugin-management',     // 关键：标记"由 workbuddy 插件自己 expose 端点"
  aliases: ['workbuddy'],
  path: '/v0/management/plugins/workbuddy/credits',
  parse: parseWorkBuddyCredits,       // 在 dsh-cost-meter/lib/gateway-quota-adapters.js
  capabilities: {
    percentageWindows: true,
    amountWindows: true,              // credits 是绝对量
    resetTimes: true,
    readOnly: true,
  },
}
```

注释原文：「**宿主对 baseURL + path 发只读 GET;插件其余变更路由一律不碰**」——这意味着 workbuddy-bridge **禁止**通过这个路径暴露任何非只读方法。

## 响应 schema（plugin 必须返回）

```json
{
  "accounts": [
    {
      "auth_index": 0,                 // 整数或字符串（snake_case 优先）
      "credits": {
        "total_used": 1000,            // 合成示例值：total_size - total_remain
        "total_remain": 3000,
        "total_size": 4000,
        "fetched_at": "2030-01-01T00:00:00+08:00",  // ISO 8601；可省略
        "packages": [                    // 可选
          {
            "name": "trial",
            "used": 100,
            "remain": 50,
            "size": 200,
            "cycle_start": "2026-10-01T00:00:00+08:00",
            "cycle_end": "2026-10-31T23:59:59+08:00"
          }
        ]
      }
    }
  ]
}
```

字段命名容忍 snake_case + camelCase 两种（`pickField` 双查）；**PII 字段（nickname/uid）禁止出现在响应里**——dsh-cost-meter 的 parseWorkBuddyCredits 注释明确写了「nickname/uid 是 PII，**绝不**复制进输出」。

## 错误模型

- accounts 数组缺失 → 顶层 status: 'error'，message: 'workbuddy: 响应缺少 accounts 数组'
- 某行 row 非法 → 该行 status: 'error'，message 截断 120 字符
- 某行缺 auth_index → status: 'error'，message: 'workbuddy: 账号行缺少 auth_index'
- 某行 credits 字段格式错 → status: 'unknown'，**不视为耗尽**
- 某行无任何 usage signal（total_used/size 都 0 且无 packages）→ status: 'unknown'，**不视为耗尽**
- 任一账号 ok → 顶层 ok；任一 error → 顶层 error；其他 unknown

## workbuddy-bridge 端实现要点

**Host 端**（`index.ts` 的 `apply(ctx, config)`）：
1. 用 `ctx.inject(['http'])` 或等价的"DSH host 路由" API 注册一个 GET handler，路径 `/v0/management/plugins/workbuddy/credits`
2. 内部实现：从 `config.apiKeyEnv` / `ctx.credentials` 拿 wb2api 凭据
3. 请求 wb2api `/status` endpoint
4. 转换为上述 schema 返回
5. **不要**在响应里放 nickname/uid（即使是本地数据 — 因为会被 dsh-cost-meter 透传到 web 客户端）
6. **不要**为此 path 暴露 POST/PUT/DELETE

**Wb2api → workbuddy-bridge 转换**：
- accounts[i].uid → accounts[i].auth_index (数字索引)
- credits (剩) → total_remain
- credits_total (总) → total_size
- total_size - credits → total_used
- credits_earliest_expiry → fetched_at
- packages[] — wb2api 不返回分套餐，**先返回空数组**（P1 简单实现；P3 如果 wb2api 升级支持 packages 再补）

## 验证计划（P1 验收）

1. wb2api-bridge 启动后，在 DSH sidebar "费用" 面板应自动出现 "WorkBuddy" 卡片（不需要 workbuddy-bridge 做任何 UI）
2. 卡片显示的总量/已用/剩余应与网关 `/status` 一致（本仓库用合成值示例：
   总量 4000、已用 1000、剩余 3000、百分比 25%）
3. 卡片有刷新按钮 → 重新打 wb2api `/status`
4. wb2api 关掉 / API key 错 → 卡片显示 error 状态而非崩溃

## 其他发现

- `dsh-cost-meter` 自身用 `import { credentialRef } from '@deepseek-ai/dsh-credentials'` —— **workbuddy-bridge 应当**用同样的 `credentialRef()` 构造 + `ctx.credentials.resolve(ref)` 读取
- `dsh-cost-meter` 自己的 service id 是 `cost-meter`（`export const name = 'cost-meter'`）—— workbuddy-bridge 应当用 `workbuddy` 作为自己的 name
- `dsh-cost-meter@1.8.15` 是 MIT，**workbuddy-bridge 在 README 里要**致谢 dsh-cost-meter 提供了这个 adapter 桩（虽然不算强依赖，但功能完整靠它）

## 开放问题（P1 待办）

1. **DSH host 端如何注册 HTTP route** —— M01-M07 没看到 DSH 提供的 `ctx.inject(['http'], cb)` 或类似 API。**M09 探针**需要看 dsh-bundle 或 dsh-core 提供什么 host 端服务注册机制。
2. **workbuddy-bridge 在多 profile 部署**（Desktop / Web / CLI）下，route 注册的 baseURL 是哪？plan V2.2.1 §2.4 说 V1 不做 Web / CLI，那 Desktop 默认 baseURL 是 `http://127.0.0.1:<dsh-port>`。具体 port 范围 / 自动发现机制待 M09 探针。
