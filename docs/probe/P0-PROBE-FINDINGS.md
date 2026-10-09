# dsh-workbuddy-bridge — P0 探针增量 findings（不动 V2.2.1 plan）

> Date: 2026-10-10
> Status: **P0 探针结束;P1 v0.2 实施按"3 批修复"路线推进**
> 这份文件**不修订** `dsh-workbuddy-bridge-plan-v2.2.1.md` 的正文。

## 关于公开 Git 仓库上的 PII

PR #1 评审中发现 v0.1 抓的真实 `M06-status.json` 与 OAuth probe 文件包含**真实账号标识**：

- `M06-status.json` 包含 2 个真实 `uid`、2 个真实 nickname，以及真实 credit / token 计数（**具体值不在本仓库记录**）。
- `M03-login-start-{cn,global}.json` 包含真实 OAuth `state` UUID 与真实授权 URL（**具体值不在本仓库记录**）。

**这部分内容已经推到 `p0-probe` 分支的 git history（commit `REDACTED-SHA`）。** 仅靠后续 commit 覆盖不能消除风险——GitHub 镜像、PR 检出的 PR 子 fork、reviewer 缓存都可能保留历史内容。

**当前 git history 的真实情况**：
- `REDACTED-SHA` (P0 evidence import) — 包含脱敏前 PII
- `REDACTED-SHA` (P1 v0.1) — 不含 PII（v0.1 代码不引用这些 JSON）

**当前这一批（1.3）**:
- `M06-status.json` 被替换为 `M06-status.scrubbed.json`（带 `_scrubbed: true` 标记，所有 uid/nickname 改为 scrubbed-xxx 占位，credit 数字保留为 fixture 但**非真实数据**）
- `M03-login-start-{cn,global}.json` 被替换为 `M03-login-start-{cn,global}.scrubbed.json`（state UUID 改为 scrubbed 占位）
- `M03-login-poll-{cn,unknown}.json` 不含 PII，保留原样
- `M06-status.json` / `M03-login-start-*.json` 的**原始 PII 数据**保留在本地工作区 `C:\Users\MoJingJing\Documents\deepseek-harness\default-workspace\p0-probe\evidence\`，**不**进入 git

**第二批（1.4）**会使用 `git filter-repo` 改写 commit `REDACTED-SHA` 引入 PII 文件之前的状态（即把 `REDACTED-SHA` 改为不包含 PII 的等价提交）。这需要：

1. **先做整个仓库的私有备份**（用户机器其他位置）——git filter-repo 改写后无法恢复
2. 通知 PR #1 reviewer 重新拉取 `p0-probe`
3. force-push `p0-probe` 分支
4. 通知 PR #1 重新加载

> 已知局限性：GitHub PR 检出的 fork、网络镜像、reviewer 本地 clone 都可能仍保留旧 commit。**降低风险而非消除风险**。

## 锁定的 DSH Desktop 版本

通过读取 `C:\Users\MoJingJing\.dsh\profiles\desktop\package.json`（用户 desktop profile 的 `dsh.profile.bundles`），v0.2 锁定为以下基线：

| Bundle | 角色 | v0.2 是否需要 peer dep |
|---|---|---|
| `@deepseek-ai/dsh-base` | DSH 核心 runtime（包含 dsh-llm / dsh-llm-pi-ai / dsh-authorization / dsh-credentials-local / dsh-llm-deepseek-api-key / dsh-agent / dsh-session / dsh-tool-* 等） | **否**——由 base bundle 注入 ctx.* |
| `@deepseek-ai/dsh-web-app` | 渲染层 | 否 |
| `@deepseek-ai/dsh-experimental-agent-team-profile` | agent runtime | 否 |
| `dsh-cost-meter@1.8.15` | 余额 UI | **devDep only**（仅用作 contract test fixture 的导入） |
| 其他社区 plugin（dsh-chart / dsh-ui-tweaks / dsh-whale-widget / @local/dsh-pwsh-persistent） | 与本插件无关 | 否 |

**v0.2 真正写进 `package.json` 的依赖**：

- `dependencies`:**空**（plugin 自身 zero runtime deps 之外，可能用 zod）
- `peerDependencies`:**仅 `@deepseek-ai/cordis`**（plugin 强依赖 cordis 形状）
- `devDependencies`:`@deepseek-ai/cordis` + `typescript` + `vitest`（仅 build/test）

**`dsh-llm-pi-ai` 不入 peer dep / dep**——它由 base bundle 注入 `ctx.inject(['llm-pi-ai'])`；plugin 直接用此 service 而不引包。**这是 v0.1 评审后的关键修正**：v0.1 想用 `import { ... } from '@deepseek-ai/dsh-llm-pi-ai'` 是错的，会重复装载。

**LlmAdapter 路线决策**（Batch 2 锁定）:**Route B — 自研 Adapter extends `LlmAdapter` 基类**，不用 dsh-llm-pi-ai 配置。理由：

1. base bundle 装载的 dsh-llm-pi-ai 已按 pi-ai catalog 注册，**plugin 不能从 `cordis.patch.yml` 给 dsh-llm-pi-ai 注入 `workbuddy` 路由**（loader 只插包名，不接受 inline config）
2. 自研 Adapter 走 `ctx.llm.registerAdapter(['workbuddy'], adapter)` —— 与 dsh-llm-pi-ai 默认 catalog 互不干扰
3. 类型用 `@deepseek-ai/dsh-llm` 的真实 `LlmAdapter` / `GenerateOptions` / `StreamChunk`（**type-only import**）

## P0 evidence 文件清单

全部位于 `docs/probe/p0/`：

| 探针 | 文件 | 摘要 |
|---|---|---|
| M01 | `M01-decoration-cordis-patch.yml` `M01-mcp-cordis-patch.yml` `M01-loader-and-bundle-fields.md` | DSH `cordis.patch.yml` Loader 真实字段 |
| M02 | `M02-llm-pi-ai-src-*.ts` `M02-llm-core-index.ts` `M02-llm-types.ts` | dsh-llm-pi-ai 真实 layout + `GenerateOptions`/`StreamChunk` 类型 |
| M03 | `M03-auth-source.go` `M03-panel-login.go` `M03-login-start-{cn,global}.scrubbed.json` `M03-login-poll-{cn,unknown}.json` `M03-cmd-login-main.go` | wb2api OAuth 真实响应（已脱敏） |
| M04 | `M04-v1-models.json` | 19 个模型 |
| M05 | `M05-curl-samples.txt` `M05-case-probes.txt` `M05c-curl.txt` | cH:/CN:/global: 探针 |
| M06 | `M06-status.scrubbed.json` | 完整 schema（**已脱敏**） |
| M07 | `M07-healthz-probes.txt` | /healthz 三态 |
| M08 | `M08-cost-meter-workbuddy-contract.md` | dsh-cost-meter 适配器契约 |
| M09 | `M09-host-route-mechanism.md` `M09-host-webserver-package.json` `M09-webserver-npm.json` | DSH host 路由 |
| M10 | `M10-authorization-and-external-url.md` `M10-dsh-authorization-package.json` `M10-open-in-app-readme.md` `M10-shell-readme.md` | OAuth flow + 外部 URL |
| M11 | `docs/probe/official-types/*` | **DSH 官方类型完整源码**（v0.2 contract base） |
| M12 | `M12-base-bundle-*.yml/json` | base bundle 装载的 plugin 清单 + cordis.patch |

P0 整合报告:`docs/probe/p0/P0-PROBE-REPORT.md`
P0 关键发现与 V2.2.1 对照(本文件)
