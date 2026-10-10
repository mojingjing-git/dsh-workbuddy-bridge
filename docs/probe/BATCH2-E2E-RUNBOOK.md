# Batch 2 验收 — 真机 DSH Desktop E2E runbook

> 日期：2026-10-10
> 验收门槛：**DSH Agent 真实完成一次 tool call → 执行 → 结果回填 → 最终回答**
>
> **重要前置发现**：用户 desktop profile 的 `cordis.patch.yml` 里已经有一条手工
> 配置的 `dsh-llm-pi-ai` 路由（provider 名 `abc123`）指向同一个 wb2api 网关，
> 且网关请求日志显示该链路已经正常完成过工具调用与结果回填。因此下面这些步骤
> 既可以用来验收**本插件**，也可以用来对照那条手工配置的差异。

## 前置条件（已满足的部分）

| 项 | 状态 |
|---|---|
| wb2api 在 `127.0.0.1:7863` 运行 | ✅ 需用户确认仍在跑 |
| wb2api API key | **不写入本仓库**。取值方式见下方说明 |
| DSH Desktop profile | `~/.dsh/profiles/desktop` |
| DSH base bundle 版本 | `0.2.1-alpha.2` |
| 插件 build 产物 | ✅ `lib/` 已生成，运行时仅依赖 `zod` |

## 步骤 1 — 把插件装进 desktop profile

```powershell
# 在插件仓库根目录
cd C:\Users\MoJingJing\Documents\deepseek-harness\dsh-workbuddy-bridge
pnpm run build
pnpm run build:client

# 装进 DSH desktop profile
cd C:\Users\MoJingJing\.dsh\profiles\desktop
pnpm add file:C:\Users\MoJingJing\Documents\deepseek-harness\dsh-workbuddy-bridge
```

或者用 DSH 自己的 plugin CLI（如果可用）：

```powershell
dsh plugin --profile desktop add C:\Users\MoJingJing\Documents\deepseek-harness\dsh-workbuddy-bridge
```

装完后 `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 应出现
`dsh-workbuddy-bridge`，且 `dsh.profile.bundles` 需要加入 `dsh-workbuddy-bridge`
（否则 loader 不会挂载它 —— 见 `cordis.patch.yml` 与 bundle 的关系）。

**注意**：`dsh.profile.bundles` 是手工维护的数组。如果 `pnpm add` 没有自动加进去，
需要手动补：

```json
"dsh": {
  "profile": {
    "bundles": [
      "@deepseek-ai/dsh-base",
      "@deepseek-ai/dsh-web-app",
      "dsh-workbuddy-bridge",
      ...已有项
    ]
  }
}
```

## 步骤 2 — 提供 wb2api API key

**API key 的值只存在于你本机的 wb2api 配置里，绝不写入本仓库、日志或截图。**

取值方式：打开 wb2api 的 `config.json`，读取 `api_key` 字段。

二选一：

- **A（推荐）**：设环境变量，重启 DSH Desktop
  ```powershell
  # 把 <WB2API_API_KEY_VALUE> 换成上一步从 config.json 读到的值
  setx WB2API_API_KEY "<WB2API_API_KEY_VALUE>"
  ```
- **B**：在 `cordis.patch.yml` 里直接用 `apiKey` 字面量（我们 schema 支持，
  但**不建议**用于长期使用，因为明文落盘）

> **注意**：`setx` 会让这个值出现在 PowerShell 历史里。如果这不可接受，
> 用 `[Environment]::SetEnvironmentVariable('WB2API_API_KEY', $value, 'User')`
> 从一个变量传入，或直接在 DSH Models 页面里输入。

## 步骤 3 — 重启 DSH Desktop

插件在启动时由 `@deepseek-ai/cordis-plugin-loader` 读取 `cordis.patch.yml`
挂载。**必须重启**（不是刷新页面）。

## 步骤 4 — 验证插件已挂载

在 DSH Desktop 里看：

1. **Models 页面**：应出现 `WorkBuddy / CodeBuddy` provider，展开后应看到
   **19 个模型，id 是裸名**（`glm-5.2`、`auto`、`hy3`、…，**不带 `cn:`**）。
   ← **这是 Batch 2 / P0 #1 的核心验收点**
2. **DSH 日志**（如果能看到）：应出现
   `workbuddy: LLM route "workbuddy" registered against http://127.0.0.1:7863 (management port NNNNN, realm cn, settingsNs "workbuddy")`
3. **会话选择器**里选一个 workbuddy 模型（建议先选 `auto`，它最稳）

## 步骤 5 — 基础对话验收

在新的 DSH 会话里，选 workbuddy 模型，发一句：

```
用一句话介绍你自己
```

**通过标准**：Agent 返回真实文本（不是报错、不是空、不是无限等待）。

## 步骤 6 — 工具调用验收（**Batch 2 的真正门槛**）

发一句会触发工具调用的话，例如：

```
读一下当前目录有哪些文件
```

**通过标准**（四条全中才算过）：

1. Agent 发起 tool call（DSH UI 显示工具调用卡片，例如 `fs_list` / `bash`）
2. 工具真实执行（返回真实目录内容）
3. 工具结果回填进模型上下文（Agent 的下一轮请求带着 tool result）
4. Agent 基于工具结果给出**最终自然语言回答**

**这一条通过，Batch 2 才算过。** 前 5 步只证明「能连上」，第 6 步才证明
「Agent 兼容」。

## 步骤 7 — 流式与取消验收

1. 发一个长回答请求，确认文本是**逐字流式**出现的（不是一次性蹦出）
2. 在流式中途点「停止」/ 按 Esc，确认**立即停止**且不报错

## 若失败 — 请收集这些信息

| 症状 | 需要收集 |
|---|---|
| 插件没挂载 | DSH 启动日志全文；`~/.dsh/profiles/desktop/package.json`；`cordis.patch.yml` |
| Models 页面没有 workbuddy | DSH 日志里 `workbuddy:` 开头的行 |
| 模型列表带 `cn:` 前缀 | Models 页面截图 + `curl http://127.0.0.1:7863/v1/models -H "Authorization: Bearer <key>"` |
| 对话报错 | 错误全文 + `curl -X POST http://127.0.0.1:7863/v1/chat/completions -H "Authorization: Bearer <key>" -H "Content-Type: application/json" -d '{"model":"auto","messages":[{"role":"user","content":"hi"}]}'` |
| tool call 没发生 | DSH 日志 + 该模型名（**不是所有 19 个模型都支持 tool call**；plan §0.3 规则 6 要求逐模型验证） |
| 工具结果没回填 | 会话 JSON（`~/.dsh/profiles/desktop/` 下的会话日志） |

## 已知限制（会失败是预期的）

1. **`global:` 模型** — v0.2 阶段禁用。用户的 wb2api 有 0 个 global 账号
   （M06 evidence），选到会走 CN 或报错。
2. **不是所有模型支持 tool call** — plan §0.3 规则 6 明确要求「M01–M10 通过
   的模型才打 Agent 验证标签」。第一次验收建议用 `auto` 或 `glm-5.2`。
3. **OAuth 流程尚未修** — Batch 3 才会改 `credentials.set(ref, value)` /
   `session.commit()`。**这次验收不影响 LLM 路径**（API key 走环境变量）。
4. **余额面板** — 需要 dsh-cost-meter 那边手工配一个 gateway source 指向
   `http://127.0.0.1:<management port>`，key 用启动日志里打出的那个。
   Batch 3 会把这个配置做成自动的。
