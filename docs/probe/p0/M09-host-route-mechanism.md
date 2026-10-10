# M09 — DSH host 端服务暴露机制

> Date: 2026-10-10
> Sources: dsh-cost-meter@1.8.15 (local) + DSH repo `packages/host/webserver`

## TL;DR

DSH host plugin 通过以下三种方式对外暴露能力：

1. **`ctx.provide(name, service)`** —— 注册 typert Remote Service（**首选，dsh-cost-meter 走这条路**）。客户端经 `remote.<name>.<method>()` 调用。
2. **`ctx.inject(['http'], cb)`** —— 拿到 host 内置的 `@deepseek-ai/dsh-host-webserver` 服务，**但仅当 DSH bundle 暴露此 service**（看 desktop 是否启用了 webserver）。plugin 通过 webserver API `registerRoute({method, path, handler})` 挂自己的 HTTP route。
3. **自带 Node `http` server** —— fallback，自己起 `http.createServer()` 监听 `127.0.0.1:0`（OS 分配端口）。**最稳但要自己管理生命周期。**

## dsh-cost-meter 实际做法

```js
// lib/index.js line 3237
export function apply(ctx) {
  // ... 账本、计费、投影 ...
  
  // RPC 服务：客户端经 remote.costMeter.* 调用(./typert 清单由 typert-loader 注册)。
  ctx.provide('costMeter', createService(ctx, ledger, openRouterPrices))
  // ...
}
```

`createService` 返回的对象有 `typertRemote` 属性：`{ service, serviceKey: 'costMeter', namespace: 'costMeter' }` —— 这就是 typert 远程调用协议。

`@deepseek-ai/dsh-cost-meter/typert` 是导出 `TYPERT` 清单的子路径（package.json 里有 `./typert` exports）。**typert-loader** 在 plugin 启动时扫 `exports["./typert"]`，自动注册 client stub。

## dsh-cost-meter 的 workbuddy 适配器 — 关键发现

```js
// lib/gateway-quota-adapters.js
export const GATEWAY_PROVIDER_ADAPTERS = {
  workbuddy: {
    id: 'workbuddy',
    transport: 'plugin-management',
    path: '/v0/management/plugins/workbuddy/credits',
    parse: parseWorkBuddyCredits,
    ...
  }
}

// lib/gateway-quotas.js
async function queryWorkBuddy(source, managementKey, discovered, options) {
  const response = await fetchManagement(
    source,
    GATEWAY_MANAGEMENT_PATHS.workbuddyCredits, // '/v0/management/plugins/workbuddy/credits'
    managementKey,
    options
  )
  // ...
}
```

`fetchManagement(source, path, key, options)` = `fetch(<source.baseURL + path>, { headers: { 'X-Management-Key': key } })` —— **是 HTTP 请求**。

**`source.baseURL` 是用户在 dsh-cost-meter 的 gateway source 配置里写的**——它指向 workbuddy 插件**自己**跑的 HTTP 服务（**CPA 风格**）。

## workbuddy-bridge 的 P1 实现路径

**结论**：workbuddy-bridge 需要**自己起一个 mini HTTP server** 暴露 `/v0/management/plugins/workbuddy/credits` 端点。

**两条路**：
- A. 用 `@deepseek-ai/dsh-host-webserver`（npm 上有 `0.0.1-rc.1` public，monorepo 0.2.1-alpha.2 internal）—— 但需要 DSH 桌面 bundle 暴露此 service 才可用
- B. **Node 内置 `http` 模块** + 端口 0 + service lifecycle 跟 ctx.effect 绑定

**A 路径风险**：
- npm 上版本（0.0.1-rc.1）与 DSH desktop bundle 内置（0.2.1-alpha.2）**不匹配**
- `dsh-cost-meter` 也不引用 `dsh-host-webserver`——说明 desktop bundle 可能不强制注入此 service
- 第三方 plugin 引用它，**API 签名可能随 DSH 升级而变**

**B 路径优点**：
- 无新依赖
- 端口 0 = OS 自动分配，不会与 wb2api/DSH 冲突
- 启动 / 停止 / 错误处理完全在 plugin 内部控制
- 与 `dsh-host-webserver` 是否可用解耦
- plan V2.2.1 §0.3 规则 3 "Attach 模式不拥有外部进程" 仍满足——只 own HTTP server，不 own wb2api

**P1 决策**：走 **B 路径**。

## HTTP server 设计（v1 简版）

```ts
// 仅在 plugin attach mode 下启动（Managed 模式不需要——wb2api 自己就是 HTTP）
import { createServer } from 'node:http'

function startProxy(ctx, cfg) {
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/v0/management/plugins/workbuddy/credits') {
      const key = req.headers['x-management-key']
      if (!verifyKey(key, cfg.managementKey)) {
        res.writeHead(401).end()
        return
      }
      try {
        const upstream = await fetch(`${cfg.baseURL}/status`, {
          headers: { 'Authorization': `Bearer ${cfg.apiKey}` },
        })
        const data = await upstream.json()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(adaptToWorkbuddySchema(data)))
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'WORKBUDDY_PLUGIN_UNAVAILABLE', message: e.message }))
      }
      return
    }
    res.writeHead(404).end()
  })

  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address()
    ctx.logger.info(`workbuddy-bridge: management API on http://127.0.0.1:${port}`)
    ctx.provide('workbuddy', { ...services, managementPort: port })
  })

  ctx.effect(() => () => server.close(), 'workbuddy-bridge: http server')
}
```

**端口 0 → OS 分配** → plugin 启动后 ctx.logger 打印实际端口 → 用户在 dsh-cost-meter 配置里手动填这个端口。

## 待 P1 探针 / 验证

1. **DSH desktop 真的启用了 `@deepseek-ai/dsh-host-webserver` 吗？** —— 看 dsh desktop 安装目录的 bundle，或者直接尝试 `ctx.inject(['http'])`，错误时回退到路径 B。
2. **wb2api `/status` 响应能否直接喂给 dsh-cost-meter 的 parseWorkBuddyCredits？** —— M06 抓到真实 schema 测过，**字段不直接对应**（wb2api 叫 `credits`，dsh-cost-meter 期望 `total_used`/`total_remain`/`total_size`），需要适配器
3. **`ctx.provide('workbuddy', service)` 的 `service` 需不需要 typert 协议？** —— 看 dsh-cost-meter 的 `createService` 返回的 `Object.defineProperty(service, 'typertRemote', ...)`。**workbuddy-bridge 不需要这个属性**——它只是 `ctx.provide(name, plainObject)`，客户端怎么调要看 dsh 是否有 `remote.workbuddy` 通道。**M09 留待 P1 实测。**

## 与 plan V2.2.1 的关系

- plan §7.2 提到 "用户手动指定 port；EADDRINUSE → 立即重提示" —— **已被替代**：用端口 0 让 OS 分配，**无 EADDRINUSE 风险**。用户的"指定 port" 仅在 Managed 模式 wb2api 启动时需要。
- plan §6.4 OAuth "用 browser-bridge openExternal" —— 与本 M09 独立，下一探针 M10 处理。
