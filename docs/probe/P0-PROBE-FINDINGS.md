# dsh-workbuddy-bridge — P0 探针增量 findings（不动 V2.2.1 plan）

> Date: 2026-10-10（PII 章节于同日第二次修订）
> Status: **P0 探针结束；P1 v0.2 实施按"3 批修复"路线推进**
> 这份文件**不修订** `dsh-workbuddy-bridge-plan-v2.2.1.md` 的正文。

## 关于公开 Git 仓库上的敏感数据

PR #1 评审与后续自检发现，早期探针抓取的真实数据曾经进入过公开仓库，分两类：

1. **账号标识类** — `M06-status.json` 与 `M03-login-start-{cn,global}.json` 含真实
   `uid`、nickname、credit / token 计数、OAuth `state` 与授权 URL。
   （**具体值不在本仓库记录**。）
2. **凭证类** — 后续一份 E2E runbook 草稿里写出了本机 wb2api 的 API key。
   该字符串同时被用户用于其他账户，因此按**已泄露的密码**处理。

> **本节刻意不记录任何 commit SHA。** 早先的修订版在这里（以及 Support ticket 里）
> 列出了仍可解析到上述内容的确切 SHA 与 `curl` 命令。那些对象不被 GitHub 代码
> 搜索索引，**只能靠知道确切 SHA 才能访问** —— 所以公开那份清单等于公开一份
> 「去哪里找」的目录。清单已移出仓库。

### 已经做了什么

- 把每个真实值替换为明显的合成占位符，同时保留字段名、类型与结构，
  使 fixture 仍可用于契约测试。计数类字段的算术保持自洽
  （`used = total - remaining`）。
- **逐 commit 验证**重写后的历史：对每个 commit 执行
  `git grep <value> <sha>`，而不是只看工作区 —— 上一轮正是因为只看工作区，
  才误判了"已清理"。
- force-push，使 `refs/heads/*` 与 `refs/pull/*/head` 全部指向干净 commit。
- 本地 object store 已 prune，`git fsck` 无悬空对象。

### 已知残留（不宣称已消除）

- **GitHub 对象存储中仍有 force-push 前的悬空对象**，按确切 SHA 可达。
  force-push 只改 ref，不删对象。只有 GitHub 能清除。
- 任何在清除前产生的克隆、镜像、CDN 或搜索引擎缓存都可能保留副本，
  这部分无法枚举。
- **凭证轮换才是唯一可靠补救**，仓库清理是纵深防御。

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

- `dependencies`：`zod`（schema 需要）
- `peerDependencies`：**仅 `@deepseek-ai/cordis`**（plugin 强依赖 cordis 形状）
- `devDependencies`：`@deepseek-ai/dsh-llm`（固定 `0.2.1-alpha.2`）+ `@types/node` + `typescript` + `vitest`

**`dsh-llm-pi-ai` 不入 peer dep / dep**——它由 base bundle 注入；plugin 直接用此
service 而不引包。**这是 v0.1 评审后的关键修正**：v0.1 想用
`import { ... } from '@deepseek-ai/dsh-llm-pi-ai'` 是错的，会重复装载。

## LLM 路线决策（Batch 2）—— 需要重新评估

**原先锁定 Route B**（自研 `LlmAdapter`），理由是"plugin 不能从
`cordis.patch.yml` 给 dsh-llm-pi-ai 注入 `workbuddy` 路由"。

**但这个理由已被实测推翻。** 用户 desktop profile 的 `cordis.patch.yml` 里
**已经有一条手工配置的 pi-ai 路由**指向同一个 wb2api 网关：

```yaml
abc123:
  apiKeyEnv: ABC123_API_KEY
  api: openai-completions
  baseURL: http://127.0.0.1:7863/v1
  compat: { supportsReasoningEffort: true, thinkingFormat: deepseek }
  models:
    - id: cn:glm-5.3-flash
    - id: cn:deepseek-v4.1-flash
```

并且网关自己的请求日志显示这条链路正在工作：184 次 DSH 请求、全部 HTTP 200、
工具调用与结果回填正常。**Batch 2 的验收门槛"真机 Agent 完成工具调用"因此
已被这条手工配置达成**（不是由本插件达成）。

由此得到三条修正：

1. **`dsh-llm-pi-ai` 的 provider 段是可以被配置的**，只是入口是 profile 的
   `cordis.patch.yml`，不是插件自己的 patch 文件。插件的价值因此从"实现传输层"
   转向"自动生成并维护这段配置"。
2. **`cn:` 前缀端到端可用。** 用户的生产配置用的就是带前缀的 id。原先计划里
   "CN 模型使用无 `cn:` 的 ID"是 **UX 偏好，不是功能约束** —— v0.2 adapter 剥掉
   前缀的做法反而与用户现有配置不一致。
3. Route B 的 `LlmAdapter` 在传输层**可能是多余的**。最终取舍见 Batch 2 收尾记录。

## P0 evidence 文件清单

全部位于 `docs/probe/p0/`（`.scrubbed` 后缀已取消：这些文件即是脱敏后的
唯一版本，不再保留同名的未脱敏副本）：

| 探针 | 文件 | 摘要 |
|---|---|---|
| M01 | `M01-decoration-*` `M01-mcp-*` `M01-loader-and-bundle-fields.md` | DSH `cordis.patch.yml` Loader 真实字段 |
| M02 | `M02-llm-pi-ai-src-*.ts` `M02-llm-core-index.ts` `M02-llm-types.ts` `M02-llm-pi-ai-package.json` | dsh-llm-pi-ai 真实 layout + `GenerateOptions`/`StreamChunk` 类型 |
| M03 | `M03-auth-source.go` `M03-panel-login.go` `M03-cmd-login-main.go` `M03-login-start-{cn,global}.json` `M03-login-poll-{cn,unknown}.json` | wb2api OAuth 真实响应（已脱敏） |
| M04 | `M04-v1-models.json` | 19 个模型 |
| M05 | `M05-curl-samples.txt` `M05c-curl.txt` `M05{c,d,e,f}-body.json` | `cH:` / `CN:` / `global:` 探针 |
| M06 | `M06-status.json` `M06-healthz.json` | 完整 status schema（已脱敏，合成计数） |
| M07 | `M07-healthz-probes.txt` `M07-body.json` `M07e-body.json` | `/healthz` 三态 |
| M08 | `M08-cost-meter-workbuddy-contract.md` | dsh-cost-meter 适配器契约 |
| M09 | `M09-host-route-mechanism.md` `M09-host-webserver-package.json` `M09-webserver-npm.json` | DSH host 路由 |
| M10 | `M10-authorization-and-external-url.md` `M10-dsh-authorization-package.json` `M10-open-in-app-readme.md` `M10-shell-readme.md` | OAuth flow + 外部 URL |
| M11 | `docs/probe/official-types/*` | **DSH 官方类型完整源码**（v0.2 contract base） |
| M12 | `M12-base-bundle-*.yml/json` | base bundle 装载的 plugin 清单 + cordis.patch |

P0 整合报告：`docs/probe/p0/P0-PROBE-REPORT.md`
Batch 2 真机验收步骤：`docs/probe/BATCH2-E2E-RUNBOOK.md`
