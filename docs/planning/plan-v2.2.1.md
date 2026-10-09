# dsh-workbuddy-bridge — 完整实施计划 V2.2.1

> 日期：2026-10-10（北京时间）
> 状态：**V2.2.1 = V2.2 + 第二轮复审 5 条 P0 前清理 + P1 顺手改**；架构与阶段不变；剩余 P2/P3 修订在对应阶段边界合并
> 目标：将本人持有的腾讯 CodeBuddy / WorkBuddy 账号，通过现有 WorkBuddy2API 网关，以 DSH 插件的形式实现**账号认证、模型选择、余额观察、网关管理与可选的一键自构建**。
> 拟发布包：`dsh-workbuddy-bridge`；插件自身拟采用 MIT。
> 基准上游：`linguo2625469/workbuddy2api-panel` `v1.13.0`（2026-10-08），tag 对应 commit `REDACTED-UPSTREAM-SHA`。
> DSH 参考版本：`dsh-v0.2.1-alpha.2`（2026-10-09）；落地时以用户实际安装的 DSH 版本/API 为准。
> 审查原则：下面分为**源码已核实事实**、**设计决定**及**仍需真实环境验证的假设**，不得把计划当作实测报告。
> 本版本相对 V2.2 的变更摘要见 `REVIEW-CHANGELOG-v2.2-to-v2.2.1.md`。
>
> **V2.2 → V2.2.1 一句话差异**：5 项合并残留 + 3 项技术细节的定点清除（`cH:` 大小写敏感判定、虚构包路径、Attach 数据保护措辞、Shell bridge 措辞、风险表 block-criterion 同步）；P2/P3 阶段修订按对应阶段检查表内化处理。

### 0.1 最终产品目标不变

最终用户体验应为：在 DSH 中安装插件 → 打开 WorkBuddy 插件页 → 无需事先安装独立 wb2api 即可选择「一键部署」→ 浏览器授权本人账号 → 自动出现可用模型（或一键导入）→ 在 DSH Agent 中使用 → 查看余额、连接与故障状态 → 手动检查和升级网关。

插件在未部署网关时仍然可以加载 UI、说明缺失组件、提供连接现有网关或自构建选项；**不得把有 wb2api 当作安装插件的强制前提**。

### 0.2 方案取舍

| 路线 | V2.1 决策 | 原因 |
|---|---|---|
| A 探针 + 最小 Attach 骨架 | **合并为 P0**（单一阶段） | A 与 minimal Attach 业务代码高度重叠，合并避免重复造 HTTP client / schema / provider configurator |
| B' Attach 完整 MVP | **P1 阶段交付** | 用户已经运行 wb2api 时，不应重复构建、复制或接管进程 |
| C 携带固定版本源码 + 用户触发自构建 | **保留为最终 Managed 能力（P2/P3）** | 达成一站式目标，但须在 P0/P1 验收后实施 |
| D 自动下载上游预编译二进制 | 不作为默认主路 | 额外涉及可执行文件信任、供应链与作者分发立场 |
| 净室重写网关 | **从正常路线删除** | 不是退出发行/条款风险的可靠捷径；工作量过大 |

**重要：C 不是被取消，而是改变实施顺序。** P0/P1 以「已有网关连接」验证插件是否真能完成业务；通过后，再把自构建封装成对用户透明的 Managed 模式。

### 0.3 六项不可妥协的规则（含理由）

1. **真实调用协议必须是 `openai-completions`，不能用 `openai-responses` 直接对接当前 wb2api。**
   *理由：当前 wb2api 不支持 `/v1/responses` 路径，仅有 `/v1/chat/completions`。*
2. **CN 模型在 Harness 中使用无 `cn:` 的 ID**；当前 wb2api 对无前缀 ID 默认走 CN（参见 §1.1 决策表），因此 CN 请求不需要再加回前缀。
   *理由：`resolveModel("glm-5.2") ≡ resolveModel("cn:glm-5.2")`，重复前缀是死代码。*
3. **Attach 模式不拥有外部进程、旧配置、账号凭证或其升级权；Managed 模式只管理自己创建的数据目录和进程。**
   *理由：合法保留用户原 wb2api 状态、避免与外部网关写入同一份 `auths/` 造成双写。*
4. **所有登录、修改配置、构建、升级和导入须有明确的 Host 端操作、错误反馈和生命周期回收；UI 不直接访问文件系统或持有 OAuth 密钥。**
   *理由：浏览器安全模型边界；UI 直接持有 refresh token 等违反最小特权与浏览器可观察性约束。*
5. **网关的 `healthz` 返回 `503` 不是进程死亡的充分条件**；存活、身份和业务就绪独立建模（参见 §7.3）。
   *理由：503 = 可用账号 / 池已满，不触发 watchdog 重启；liveness / identity / readiness 三态分离。*
6. **未经真实 DSH Agent 工具调用验收，不得宣称「支持全部 19 个模型」或「Agent 完整兼容」。**
   *理由：模型存在（`/v1/models` 列出）≠ Agent 能跑通；只有 M01–M10 通过的模型才打上「Agent 验证通过」标签。*

### 0.4 V1 支持的宿主形态（**V2.2 修订：踢出 Linux Desktop 出首版**）

DSH 当前正式 Desktop 打包目标集中在 **Windows x64、macOS arm64、macOS x64**（见 `apps/desktop/README.md`），**Linux 不是 DSH 官方发布目标**。

| 运行环境 | 首版定位 |
|---|---|
| Windows x64 Desktop | ✅ **主要验收平台** |
| macOS arm64 Desktop | 🟡 需真实测试后纳入 |
| macOS x64 Desktop | 🟡 需真实测试后纳入 |
| Linux DSH Web / CLI + Attach（仅用 HTTP 模式） | 🟡 可后续适配 |
| Linux Desktop（含 Managed） | ❌ **非官方发布目标，不作首版承诺** |

- **支持**：DSH Desktop Windows x64 / macOS arm64 / macOS x64（**主要验收 Windows x64**）
- **不承诺**：Linux Desktop 上 Managed 模式可用性；用户在 Linux Desktop 上的体验不在首版 SLA 内
- **不做**：DSH Web / SDK / CLI / headless 上的 Managed；Web 后续可经 Attach 模式适配
- **Linux 实际可运行**是另一回事（wb2api 可执行、DSH 可从源码运行等），但**不作首版承诺**：DSH 升级路径、SmartScreen/Gatekeeper 之外还有其他 Linux 特定 issue（SELinux、glibc、snap/flatpak 限制等），需要独立目标版本专项验收

详细见 §2.4 + §13。

---

## 1. 已核实的接口事实与需要验证的事项

### 1.1 已核实：wb2api v1.13.0

以下依据 `v1.13.0` Go 源码；行号锚点见 §16。

| 能力 | 真实接口/行为 |
|---|---|
| 聊天 | `POST /v1/chat/completions`，支持流式和非流式 |
| 模型发现 | `GET /v1/models`；模型列表动态获取，CN ID 带 `cn:` |
| 账号/额度状态 | `GET /status`（需要 API key，除非原配置允许匿名） |
| 进程存活/容量 | `GET /healthz`，无鉴权；响应有 `service` 和 `X-Service`；可能因不可接单而返回 503 |
| 管理面板总览 | `GET /panel/api/overview` |
| 管理面板模型 | `GET /panel/api/models` |
| OAuth 启动 | **`POST /panel/api/login/start`**，可传 `{"realm":"cn"}` |
| OAuth 轮询 | **`GET /panel/api/login/poll?state=...`** |
| OAuth 完成 | 网关在自己的 `auths/` 下写入凭证并热加载账号；不需要插件保存 refresh token |
| 面板操作鉴权 | `/panel/api/*` 使用与网关配置相关的鉴权，不可假定匿名 |
| 默认端口 | `:7863`，不是只绑定回环地址；托管模式必须显式改为 `127.0.0.1:<port>` |
| `go.mod` | Go `1.22.5`；当前依赖不要求主动引入 CGO，但跨平台结果仍需实测 |

**无前缀的关键源码语义**（`internal/server/resolve_model.go`，§16 锚点 R1）：见下列决策表，作为 §5.2 去前缀算法的依据：

| 输入 | `resolveModel` 输出 (realm, bare) | HTTP wire |
|---|---|---|
| `glm-5.2` | `(cn, glm-5.2)` | `glm-5.2` |
| `cn:glm-5.2` | `(cn, glm-5.2)` | `glm-5.2` |
| `global:glm-5.2` | `(global, glm-5.2)` | `global:glm-5.2` |
| `cn:auto` | `(cn, auto)` | `auto`（须在 UI 标注为"上游自动路由"） |
| `MINIMAX-M3`（其他合法厂商） | `(cn, MINIMAX-M3)` | 同裸名 |
| `cH:glm-5.2`（非小写域名前缀） | `(cn, cH:glm-5.2)` | `cH:glm-5.2`（**冒号和前缀原样透传**，易以错误模型名打到上游） |

> **V2.2.1 修正**：wb2api `resolveModel` 是**大小写敏感**的（见 `internal/server/resolve_model.go` 第 22 行：`if prefix != "cn" && prefix != "global" { return "cn", model }`）。`cH:glm-5.2` 不会"走默认 CN 裸名"，而是**把 `cH:glm-5.2` 整体作为模型名透传**——这是非常容易被上游拒绝或映射到错模型名的危险路径。**插件层必须在 §5.2 算法里主动拒绝**：`cn:` 必须是精确小写 `cn:`、`global:` 必须是精确小写 `global:`；其他任何含 `:` 的形式（含 `cH:`、`CN:`、`Global:`、`Cn:`、纯厂商前缀如 `openai:`、`anthropic:`）一律拒绝并提示用户改成裸名或规范小写前缀。

**`/healthz` 503 不等于进程死亡；`/healthz` ≠ 身份认证**（§7.3 详解）：

- 503 可能由以下任一原因触发，均不构成重启依据：
  - 无可用账号（账号池为空，全部被禁用 / 全部 cooldown）
  - 所有账号在途请求已达 `max_in_flight`
  - 健康账号数 = 0（即 `total > 0 && healthy == 0`）
- **Managed 子进程退出的最直接判据**：进程 `exit` / `close` 事件 + 操作系统进程不存在查询（`tasklist` / `kill -0`）—— **不**需要等待 `/healthz` 网络失败才确认
- **`/healthz` 返回的 `service: workbuddy2api` 与 `X-Service` 头**：仅做"识别冒充服务"用，不构成进程身份认证；任何停止进程或访问写操作的授权必须基于"已记录的进程所有权"（PID + 启动时间 + 可执行摘要 + 端口 + 配置路径），**不**基于 `/healthz` 字符串值

**必须纠正文档 V1 的两处接口错误：** 原 `/panel/api/auth/login`、`/panel/api/auth/poll` 路径不存在；本计划不依赖假想的 `{device_code,user_code,verification_uri}` 标准响应。`login/start` 当前返回 `{ok,url,state,realm}`，`state` 是临时会话标识（**不写入日志 / 不持久化**），由网关在用户浏览器回调完成后内部流转；P0 探针阶段需要拿到完整 curl 样本 + 字段集。

**核验路径（如 §16 网络可达受限）：**
- 上游仓是 MIT 开源项目，可信源 = 源码本身
- 所有"已核实"标签背后最终依赖 `git clone v1.13.0` 对应的源码行号
- §16 已列出 7 处关键代码定位与 GitHub permalink，可作为独立性验证候选

### 1.2 已核实：DSH 源码和官方插件说明

- `@deepseek-ai/dsh-llm-pi-ai` 自定义 provider 使用 `api: openai-completions`、`baseURL`、`apiKeyEnv` 和显式 `models` 列表；用户设置可以动态影响其路由配置。
- DSH 能从兼容接口**发现候选模型**，但模型发现不会自动覆盖用户已经配置的列表；**发现 ≠ 纳入可选模型目录**（P0 探针必须实测验证）。
- DSH 官方插件开发方案有 Host 插件、`dsh.client` 浏览器侧插件、Slots、设置扩展和 Host 操作接口；React UI 不能仅凭本地 `jsx` 文件自动加载。
- DSH `dsh-subprocess-local` 提供进程执行与一些平台级回收能力，但是否适合长生命周期守护服务，需要进行集成测试（参见 §7.2）。
- `resolveDshHome()` 实际默认从显式路径 / `$DSH_HOME` / `~/.dsh` 决定数据目录；**不等于 Electron `app.getPath('userData')`**。在三个 OS 上具体差异：

  | OS | `resolveDshHome()` | Electron `userData` |
  |---|---|---|
  | Windows | `%USERPROFILE%\.dsh` | `%APPDATA%\<AppName>` |
  | macOS | `$HOME/.dsh` | `~/Library/Application Support/<AppName>` |
  | Linux | `$HOME/.dsh` | `~/.config/<AppName>` |

- DSH 的模型核心列表校验没有发现"一律拒绝冒号"的规则；**用户已经报告其当前 Harness 使用路径无法正确识别 `cn:`**，因此以该实际约束设计 CN 无前缀接入，但不要把这一现象宣称为 DSH 所有版本的全局限制。

### 1.3 P0 必须实测、不能按文档推定

- DSH 实际版本和插件运行时 API、安装 bundle 的方式、UI 真实扩展点；
- DSH Agent tool-call 循环是否能够通过 wb2api 正确完成；
- SSE 分帧、参数拼接、`tool_call_id`、工具结果回填、多轮历史、取消请求；
- `glm-*` / `deepseek-*` / `kimi-*` / `minimax-*` 中各取一个可用模型做能力采样；只有通过的才打上「Agent 验证通过」标签；
- 登录轮询、余额字段、错误响应 JSON 与当前安装网关版本是否一致；
- 正确注册到 DSH Provider/Model 页面，修改配置后下一次请求实际生效；
- 非默认安装路径、用户原配置、空账号池和限额场景。

### 1.4 上游仓可用性假设（新增）

> **评估日（2026-10-10）：** `linguo2625469/workbuddy2api-panel` 主仓公开可访问。
>
> **若未来主仓被删 / 镜像失效**：本插件须仅依赖已 `vendor` 的 `v1.13.0` tarball/git bundle；**新用户不再能获得自动升级**，但已合法安装的本地副本按 MIT 永久保留复制、修改、再分发权利（§9.2）。
>
> **触发后的 plan B 路径**：见 §9.3；本阶段不再承诺净室重写（仅可作为未来独立项目评估）。

---

## 2. 范围、非目标与产品边界

### 2.1 P1 MVP 包含

1. 插件在无网关时可安装、加载、打开设置页；
2. Attach：指定 `http://127.0.0.1:<port>`、API key，测试连通性；
3. 面板：连接状态、账号列表/余额概要、模型发现列表、诊断消息；
4. 浏览器 OAuth：启动登录、轮询、取消 UI、登录成功刷新账号；
5. 从网关动态模型候选集中选择模型，**显式**注册到 DSH `workbuddy` provider；
6. 用 `openai-completions` 完成 Agent 对话；
7. 插件升级/禁用时不破坏原有 wb2api 进程、配置和账号；
8. 不依赖构建 Go、不强制用户提前安装网关。

### 2.2 P2/P3 Managed 包含

- 从特定已审查的 wb2api commit 源码构建本地二进制；
- 用户首次点「一键部署」时，下载/校验 Go 工具链与依赖（若本机无可用且兼容版本）；
- 单实例进程管理、端口分配、状态隔离、重启、停止、回滚；
- 手动检查更新、展示上游 changelog、升级前验证和自动回滚；
- 独立的管理目录、构建缓存、运行日志以及诊断导出（脱敏）；
- 可选导入旧数据，但必须是有备份的显式动作。

### 2.3 V1 不做

- 自动批量注册账号、购买/交易账号、向其他用户转售 API 或共享账号池；
- 自行实现腾讯私有协议、改写 OAuth 内部机制、规避服务风控；
- 净室重写 WorkBuddy2API 核心；
- 浏览器端直接接触 refresh token；
- 静默自动替换正在运行的网关；
- 用默认 CN 无前缀路径直接开放 global 模型（见 §5.4）；
- 向腾讯官方服务承诺稳定性或条款合规性。

### 2.4 V1 支持的宿主形态（**V2.2 修订：Desktop only，并把 Linux Desktop 踢出首版**）

- **支持**：DSH Desktop（Electron）
  - **Windows x64** —— 主要验收平台
  - **macOS arm64** —— 需真实环境测试后纳入
  - **macOS x64** —— 需真实环境测试后纳入
- **不做首版承诺**：
  - **Linux Desktop** —— DSH 官方文档（`apps/desktop/README.md`）明确"Linux is not a supported Desktop release target"；Linux 上 DSH 可从源码运行，但本插件不在 Linux Desktop 上做任何官方验收承诺（SmartScreen / Gatekeeper 之外的 SELinux / glibc / snap 等 issue 需要独立目标版本专项验收）
  - DSH Web / SDK / CLI / headless 上的 Managed —— Managed 必须 `child_process.spawn`，与 Web / headless 模型不兼容；Web 后续可经 Attach 模式适配
- **可后续适配**：DSH Web 仅走 Attach 模式（不提供 Managed 一键自构建 UI）；DSH CLI 仅供单元测试与脚本化诊断

---

## 3. 目标架构与职责

```text
DSH Client UI (dsh.client + 官方 Slot)
  ├─ 状态/账号/模型/设置/诊断
  └─ 用户操作 → DSH 授权的 Host 端调用
                      │
                DSH Host Plugin
  ├─ WorkBuddyService（唯一业务入口）
  ├─ GatewayClient（鉴权 HTTP + 超时 + zod/等价 schema）
  ├─ AuthController（login/start & login/poll）
  ├─ ModelCatalog（发现、规范化、用户确认应用）
  ├─ ProviderConfigurator（只管理 workbuddy provider 的配置）
  ├─ GatewaySupervisor（Attach 不管理 / Managed 有所有权）
  ├─ BuildManager（仅 Managed P2）
  ├─ UpdateManager（仅 Managed P3）
  └─ Secret/StateStore（密钥隔离、状态持久化）
                      │
              localhost HTTP /v1/*
                      │
              WorkBuddy2API v1.13.0
                      │
             腾讯 CodeBuddy/WorkBuddy
```

**原则：** UI 只向 Host 发"操作意图"；HTTP 调用、密钥读取、文件管理、网关进程管理均由 Host 执行。业务操作只实现一次，然后通过 UI（及可选 agent tools）共享；无权的 agent 不能伪造用户确认的构建/登录/导入操作。

### 3.1 模块职责

| 模块 | 唯一职责 | 明确禁止 |
|---|---|---|
| `GatewayClient` | 封装 `/v1/models`、`/status`、面板 API，返回结构化错误 | 直接编辑 `auths/` |
| `AuthController` | OAuth 发起、轮询、取消 UI、状态过期处理 | 自行保存 refresh token |
| `ModelCatalog` | 动态发现/规范化/去重/防冲突，携带原 ID | 伪造模型可用性 |
| `ProviderConfigurator` | 在用户许可下写入 `workbuddy` provider 模型目录 | 覆盖其他 provider 或未修改字段 |
| `GatewaySupervisor` | 仅对 Managed 自有进程负责启停、存活与退出 | 杀死 Attach 的旧 wb2api |
| `BuildManager` | 校验固定源码、Go 工具链、完成构建 | 启动时任意拉取 `main` 并执行 |
| `UpdateManager` | 可信版本比较、更新计划、回滚 | 只凭 tag 与 SHA 的字符串比较升级 |
| `StateStore` | 数据目录、所有权元数据、审计信息及迁移 | 明文日志输出 API key |

### 3.2 宿主插件装载约束（**V2.2 占位：cordis.patch.yml 与 peerDependencies 不在 V2.1 给可信示例**）

**V2.2 状态**：本节是**占位**，不提供任何虚构示例。

#### 约束（保留）

- 采用官方 `dsh.bundle.patch` + `cordis.patch.yml`，遵循**实际安装的 DSH 版本** Loader 的配置格式；
- Host 插件通过包入口导出 `apply(ctx)`，订阅、定时器、注册与关停必须通过 DSH/Cordis 提供的 dispose / cleanup 机制回收；
- Client 插件通过 `package.json` 里的 `dsh.client` 配置 + 独立客户端模块 + Slot 注册机制加载；React UI **不**自动从本地 `jsx` 文件加载；
- 必须先核实当前安装版本支持的 Slot 与 Host-to-Client 通信机制；**不允许**虚构 `ctx` API 或 Loader 字段名；
- `peerDependencies` 只能声明**实际存在于目标 DSH 仓库 `packages/*`** 的包，且版本约束必须与对应包当前的 `package.json#exports` 与发布版本兼容；
- 资源、图标、翻译、客户端构建产物必须进入 npm tarball；
- 外部 bundle 的首次安装与启用遵守 DSH 官方安装路径，避免直接覆写用户 profile 目录。

#### V2.1 错误示例（已删除，**禁止复制**）

> V2.1 §3.2 给出的 `cordis.patch.yml` 例（`host.apply` / `host.services` / `client.slots` 等字段）与 `peerDependencies`（`@deepseek-ai/dsh-core`、`@deepseek-ai/dsh-host-runtime`、`@deepseek-ai/dsh-client-runtime` 等）**未经实测**验证：Loader 字段与包名不能照搬到 V2.2。
>
> 任何带这些字段的旧 V2.1 例都不能进入 V2.2 实现阶段。

#### P0 必须实测校准的清单（新增）

1. 在干净的 DSH profile（不带本插件）中：`grep -r "@deepseek-ai/" packages/*/package.json`，得到**实际可用**的 host / cli 包名清单；
2. 选定目标 DSH 版本后，到 `packages/<目标包>/package.json` 查 `exports` 字段、版本号、`main` / `module` 入口；
3. **Cordis Host**：阅读 `packages/preset/agent-preset/skills/cordis-plugin-development/templates/decoration`（按 §3.2 链接）给出的真实 `cordis.patch.yml` 模板；DSH 官方插件示例含 `id` + `name` + `config`，Loader 字段集合以此为准；
4. **Cordis Client**：阅读 `templates/decoration` 同目录下的 client 模板得到真实 Slot 注册机制与 `package.json.dsh.client` schema；
5. **Host API**：根据第 1 步拿到的**真实包名清单**，定位到对应 `node_modules/<真实包>/` 目录，读取实际导出（`apply(ctx)` 签名 / 可用 services）；**禁止**预设 `@deepseek-ai/dsh-host-runtime` 这类未经核实的包名路径。步骤产物：实测出的"DSH Host API 签名 + 可用 services 列表"两件套；
6. **跨版本兼容**：用相邻两个 DSH 版本（如 `v0.2.0-rc.2` / `v0.2.1-alpha.2`）实测插件能否正常加载；
7. 把以上结论填入 §11 P0 验证清单（"插件骨架最小可运行"项）的子条目，避免后期重审又出现"未验证 Loader 字段"问题。

#### 官方模板 vs §3.2 占位

审查人建议**直接采用 DSH 官方 `templates/decoration`** 作为 P0 起点，而不是维持 §3.2 的完全空白。"占位 + 7 项实测清单"语义保留：

- §3.2 文档**仍不**写具体 Loader 字段（避免重蹈 V2.1 虚构示例）；
- **P0 第一步**改为"克隆 `packages/preset/agent-preset/skills/cordis-plugin-development/templates/decoration` 到本地，按其结构写本插件的 patch"，把模板校验过的字段作为**唯一可信来源**；
- P0 阶段把模板实际使用的字段记录到本节作为"已实测"补遗，相应 §3.2 占位从空白转为"实证附录"。

> **V2.2.1 修正**：V2.2 §3.2 第 5 项写了 `~/.dsh/profiles/desktop/node_modules/@deepseek-ai/dsh-host-runtime/` 这种虚构路径；现已删除本路径，按 P0 实测出的真实包名定位。

---

## 4. 核心流程 A：连接模式与配置保护

### 4.1 两种模式必须互斥

**Attach（连接已有网关，**V2.2.1 修订：明确 REST 写入权限边界**）：**

- 用户手动输入或明确选择发现到的 `127.0.0.1:<port>`；
- 验证 `/healthz` 的服务标识、`/v1/models` 权限和相关 API 是否匹配；
- 使用用户提供的 API key，存到 Host 允许的 secret/credential 存储；
- **REST 写入权限**：经过用户授权的网关 REST 操作（OAuth 添加账号、模型注册等）可以正常修改**网关自己的状态**——这是与"不修改外部工作目录"不冲突的。Attach 模式下"不修改"特指：
  - 不直接操作外部网关文件系统（`auths/`、`config.json`、`data/`）
  - 不 kill 外部网关进程
  - 不 upgrade 外部网关
  - 不替换外部网关版本
- REST 操作能完成的账号添加 / 余额刷新等场景由插件 UI 走 HTTP 调用完成，**不**走"插件 → 直接编辑外部 auths/ 文件"；
- 插件卸载后外部网关继续运行。

**Managed（插件托管）：**

- 在独立工作目录生成自己的 `config.json`（绝不复用原网关工作目录作为写入目标）；
- 显式设置 `listen=127.0.0.1:<reserved port>`、非空随机 `api_key`、绝对 `auth_dir` 和 `state_file`；
- 所有构建、运行与升级操作仅针对本插件创建、经所有权记录验证的实例；
- 插件可管理该进程；退出策略必须可配置为「随 Host 停止」或「继续运行并显示状态」，默认随 Host 优雅停止；
- 多实例同时启动应使用文件锁和进程身份校验，第二个实例选择 Attach 至自有实例或显示冲突，不得启动双写实例。

### 4.2 Import（可选迁移，**V2.2 修订：保证来源文件读取一致性**）

仅用户点击「从现有安装导入」才启动：

1. 检测来源路径并说明将复制哪些文件；
2. **保证来源一致性**：把源 wb2api 实例**停止 / 暂停**（或冻结其写入）后读取数据；运行中的实例或被另一进程并发写入的实例**必须先停**才能导入。**不允许**在源仍可变期间做"读 → 写目标"动作。
3. 确认目标 Managed 实例未运行、无写入者（与 §4.1 隔离规则一致）；
4. 在目标 staging 目录备份 / 复制，经结构化解析验证后原子替换目标私有目录；
5. 不修改原始 `config.json` / `auths/` / `data/`；
6. 遇到冲突、字段不兼容或正在使用时中止并保留源数据；
7. 目标失败时可还原备份、重新尝试，**不删除用户源文件**。

**不得默认把旧目录复制到 `$DSH_HOME` 并与外部网关双写。**

### 4.3 跨平台冲突矩阵（**V2.2 修订：去掉 Linux Desktop 强保证**）

| OS | 主要冲突 | 应对 |
|---|---|---|
| Windows | 正在运行的 PE 二进制无法覆盖（ORB 锁） | immutable 版本目录 + 进程 inactive 切换；staging 重命名 `MoveFileEx(MOVEFILE_REPLACE_EXISTING)` 必须等 SIGTERM + grace 完成 |
| Windows | long path（260 字符限制） | 启用 `\\?\` 前缀；构建路径控制在 240 内 |
| Windows | SmartScreen 误报 | README 提示 EV 代码签名证书或个人双击信任 |
| macOS | Gatekeeper quarantine | UI 给"右键打开"提示，**不**自动 `xattr -d com.apple.quarantine` |
| macOS | code signing | 自构建产物无 Apple Developer ID；首次启动需用户授权 |
| **Linux** | **非首版承诺（§2.4 / §13）—— 本表格不再列入 Linux 强保证；只在用户主动在 Linux Desktop 跑通并报告后才登记已知问题到 §13 P1** |
| All | Go toolchain 下载 | 不走 npm `postinstall`（DSH pnpm 11 默认禁）；改为首次启动时 Node 原生 fetch 下载官方 `go<ver>.tar.gz` → 校验 SHA256 → 解压到 `cache/toolchain/` |
| All | 端口探测 TOCTOU | V1 实施 §7.2 的"用户手动指定"fallback（自动端口分配留待 wb2api 接受 OS 端口 0 分配后）；详见 §7.2 |

---

## 5. 核心流程 B：模型 ID 与 Agent 兼容

### 5.1 必须按已验证协议接入（**V2.2 修订：明确 apiKeyEnv 路径**）

**协议层（实测）：** 当前 wb2api 只提供 `POST /v1/chat/completions`，所以应使用 `openai-completions`。

**凭证路径（V2.2 收敛）：** `apiKeyEnv` 是 DSH 凭证服务的引用；具体路径在 §3.2 P0 阶段实测后填入。一条**必须达成**的事实：

- 用户在插件 UI 填入 wb2api API key → 经 Host 的 credential write 接口存入 DSH 凭据库 →
- 配置 provider 时引用一个**变量名**（如 `WB2A_API_KEY`）→
- DSH `llm-pi-ai` 在请求前从凭据库解析该变量为真实 key →
- 实际 HTTP 请求头携带 `Authorization: Bearer <key>` 发到 wb2api。

P0 阶段必须完成"写入凭据 → 引用 → 解析 → 真实模型调用"完整链路实测，**不允许**只验证 REST 客户端层就声称支持。

**配置入口（**仍按 V2.1**：不在用户文件上拼 YAML；用 DSH 官方 Provider/Model 注册 API）：**

- 业务模块 `ProviderConfigurator`（§3.1 表格）调用 DSH 官方 Host/Settings API 完成 provider 注册；
- 端口与模型 ID 列表动态生成；
- 上下文窗口等元数据来源 = `/v1/models` 返回（如可用）。

> ❌ **禁止**：在 V2.1 里假设 `apiKeyEnv: WB2A_API_KEY` 即可被 DSH 解析——具体 API / 字段名以 §3.2 实测为准；本节不重复 V2.1 的伪示例错误。

### 5.2 CN 模型去前缀——明确的正式规则

```text
网关模型 ID: cn:glm-5.2
Harness ID:  glm-5.2
HTTP model:  glm-5.2
实际路由:    wb2api 默认 CN
```

**去前缀只发生在模型发现/注册层；CN 请求前不加回 `cn:`。**

算法：

1. 从 GET `/v1/models` 读原始 `id` 与有用元数据；
2. 仅 `id.startsWith('cn:')` 时截去精确的前 3 个字符，禁止任意字符串替换；
3. 非法或空裸 ID、无效元数据项必须跳过并记录诊断；
4. `upstreamId`、`realm`、`publicId`、`displayName` 四字段分别保存，不丢原始 ID；
5. 按 `publicId` 检测冲突，遇到不同上游 ID 映射成同一 publicId 时拒绝自动导入并提示；
6. 显示名称可以友好化，但不能凭猜测把模型 ID 改成其他厂商"官方名称"；
7. 特殊项 `cn:auto` 可映射为 `auto`，但必须把该模型标注为"上游自动路由"，不可当固定模型能力声明；
8. 用户点击"应用到 DSH"之后，才将选中的模型显式写入 provider 配置；保留用户之前手工禁用或修改的模型；
9. 刷新目录不自动删除正在使用或曾被用户手工注册的模型，只把它们标为"当前上游未发现"，需要用户确认移除。

输入 → 输出的对照表（与 §1.1 决策表等价，此处重申以方便 §5 实现查阅）：

| 网关 ID（raw） | publicId | realm | displayName | 是否注册 |
|---|---|---|---|---|
| `cn:glm-5.2` | `glm-5.2` | cn | "GLM 5.2" | ✅ |
| `cn:auto` | `auto` | cn | "Auto Router" | ✅（UI 标注"上游自动路由"） |
| `global:glm-5.2` | 暂不映射 | global | "GLM 5.2 (global)" | ❌（§5.4 单独 gate） |
| `cn:hy3-x` | `hy3-x` | cn | "Hunyuan 3 Extended" | ✅（displayName 友好化） |

### 5.3 动态元数据与真实能力

优先以 `/v1/models` 返回的 `context_length` / `max_output_tokens` / reasoning 相关字段为数据来源，但它们只是**网关宣称值**，应记录 `source=gateway`；缺失时允许保守 fallback 并显示"待验证"，不得以推断值宣传确切能力。

明确记录：基础文本、Agent 工具调用、多轮、流式、图片输入（如果存在）、推理档位、限额错误。任何模型只有在该能力真实测通后才显示"验证通过"。

### 5.4 global 模型（后续单独门禁）

`global:<name>` 如果直接改成裸 `<name>`，wb2api 会默认路由 CN，**不能这样做**。V1 只开放 CN，global 在 UI 中可显示为"暂不支持/待适配"。

后续全球区方案必须满足其一：

- **优先**：验证目标 DSH 版本是否能对同一模型维护"UI 公开 ID"与"wire ID"两个独立字段；如果官方扩展点明确支持则使用；
- **备选**：独立只监听回环地址的透明本地 Adapter Proxy，公开唯一无冒号 alias（如 `wb-global--<name>`），只对受控请求将模型字段改为 `global:<name>`，SSE 响应原样转发，同时保持授权、停止与端口隔离。

global 未实测前禁止把它混入 CN 目录；同名模型也不得覆盖。

### 5.5 Agent 真实验收（P0 阻断项）

| ID | 测试 | 预期 |
|---|---|---|
| M01 | 单次非流式对话 | 返回完整文本，错误码合理 |
| M02 | SSE 文本流 | 正确结束、无重复/丢帧 |
| M03 | 触发 1 次工具调用 | 名称、JSON 参数和 ID 保真 |
| M04 | 工具执行结果回填 | 下轮模型可见工具结果并给出最终答复 |
| M05 | 连续 2 次工具调用 | 两次均能完成，无重复执行 |
| M06 | 多轮历史 | 上轮事实保留，system/tool role 不错乱 |
| M07 | 用户取消 | 上游连接中断或正确终止，不误重试 |
| M08 | 401、429、402/额度耗尽、503 | 错误可区分，不能当作进程崩溃 |
| M09 | 上下文与输出限制 | 不因错误宣称容量而丢数据或非法截断 |
| M10 | 一次模型切换 | 模型选择与真正上游请求一致 |

M03/M04 不通过则不得进入 P1"可用 Agent 插件"发布；修复应优先落在兼容层，禁止为了通过测试暗中更改用户工具结果或绕过授权。

---

## 6. 核心流程 C：OAuth 登录、额度与账户状态

### 6.1 登录流程（严格复用真实 API）

```text
用户点击「添加账号」
  → Host POST /panel/api/login/start   {"realm":"cn"}
  ← {"ok":true,"url":"https://...","state":"...","realm":"cn"}
  → 校验 HTTPS URL 的合法性，使用 §6.1.1 分级浏览器打开能力
  → UI 每约 3s 请求 Host，Host GET /panel/api/login/poll?state=...
      ├─ done=false：显示等待授权
      ├─ 完成：网关负责落盘凭证/热加载，插件刷新 /status
      ├─ 超时/异常：提示重试与具体错误
      └─ UI 取消/卸载：停止轮询，清理本地 session
```

- 会话有效期采用网关实际行为；v1.13.0 的 `loginTTL` 为 15 分钟（具体常量名以 P0 探针阶段 `login.go` 校准后填入），不要自造永久有效的轮询。
- `state` 视为敏感临时标识；不出现在日志、分析事件和持久配置里。
- 浏览器返回不由插件强制解析 token；**网关独立完成换 token、落盘和池热加载**。
- 登录 URL 校验仅接受期望的 HTTPS 腾讯/WorkBuddy 来源（域名白名单随版本维护）；不得任意打开网关返回的 `file:`、本地脚本或不可信外站。
- Attach/Managed 的账号认证都通过 REST，不同模式只改变进程与数据所有权。
- `login/poll` 完成后的响应 schema 必须对照真实样本制定，允许未来增加字段但不默默接受缺失必需字段。

### 6.1.1 浏览器打开能力分级（**V2.2.1 修订：Host 运行环境与 Electron 模块加载边界**）

V2.2 把 `shell.openExternal` 称为"Electron Renderer API"是错的（Electron 同时支持 main 与 unsandboxed renderer；DSH Host 运行环境能不能加载 `electron` 模块是另一个问题）。V2.2.1 改正：

- `shell.openExternal` 在 Electron main 进程与 unsandboxed renderer 中**都**可用；
- 但 DSH Host 插件运行在 DSH 自身的宿主进程（main 进程 / Node worker / 独立 Node 子进程）—— **是否**能直接 `require('electron').shell` 取决于 DSH 是否向 Host 暴露 electron 模块；多数插件模板不鼓励直接依赖 Electron；
- 因此正确做法是：**先探测 DSH 是否提供受支持的"外部浏览器打开"bridge 接口**（P0 阶段以实测为准，具体服务名以 §3.2 / §11 P0 实证附录填入）；若不可用则一律走"复制 URL"按钮。

| 宿主形态 | 打开方法 | Fallback |
|---|---|---|
| Desktop (Electron，DSH 提供 bridge) | 调用 DSH 提供的 bridge 接口（具体名以 P0 实测为准） | 用户拒绝 / 接口不可用 → "复制 URL" 按钮 |
| Desktop (Electron，DSH 未提供 bridge) | 退化为"复制 URL" 按钮 | — |
| Web | 不尝试；显示 URL + 复制按钮 | — |
| CLI / SDK / headless | 不尝试；显示 URL + 复制按钮 | — |
| 公司管控设备（系统级屏蔽外部浏览器） | 退化为 "复制 URL" 按钮 | — |

V1 仅交付 Desktop 形态，但 UI 实现须从一开始就**不假设** DSH 一定会提供 bridge 接口，**总是**渲染"复制 URL"按钮作为兜底；具体打开方法通过 §3.2 实测的 DSH Host shell bridge 调用。

### 6.2 状态与额度

- `GET /status`：账号数、健康/冷却/禁用、每账号余额和已知模型锁等；当前版本 JSON 字段需采样并以宽容读取/严格核心字段的 schema 验证。
- UI 使用 15–30 秒可配置轮询，窗口隐藏时减频或暂停；失败指数退避；主动余额刷新需用户点击，避免大量上游请求。
- 不把 `/healthz` 的 503 当成服务故障；并分别显示"网关进程存在""服务标识匹配""账号可接单"。
- 余额刷新、OAuth 等失败不得触发无限重试或账号批量切换。

---

## 7. 进程状态机与宿主生命周期（Managed 专用）

### 7.1 状态

```text
UNCONFIGURED → ATTACH_READY（用户连接外部实例）
             → BUILD_REQUIRED（用户选择 Managed）
BUILD_REQUIRED --用户授权--> FETCHING_TOOLCHAIN/SOURCE → BUILDING → READY_STOPPED
READY_STOPPED → STARTING → RUNNING
RUNNING ↔ DEGRADED（无可用账号、限流、HTTP 503，不代表进程退出）
RUNNING → STOPPING → READY_STOPPED
RUNNING → CRASHED → BACKOFF → STARTING（限次）
RUNNING → UPDATE_AVAILABLE → STAGING_UPDATE → SWITCHING → RUNNING
                       更新失败 → ROLLING_BACK → RUNNING / NEEDS_ATTENTION
```

状态变化必须带原因码、时间戳和用户可读信息。Attach 仅有 `DISCONNECTED/CONNECTED/DEGRADED` 连接态，不允许出现"杀进程/升级成功"的虚假状态。

### 7.2 所有权和启动（**V2.2 修订：删 Linux 兜底伪代码**）

- **优先评估** DSH 已有的 `dsh-subprocess-local` 能否承担长期服务的启停/取消/退出需求；若不满足，再建独立 `GatewaySupervisor`，并通过 Cordis dispose 管理生命周期。结论由 **P0 探针阶段** §11 P0 验证清单给出。
- 不使用 `detached:true` + `unref()` + Electron `before-quit` 作为唯一退出机制；Host 可能在 CLI / Web / 桌面端运行，不依赖 Electron 上下文。
- 如果自己用 `child_process.spawn` 管理 Managed 进程，使用：
  - 绝对可执行文件路径、参数数组形式（**不要**手工拼字符串）
  - `shell:false`、`windowsHide:true`
  - 限制 stdout / stderr 上限并独立收集
- **不要**依赖以下伪代码模式（V2.1 已被审为不可靠）：
  - ~~`spawn({detached:false})` + `process.kill(-pid, signal)`~~
  - ~~`spawn({detached:true})` + `unref()` + 监听父进程 `exit`~~（Linux / PID 1 / detached 等边界不可靠）
- **进程组所有权**（推荐机制，由 P0 选型确认）：
  - 创建新进程组（POSIX `setsid`、Windows Job Object）作为**进程容器**
  - 停止时向进程组发信号；进程组回收失败再按 PID 终止，仍失败则视为僵尸
  - 实际代码由 P0 / P2 选型确认（DSH `dsh-subprocess-local` 是否提供容器需实测）；现阶段**不在文档中给出伪代码**
- 进程 ownership 文件至少包含：schema version、instance UUID、PID、进程启动时间、宿主进程身份、可执行文件绝对路径及摘要、端口、配置路径；**仅 PID 匹配不足以允许 kill**。
- **端口策略（V2.2 修订：留 fallback，不假设自动分配）**：
  - V1 **不**实现"自动选择未占用端口"；wb2api 当前不支持绑定 `127.0.0.1:0` 后回报实际端口，需要外部补丁（超出 V1 范围）。
  - 首版走"用户手动指定端口"路线：在 UI 展示 7863/7864/7865 三个端口预选项，让用户确认或输入自定义端口；端口被占（`EADDRINUSE`）立刻提示换端口。
  - 内部**禁止**"扫描空闲端口再 bind"路径（TOCTOU）；不要做端口猜测或 `SO_REUSEADDR` + 假设独占监听这种伪独占。
  - 实现自动分配须以**wb2api 接受 OS 随机端口 + 受控启动通道上报**为前提；本计划不预先承诺。
- 进程退出后可有限次重启，例如短窗口最多 3 次，之后停机并提示；不要依据 `cooldown` 伪造进程崩溃原因。
- 对 Managed 停止：先发 SIGTERM/等价正常终止，等待可配置宽限（默认 5s）；之后才执行强制终止。当前 wb2api Go server 已处理 `SIGTERM`，可进行优雅关闭与状态 Flush。
- Attach 的关停、禁用、卸载均不得终止外部进程。

### 7.3 存活、身份、就绪三重探测

- **Liveness**：子进程 exit/close、操作系统可验证进程存活，决定是否重启。
- **Identity**：请求 `GET /healthz`，核对 `service` 和 `X-Service`，不接受其他占用相同端口的 HTTP 服务冒充。
- **Readiness**：`/healthz` 的 200 或 503 + `/status` 元数据，决定是否可以接单。503 可能是无账号/账号池满；**不能触发 watchdog 重启**。
- `/healthz` 网络失败不立即杀进程：结合 Liveness 和超时规则后再诊断。

---

## 8. 自构建方案 C（Managed 增强）

### 8.1 分发结构（概念）

```text
dsh-workbuddy-bridge/
├─ package.json
├─ LICENSE                         # 本插件原创部分的 MIT
├─ THIRD_PARTY_NOTICES.md
├─ README.md
├─ cordis.patch.yml                # 最小 patch 模板见 §3.2
├─ src/                             # Host: client/auth/model/process/build/update
├─ client/                          # DSH Client UI 注册与编译资源
├─ scripts/                         # pack/build/license 检验
├─ vendor/wb2api-source/            # P2 打包时已预先 vendor 的固定版本源码
│  ├─ LICENSE                       # upstream 原始 LICENSE，必须完整保留
│  ├─ go.mod / go.sum
│  └─ ...
└─ manifest/
   ├─ upstream-lock.json            # repo/tag/commit/archive_sha256
   ├─ toolchains.json               # Go 下载平台、版本、校验信息
   └─ protocol-fixtures/            # 已验证响应样本（脱敏）
```

**注意：** npm 发布包不应真的打包 Go 工具链，初次 build 才在用户明确同意后下载并缓存；`vendor` 源码是构建输入而非运行时写入位置。实际 `npm pack --dry-run` 必须验证源文件进入包，包内不包含用户密钥。

### 8.2 用户运行时目录

```text
$DSH_HOME/workbuddy-bridge/
├─ state/                           # plugin.json, ownership.json, migration metadata
├─ managed/
│  ├─ config.json
│  ├─ auths/
│  └─ data/
├─ runtime/versions/<version>/<platform-arch>/wb2api[.exe]   # 版本化不可变
├─ runtime/active.json              # { "version": "<v>", "switchAt": ..., "buildId": "..." }（V2.2 起）
├─ runtime/previous.json            # 回滚目标（V2.2 起）
├─ build/staging/<build-id>/         # 不覆盖当前运行版本
├─ cache/source/<commit>/
├─ cache/toolchain/<go-version>/<platform-arch>/
├─ logs/                             # 限容量、敏感信息过滤
└─ backups/                          # 有数量/保留期限制
```

使用 DSH `resolveDshHome()` 而非硬写 Electron `userData`；必要时针对 DSH 安装形态做路径映射测试。配置中 `auth_dir`、`state_file` 必须指定绝对路径，不依赖进程工作目录。写入密钥文件采用平台适合的最小权限，优先用 DSH credential storage 保存桥接密钥引用。

### 8.3 首次构建

1. UI 告知第三方源码、来源、下载项目/规模与潜在服务条款风险；用户点击「构建并安装」。
2. 检查已有本机 Go 是否满足固定构建版本；否则经同意下载 **官方 Go 工具链**并核对可信发布摘要，禁止执行未验证的安装脚本。
   > **DSH pnpm 11 兼容说明**：Go 工具链以官方二进制 tar.gz / zip 形式下载并解压到 `cache/toolchain/<go-version>/<plat-arch>/`，**不在** `package.json` 中添加 `postinstall`，以兼容 DSH 桌面端 pnpm 11 的默认禁用设置。下载与校验使用 Node 原生 fetch + 用户确认 UI 控制。
3. 固定上游 `v1.13.0` 对应 commit `REDACTED-UPSTREAM-SHA`；从已打包的源码或已锁定可信归档恢复到隔离 staging；校验来源完整性。
4. 使用锁定 `go.mod`/`go.sum` 解析模块；尽量采用可信模块代理与 checksum database，处理离线和代理失败；不修改原用户 Go 环境。
5. 以受控参数执行 `go build -trimpath -o <staging-binary> ./cmd/server`（构建入口应先以目标 tag 在三平台实际验证）；记录 Go 版本、目标 OS/arch、exit code、产物 SHA256、构建日志末尾。
6. 运行 `--help` 或安全的 smoke test（以真实 CLI 支持情况核验，当前 Go main 以 `-config` 接收配置），单独绑定回环随机端口，验证 `/healthz` 服务身份与基本路由，再停止测试进程。
7. 将构建成功的版本目录原子标记为 available，等待用户点击启动；失败则删除 staging，不影响现有版本。

**不能将本地生成的 SHA256 与同一次构建自生成的 manifest 比较，作为"来源可信"的证明。** 完整供应链验证链见 §8.3.1。

### 8.3.1 供应链验证（**V2.2 修订：拆三段独立验证，删除"X-Service 与 build manifest 一致"的密码学身份误用**）

V2.1 把"上游 commit / archive / toolchain / go.sum / build product / X-Service"统称"多源证据链"，但把 `go.sum` 当作"独立的源码可信性证明"以及把 `X-Service` 与 build manifest 比对，**这两项均属错误**：

- `go.sum` 由上游源码一同分发，**不能**作为对上游源码本身的独立可信性证明；
- `X-Service` 只是字符串常量 `"workbuddy2api"`（见 v1.13.0 `internal/server/handler.go`），**不**是密码学身份认证，攻击者可伪装同一字符串；
- 因此"启动期服务身份与 build manifest 一致"是**不成立**的。

V2.2 把供应链验证拆成三段，每段独立成立：

#### 段 A：下载完整（确认拿到的是预期内容）

| 验证目标 | 方法 | 证据来源 |
|---|---|---|
| 1A 上游 commit SHA | git ls-remote（或 pinned commit 在仓内静态校验） | release 公告 / GitHub Release 元数据（可信第三方来源） |
| 1B archive SHA256 | 对下载的 tarball / zip 计算 SHA256，与 GitHub Release 元数据中字段比对 | 与 1A 同源但**完全独立计算路径**（计算时不参与 manifest 生成） |

#### 段 B：本地产物完整（构建完成后二次校验）

| 验证目标 | 方法 |
|---|---|
| 2A 构建产物 SHA256 | 构建完成立即计算；与段 A 哈希不参与计算——这才是"完整性自检"（self-consistency），不是来源证明 |
| 2B manifest 完整性 | 构建产物 metadata（路径、Go 版本、目标 OS/arch、exit code、构建日志末尾）落盘到 `runtime/versions/<v>/manifest.json`，与 `wb2api.sha256` **互不参与**生成 |

> 注：自我一致性不等于"我下载的东西就是上游发布的那个"——这个保证由段 A 给。

#### 段 C：运行身份（**V2.2 改名并明示边界**）

| 验证目标 | 方法 |
|---|---|
| 3A 进程所有权 | OS 进程身份校验（PID + 启动时间 + 可执行文件路径 + 摘要），不允许单凭 PID 决定操作 |
| 3A 受控端口 | 端口约定为用户手动指定 / 经 attach URL 校验（§7.2）；不假设唯一监听 = 安全身份 |
| 3B 服务身份识别 | 请求 `/healthz`，核对 `service` 字段与 `X-Service` 头 = `"workbuddy2api"` —— 仅用来**区分冒充服务**（不接受绑定同端口的其他 HTTP 服务冒充），**不**作为密码学身份认证 |

#### V2.2 撤除

- ~~`go.sum` 不作为上游源码可信性证明~~
- ~~启动期把 `X-Service` 当构建身份比对~~
- ~~"多源证据链"作为统一说法（过于乐观）~~

#### V2.2 保留

- 固定上游 commit SHA；v1.13.0 Release 的 `checksums.txt`（实测内容如下）覆盖**预编译二进制**的 SHA256：
  ```
  3e7a2bc9ea92246103de7777d59fe1f3351ada5bfa979f90dabf25bcc941eaa8  wb2api-panel-v1.13.0-windows-amd64.zip
  43e3d1ce5b2f5fa91ebf5f145f4aacb36ad6d7dde4d6e49b6cea9c652f9b1fc9  wb2api-panel-v1.13.0-darwin-amd64.tar.gz
  de0d0b31e100eb8fda85cbbc03d8b0e31b7ee950b2e9a1f38afab5c86755c049  wb2api-panel-v1.13.0-darwin-arm64.tar.gz
  24681ed5cae01062f21e2c3d8038009137f1d2cac42b2223e8ac78dddfe90e75  wb2api-panel-v1.13.0-linux-amd64.tar.gz
  4a9c4768595534892cf8ba78696070f1a741d4ddc51592587288fc6d9753db7b  wb2api-panel-v1.13.0-linux-arm64.tar.gz
  ```
- **V2.2.1 重要补充**：`checksums.txt` **不**含源码 archive 的 SHA256；wb2api Release 不提供源码 archive attachment（GitHub 自动 `tarball_url` / `zipball_url` 不是 release assets）。因此 V1 必须：
  - 把 v1.13.0 源码 archive **在发行前由受控流程**生成并固定 SHA256（先 git clone + git checkout + tar 打包，发布时校验）；
  - 不要"首次下载时边下载边生成可信预期值"；
  - 段 A 的可信第三方源 = "受控流程在发行前生成的源码 archive SHA256"，写入 `manifest/upstream-lock.json`。
- Go 工具链 SHA256（`go.dev` 官方下载页校验）
- 本地构建产物 SHA256（`wb2api.sha256`）
- 进程所有权校验 + `/healthz` 服务身份识别

### 8.4 版本管理/升级

- 以 GitHub Release tag/commit 作为身份；按 GitHub release 元数据和提交 ancestry/显式发布顺序判断候选版本，绝不 `tag_name > pinned SHA`。
- 定时**检查并提示**，不默认静默构建、替换和重启；升级需用户确认并展示版本差异。
- 新源码在 staging 中构建，成功后写入到 `runtime/versions/<new-v>/<platform-arch>/`（**版本化不可变目录**），**不覆盖**正在执行的 `wb2api.exe`（Windows 特别重要）。
- **V2.2 active 切换机制（修订：用 `active.json` 而非 rename of `active`）**：

  在 `runtime/` 下：
  ```text
  runtime/
    versions/
      v1.13.0/           # 不可变版本目录
      v1.14.0/           # 不可变版本目录
    active.json          # { "version": "v1.14.0", "switchAt": ..., "buildId": "..." }
    previous.json        # { "version": "v1.13.0", "switchAt": ... }（回滚目标）
  ```

  切换流程（每步独立可失败、独立回滚）：

  1. 写入新版本到 `runtime/versions/<new-v>/<platform-arch>/`（**不可变**：只写不覆盖）；
  2. backup 当前 `active.json` → `previous.json`；
  3. 写入**临时文件** `runtime/active.json.tmp`（内容是 `{ version: <new-v>, switchAt: <ts>, buildId: <id> }`）；
  4. **平台替换提交**：在 POSIX 上 `rename(2)` 是原子的；在 Windows 上 `MoveFileEx(MOVEFILE_REPLACE_EXISTING)` 替换；这一替换若失败（磁盘满、权限）则保留旧 `active.json`；
  5. supervisor 停旧进程（`SIGTERM` + grace），启动新进程（按新 `active.json` 指示路径）；
  6. 启动期校验：①新版本 wb2api 二进制 SHA256 与 `runtime/versions/<new-v>/wb2api.sha256` 一致；②`/healthz` 返回 `service: workbuddy2api`；③`/v1/models` 返回与新版本预期模型目录一致；任一不通过则**回滚**：恢复 `active.json` 为旧值，重启旧实例；
  7. **数据迁移仅在 schema 变更时执行**：旧数据 `managed/state.json` 写一份到 `backups/pre-<new-version>-<ts>/`，运行新版本时按需迁移；任何 schema 假设必须由 P0 阶段实测，**不在** Managed 启动时凭"看起来差不多"自动迁移。

- **二进制切换 ≠ 数据迁移成功**：版本切换成功不代表数据格式兼容。两件事必须分别验收：
  - 二进制切换（步骤 1–6）：新版本可拉起、`/healthz` 服务可识别；
  - 数据迁移（步骤 7）：现有 `managed/state.json`、`auths/` 不被新版本静默改坏；必要时由用户显式触发迁移并人工确认。

- 切换必须在没有在途请求或用户显式确认后才能开始；切换中冻结数据文件写入方（Managed 子进程在新版本启动完成前**不**写任何 `state.json`）。
- 旧版本二进制保留为 `runtime/versions/<old-v>/`（便于回滚）；Managed 数据 `managed/config.json`、`managed/auths/`、`managed/data/` 跨版本持久，仅在 schema 变更时迁移。
- 若当前有业务请求：等空闲/用户选择停止，尽可能优雅下线旧实例；保留旧 binary 和目标 Managed 数据备份（只在需要迁移时）；再启动新版本。
- 校验新版服务身份、登录状态读取和模型目录，失败则停止新进程并回滚到旧版本；新版可能改写数据格式，必须先检测/备份，不能只回退 exe。
- 更新启动后冻结数据文件写入方，避免新旧版本对同一 `state.json` 双写。
- 上游仓库不可访问或新版本协议不兼容：**保持现有版本与 Attach 模式可用**；参见 §9.3 上游应对策略；本阶段不再承诺净室重写。

---

## 9. 安全、隐私、许可证和服务条款

### 9.1 默认安全要求

- Managed 只监听 `127.0.0.1`；非空强随机 `api_key`；所有 `/v1/*` 与面板调用按网关 API key 鉴权。
- 不向浏览器 UI 传递 refresh token、auth JSON 全内容、明文 API key 或上游 HTTP Authorization Header；UI 仅获得脱敏账号状态与操作结果。
- 日志敏感信息过滤（token、cookies、OAuth state、配置 secrets）；诊断导出必须二次脱敏。
- 不自动信任 7863 端口：先核实服务身份，Attach 由用户确认目标地址。
- Managed 文件、build cache、备份、更新包只存在用户自有隔离目录；限制权限和磁盘占用。
- 不使用 `shell:true`、拼接未验证命令或动态执行上游脚本。
- 账号删除/修改权限必须显式提示，不提供"后台自动批量注册/切号规避风控"机制。

### 9.2 二次分发

- 上游 `v1.13.0` `LICENSE` 是 MIT，允许在其许可条件下分发修改或原样源码；需完整保留其版权和许可说明，记录来源/固定版本。对本插件原创代码另放 `LICENSE`。
- **MIT 授权在已获得许可版本上为 perpetual + irrevocable**：即便上游仓删库，已分发的 v1.13.0 二进制/源码仍按原条款保留用户的复制、修改、再分发权利（前提是完整保留版权与许可声明）。
- 上游 README 对二次打包及售卖表达反对（README 段含作者自我承认的"关于开源协议的诚实说明"，明示这不是协议条款）；即使 MIT 授权允许某些复制/再分发行为，仍建议尊重社区关系、避免宣传为官方或原作者支持。
- **MIT 源码许可不代表腾讯账号和未公开服务接口的使用许可**；服务条款、技术访问条件、账号限制需要单独评估，**不得再写"法律风险为零"**。
- 用户自有账号自用与公开发布工具也可能面对不同的条款及发行风险；发布前核实最新条款，必要时专业法律复核。
- 依赖许可清单必须覆盖 npm、Go 模块、vendored assets；不能只运行 JavaScript `license-checker` 就当作全依赖审计。
- **依赖许可审计命令**（实际 CI 化，**V2.2 修订 `go mod why` 不是 license 工具**）：
  ```bash
  # npm 侧（报告每个依赖的协议 SPDX）
  npx license-checker --production --csv --out licenses-npm.csv

  # Go 模块侧（V2.2：go mod why 解释依赖图，不检查协议；改用 go list -m -json 配合许可证扫描）
  # 列出所有直接 + 间接 Go 模块
  go list -m -json all > go-modules.json
  # 对照 Go 官方/社区 license 数据库或上游 LICENSE 文件判断
  # 实际脚本由 P0 阶段产出

  # vendored 源码侧（手工核对，因为 wb2api 自身 LICENSE 在 vendor 下）
  find vendor/ -type f \( -name LICENSE -o -name LICENSE.md -o -name NOTICE -o -name NOTICE.md \) \
    -print -exec head -40 {} \;

  # CI gate：在 PR 上运行这套命令；任何"未知 / 非 OSI 批准"许可证要阻断合并
  ```
- 注：V2.1 把 `go mod why -m all` 当许可证工具使用是错误的；该命令解释模块依赖来源、**不**做许可证扫描。本节按 P0 / P2 实测后给出实际可用的 Go 许可证扫描命令（首选：依赖 DB + 本地 LICENSE 比对）。
- 最小化数据收集；默认无遥测、无中转服务、不代管用户账号。

### 9.3 作者反对/上游下架时的应对

1. 停止自动分发存在争议的新版本，冻结已知稳定 tag；
2. 维持不捆绑源码的 Attach 插件发行模式；
3. 明示不保证上游继续可用，且不冒充上游官方；
4. 已经合法安装的用户本地副本如何继续使用，单独检查许可证与适用条款；
5. 如未来真的需要独立实现，另立项目、重新开展技术/法律设计评估，**不承诺删除源码后抓包就天然构成净室重写**。

> 本节同时被 §11 P3 退出条件、§13 风险表 P0/P1 行交叉引用；任何与上游可信性相关的 plan B 路径均回到此处。

---

## 10. 用户界面与交互

### 10.1 页面导航

| 页面 | P1 | P2/P3 |
|---|---|---|
| 首次启动 | 「连接已有网关」和「稍后设置」；插件不能白屏 | 新增「一键自构建 Managed」 |
| 状态 | API、服务身份、账号可用性、诊断错误 | 进程版本、PID（可脱敏）、构建状态、启动/停止/重启 |
| 账号 | OAuth 添加、自有账号、余额、冷却信息 | Managed 备份/导入工具 |
| 模型 | 动态获取、CN 无前缀、选中后显式应用 DSH、测试按钮 | global 单独入口（未来） |
| 设置 | Attach URL、API key 引用、刷新策略 | 构建缓存路径、更新、日志保留、版本回滚 |
| 诊断 | 测试连通性、错误码、脱敏日志 | 构建记录/版本切换/失败回滚原因 |

### 10.2 UI 状态规则

- 不可用按钮必须解释原因，不允许"点击无响应"；
- 不能以图标绿色仅凭 HTTP 200 表示模型可用，模型能力要标注「已验证/未验证/当前不可用」；
- OAuth 登录轮询时显示等待状态、取消按钮与剩余有效期；
- 网络错误、鉴权错误、余额耗尽、网关无可用账号、进程退出必须是不同文案；
- 长时间构建有明确进度或当前阶段，不能编造百分比；
- 用户可关闭设置界面，不得触发异常中断；插件卸载会清除定时器和订阅；
- 不在 Client 端直接访问 `127.0.0.1` 来绕过 Host 安全边界。

### 10.3 UI State Model（**新增**）

| 页面 | 加载态字段 | 用户输入字段 | 派生字段 |
|---|---|---|---|
| 首次启动 | `attachCandidates`, `attachError` | `manualUrl`, `manualApiKey` | `effectiveMode` |
| 状态 | `process`, `connection`, `identityVerified` | — | `healthSummary` |
| 账号 | `accounts`, `quotaRefreshPending` | — | `availablePoolCount` |
| 模型 | `catalog`, `selected`, `imported` | `includeRealm`, `excludeKnown` | `applied` |
| 设置 | `attachConfig`, `managedConfig`, `refreshPolicy` | — | — |
| 诊断 | `lastTestRun`, `recentErrors` | `redactLevel` | `safeExportAvailable` |

---

## 11. 分阶段实施与验收门槛

> 工作日指有效工程投入，具体周期随执行模型、宿主平台及腾讯侧实际可用性变化。**每一阶段必须达到验收条件后才能进入下一阶段；不能用"代码已生成"代替验证。**

### P0 — 真实协议与扩展点探针（3–5 工作日，**包含最小 Attach 骨架**）

**交付物：** `evidence/p0/`，包含版本信息、脱敏 HTTP 响应样本、配置最小实例、Agent 测试记录和阻断 BUG 列表。

- [ ] 记录 DSH 实际版本、运行环境和插件安装/设置扩展 API；
- [ ] 使用已有 wb2api 实例，确认 `/v1/models`、`/status`、`/healthz`、OAuth 两个真实端点；
- [ ] 建立最小 `workbuddy` `openai-completions` provider，模型 ID 为裸 `glm-5.2` 或其他真实可用 ID；
- [ ] 验证至少一个模型的 M01–M07，特别是 M03/M04 工具调用闭环；
- [ ] 确定用户报告的 DSH `cn:` 识别问题发生在哪一层，保留裸 ID 适配与回归测试；
- [ ] 明确配置写入应通过哪一个 DSH 官方 Host/Settings API，以及模型列表刷新后如何持久化；
- [ ] 明确 UI Slot、Client/Host RPC 与插件生命周期；
- [ ] **最小 Attach 骨架**：仅运行时配置 + DSH 凭据服务解析的 apiKeyRef（**禁止**在源码或 fixtures 中嵌入真实 API key），能跑通 M01 / M02 / M03（不要求 OAuth、不要求完整 UI）。

**退出条件：** 真实 Agent tool call → tool result → final answer 通过，且能在 DSH 中找到并切换该模型。未通过则优先修复协议兼容，不转做 UI/Build。

### P1 — Attach 可用 MVP（6–9 工作日）

**交付物：** 可安装 DSH 插件、Host REST 客户端、Client UI、最小测试集合和 README。

- [ ] 插件空环境可安装，显示"未连接"；
- [ ] Attach 连接、API key 存储、服务身份校验及错误处理；
- [ ] 添加账号的 OAuth `login/start` + `login/poll`；
- [ ] 查看 `/status` 额度和可用性；
- [ ] 动态发现模型、精确 `cn:` 去前缀、用户确认导入 provider；
- [ ] 按官方 Slot 注册 UI，确保组件卸载清理；
- [ ] 单元测试 HTTP schema、模型映射、错误码；
- [ ] 端到端跑通 Agent M01–M10 中适用测试；
- [ ] 安装/禁用/卸载插件均不影响已存在的外部 wb2api。

**退出条件：** 使用已有网关完成"插件中登录 → 选择模型 → Agent 工具调用 → 查看余额"。

### P2 — Managed 自构建与生命周期（5–10 工作日，**V2.2.1 修订：Linux 验收改非阻断性**）

**交付物：** 初次构建向导、源码 pin、Go 构建、版本目录、持久 Supervisor 与私有配置。

- [ ] 用户选择构建，**受控流程生成的源码 archive SHA256** 校验（§8.3.1 段 A 修订；不依赖 GitHub Release `checksums.txt`，因为它不含源码 archive）；
- [ ] Windows x64 初次 build 和独立启动先通过（**首要完成条件**）；
- [ ] macOS arm64 与 x64 依实际支持承诺验收（**真实测试机到位才纳入发布**）；
- [ ] Linux Desktop 不在首版发布目标；用户在 Linux 上跑通并报告的问题，登记到 §13 风险表 P1 而**不**作为 P2 退出阻塞；
- [ ] 独立 `config.json`/`auths`/`data`，回环监听和用户手动指定端口 + 随机 API key；
- [ ] 端口绑定失败的明确重试规则：用户手动指定 → `EADDRINUSE` 立即换提示，不假装实现自动端口分配；
- [ ] 所有权证明、单实例防重、端口冲突处理；
- [ ] `healthz 503` 不触发重启（详见 §7.3 + §1.1 修订）；
- [ ] 优雅停止，崩溃限次重启，禁用/退出清理；
- [ ] 构建失败保持 Attach 模式可用；
- [ ] smoke test 用**明确指定测试端口**（如 7863），绑定失败即报错更换，不据此宣称实现了自动端口分配（§8.3 修订）。

**退出条件：** 在全新 Windows 环境中不预装 wb2api，实现"安装插件 → 选择一键构建 → 登录 → Agent 对话"；构建失败不损坏原数据。**macOS / Linux 在不阻断 P2 退出条件下独立登记**。

### P3 — 更新、迁移、跨平台与发布（7–12 工作日）

**交付物：** 上游版本检查、升级与回滚、可选 Import、安全审计、CI 测试报告、npm 发布候选包。

- [ ] 版本比较与来源验证，不自动跟踪 main；
- [ ] 执行流量清空/优雅下线后才切换新版本；
- [ ] Windows 不尝试覆盖正在运行的 exe（§8.4 不可变目录 + `active.json` / `previous.json` 切换，**不**用 `runtime/active` 目录或 symlink）；
- [ ] **V2.2.1 升级数据迁移顺序（§8.4 修订）**：构建新版并检查兼容性 → **先停旧进程、确认数据写入结束** → 备份 `state.json` **+ `config.json` + `auths/` + 其他可能变化的文件**到 `backups/pre-<new-v>-<ts>/` → 必要时迁移至隔离目录（**不**直接覆盖）→ 提交 `active.json` → 启动新版 → 验证 → 失败时**回滚 active.json + 旧二进制 + 旧数据**；新版可能改写数据格式，不能只回退 exe；
- [ ] 新版本失败二进制和配置都可回滚；
- [ ] Attach/Managed/Import 三种所有权规则测试；
- [ ] 密钥、日志、备份与 npm 包内容审计；
- [ ] 支持平台完整 happy path 和 failure path；
- [ ] README 中英、贡献者致谢、免责声明、MIT/依赖许可证；
- [ ] §11.5 NPM Publish Readiness Checklist 全过；
- [ ] `npm pack --dry-run`、安装、禁用、卸载、重装均通过。

**退出条件：** 明确标记每个平台的已验证程度；发布包没有用户数据；无已知 P0/P1 缺陷。

**总工作量预估：21–36 有效工作日（合并 P0 后）。** 14–28 是经验资深开发者可能达到的乐观区间，不可作为 DoD 承诺。

### 11.5 NPM Publish Readiness Checklist（**V2.2.1 修订：每平台独立发布，不豁免**）

V2.2 §11.5 第 8 项写了"三平台不具备真实环境时该项标注'未验证'，不作为发布阻塞"——这是自我豁免，与 V1 Desktop-only / 真实测试承诺矛盾。V2.2.1 改正为**每平台独立发布**：

- **Windows x64** 通过实测 → 可发布 `latest` 标记
- **macOS arm64 / x64** 通过实测 → 可同步发布 `latest` 标记；未实测则**不**列入发布支持矩阵
- **Linux Desktop** 不在首版发布目标（§0.4 / §2.4）

| # | 项 | 状态 |
|---|---|---|
| 1 | 包名（scope vs non-scope）确定 | ☐ |
| 2 | 版本号与 dist-tag (`latest` / `beta`) 锁定 | ☐ |
| 3 | `--provenance` / OIDC 签名配置 | ☐ |
| 4 | registry 选定（private npm vs public npm） | ☐ |
| 5 | 发布前 git tag 必须先于 publish | ☐ |
| 6 | `--dry-run` 完整跑通 | ☐ |
| 7 | `npm install <pkg>` 后 smoke test 通过 | ☐ |
| 8 | **仅在已实测通过的平台**打 `latest` 标记；未实测的平台**不**在 README 支持矩阵中列出。Windows 通过即可发 Windows 版；macOS 通过即追加 macOS；不允许"暂未测但先打 macOS 标签" | ☐ |

---

## 12. 测试矩阵与质量门禁

### 12.1 单元测试

- `model-catalog`: `cn:`/裸名/global/未知前缀/重名/空 ID/重复 ID/特殊 `auto`；
- `gateway-client`: API key、timeout、abort、401/403/404/429/503、JSON 演进和脱敏；
- `oauth`: start/poll 等待、成功、过期、取消、不可控 URL、安全校验、卸载回收；
- `provider-config`: 不覆盖其他 provider、保留用户禁用配置、动态目录显式应用；
- `gateway-supervisor`: identity、ownership、进程退出、健康 503、重复启动、端口冲突、重启限次；
- `build-manager`: pin SHA、工具链校验、go mod 下载失败、磁盘满、取消、半写入、失败恢复；
- `update-manager`: semver/tag 校验、source lock、Windows 二进制占用、配置格式变化、回滚失败。

### 12.2 端到端场景

1. 无网关安装，UI 正常出现；
2. 已运行网关连接并完成 OAuth 与模型导入；
3. Agent 工具调用闭环与多轮连续完成；
4. API key 错误有清晰提示，不吞掉原错误；
5. 空账号池的 `/healthz 503` 不被当成崩溃；
6. 用户原始 wb2api 被插件卸载时继续运行；
7. 同时开两个 DSH 窗口/Host，不启动两个 Managed 写同一份数据；
8. Windows 构建失败、网络断开、退出/重启后能恢复；
9. 一键升级中途异常仍能启动上一稳定版本；
10. 释放进程和临时文件后，账户密钥仍有适当权限并未写入日志；
11. 旧数据导入失败能恢复到导入前状态；
12. 全平台覆盖矩阵按实际操作系统逐一完成，不用 mock 代替跨平台端到端。

### 12.3 发布阻断规则

- **P0**：Agent tool call 不通、OAuth 路径错误、Managed 意外修改或删除外部配置/账号、泄露 OAuth/token、远程可直接访问无鉴权网关、可能误杀其他进程；
- **P1**：升级回滚不可靠、重复构建污染当前版本、模型 ID 错路由、未受控重试造成上游请求风暴、禁用后遗留长驻资源；
- **P2**：视觉与文档、非关键统计、可选 global 适配和 UI 小功能。P0/P1 必须解决；P2 记录即可。

### 12.4 测试工具选型（**V2.2 修订：mock HTTP 不是真 E2E**）

- **单元 (Unit)**：vitest（≥0.x，ESM + JSDOM stub + fast startup）
- **协议 / 集成 (Protocol / Integration)**：vitest 自带 + 真实 HTTP mock server（`nock` / `undici`）—— 验证请求 / 响应 schema，但不代替真实 DSH Agent 调用
- **冒烟 (Smoke)**：vitest + 真实 wb2api fixture（CI 上跑；监听 `127.0.0.1` 随机端口）
- **E2E（**实**端到端，唯一权威**）**：在 DSH Desktop 内或等价嵌入环境中，启动 Host 插件、加载 provider 配置、调用真实 DSH Agent tool-call → 真实 wb2api → 真实腾讯账号；只有这一类能下"M01–M10 通过"结论
- **不依赖** DSH 自带工具链；插件业务逻辑（HTTP 客户端 / 凭据 / 模型映射 / 状态机）必须独立可测
- **Coverage**：v8 默认 reporter，门槛 80%

> V2.1 把 `nock` / `undici` 列为"端到端测试"是错的——这两只是 mock HTTP 层，仅能做"我发的请求符合 schema"或"我收到响应时按 schema 解析"，**不**等价于真实 DSH Agent 能跑通。M01–M10 验收必须在 E2E 层做。

---

## 13. 风险与应对（含 block-criterion）

| 风险 | 优先级 | 应对策略 | Block Criterion（解除条件） |
|---|---|---|---|
| Chat Completions 不足以承载 DSH Agent 工具调用 | P0 | P0 首先用真实工具循环验证，不行先修适配，不开工构建 | M01–M07 全部通过；M03/M04 必须通过 |
| DSH 版本快速变化导致 Host/Client API 失效 | P1 | 绑定开发基线，使用官方 Slot/Service，版本兼容测试 | 实测两个相邻 DSH 版本均可加载插件 |
| `cn:` 在用户的 Harness 路径无法识别 | P0 | CN publicId 去前缀；真实请求也用裸 ID；回归测试 | 真实请求均使用裸 ID；DSH 模型目录与 `workbuddy` provider 双向可见 |
| global 裸 ID 被错误路由到 CN | P0（如启用 global） | V1 禁用 global；后续单独 wire alias 层 | §5.4 没有适配 global 之前，目录展示不混 global |
| `/healthz` 503 造成 watchdog 无限重启 | P1 | Liveness 与 Readiness 分开 | §7.3 三态探测脚本化；503 不触发 restart counter 递增 |
| OAuth 返回值/面板 API 改变 | P1 | v1.13.0 的端点 pin + schema + 协议版本门禁 | P0 阶段记录完整 `login/start` + `login/poll` 样本 |
| Managed 复制旧目录造成双写 | P0 | Attach 只读归属；Managed 私有目录；Import 显式隔离 | §4.2 import 测试 6 项全过 |
| Windows 运行中二进制无法覆盖 | P1 | immutable 版本目录 + `active.json` 切换 + 停机迁移 | `active.json` 提交后 supervisor 启动新版 + 校验 `wb2api.sha256` + `/healthz` service + `/v1/models` 任一失败回滚到 `previous.json` |
| Go 下载、依赖、网络代理失败 | P1 | 显式用户授权、超时/重试、可信摘要、失败可回退 Attach | 至少 3 种失败模式（断网/404/checksum mismatch）的优雅降级 |
| 源码/构建依赖供应链攻击 | P0 | 受控流程生成的源码 archive SHA256、toolchain SHA256、下载目标校验 | §8.3.1 段 A 下载完整 + 段 B 本地产物 + 段 C 运行身份三段独立验证；`checksums.txt` 覆盖预编译二进制但不覆盖源码 archive——后者须受控流程生成 |
| 腾讯服务规则变化/账号风控 | 高外部风险 | 透明提示，不做风控规避；账号禁用时停止主动重试 | 风控文档化 + 用户协议提示 |
| 上游作者不同意捆绑发行 | 高社区风险 | 原作者明确署名、允许 Attach-only 分发，不承诺净室重写 | §9.3 plan B 路径就绪 |
| macOS 受 Gatekeeper / 签名影响 | P1（发行） | 分别验证本地自构建/已签名产物；不以取消系统安全检查为默认安装步骤 | §4.3 矩阵有 macOS 行验证；UI 给出"右键打开"指引 |
| **pnpm 11 默认禁 postinstall 脚本** | P1 | §8.3 不走 npm lifecycle hook；Go toolchain 以 tarball/zip 解压 | P2 首次构建在 DSH 桌面端 pnpm 环境跑通 |
| **上游仓删库 / mirror 失效** | P0 | §9.3 plan B 触发；vendor 备份已锁定；仅依赖已 vendor 的 v1.13.0 源码 | 评估日 + P3 发布前各重测一次上游可达性 |
| DSH Web/SDK 形态对 Managed 进程管理模型不兼容 | P1 | §2.4 限定 V1 Desktop only；Web/SDK 推到 v0.2.x | §2.4 边界声明 + README 注明 |
| **Linux Desktop 不在 DSH 官方发布目标** | P1（环境） | §2.4：v1 首版不在 Linux Desktop 上做任何官方验收承诺；用户在 Linux 上跑通后独立登记到 §13 | 文档显式说明 + README 不将 Linux Desktop 列入支持矩阵首行 |
| **DSH 找不到可信的最小 cordis 模板**（P0） | P0 | §3.2 改为占位 + 实测清单；不依赖 V2.1 的伪示例 | P0 阶段实测出真实 Loader 字段，编入 §3.2 实证附录 |
| **wb2api 端口 0 / 自动分配目前不支持** | P1（环境） | §7.2 端口策略：用户手动指定 + `EADDRINUSE` 立即换端口；待 wb2api 支持自动分配后再扩展 | V1 不假装自动端口能力 |
| **非小写前缀 `cH:` 等被 wb2api 当成模型名原串透传** | P0 | §5.2 算法主动拒绝非 `cn:` / `global:` 任何冒号前缀；UI 给出明确提示 | P0 阶段在算法测试里覆盖 `cH:glm-5.2` 等异常输入并断言"插件层拒绝" |
| **升级时新版本直接读旧格式 state.json 致不可逆破坏** | P0 | §8.4 升级数据迁移顺序修订：先停旧 / 备份全量 / 必要时迁移至隔离目录 / 提交 active.json / 启新 / 验证 / 失败回滚（**不**只备份 state.json） | P3 升级测试覆盖 `state.json` + `config.json` + `auths/` 同时迁移 + schema 变更时显式失败 |
| **DSH 是否提供外部浏览器打开 bridge 接口未知** | P1 | §6.1.1：UI 始终渲染"复制 URL" 按钮作兜底；§3.2 / §11 P0 实测出 bridge 名后填入 | UI 在 bridge 不可用时仍可完成 OAuth（用户复制 URL 到浏览器） |
| **DSH `runtime/active` 目录/symlink 旧式引用残留** | P1（文档） | §8.2 / §11 P3 / §13 已统一改为 `active.json` + `previous.json`；不再用目录 rename | grep V2.2.1 文档剩余 `runtime/active` 字符串 = 0 |

---

## 14. 开工前清单（交给执行模型）

**禁止先写大而全的插件。按以下顺序执行并提交证据：**

1. 读取用户实际 DSH 版本、当前 wb2api 启动方式与配置**路径**；只需记录路径和脱敏字段，不要向模型输出任何 token。
2. 固定上游代码：wb2api `v1.13.0` / `REDACTED-UPSTREAM-SHA`；记录 DSH 安装版本，不凭猜测使用 `ctx` API。
3. 先在现有 DSH 环境通过最小 `openai-completions` route，用 `glm-5.2`（或其他确实可用裸模型 ID）测试真实 Agent 及 tool-call；失败即停在 P0。
4. 使用已验证的 Host/Client API 实现 Attach MVP；每个功能都要有单测和真实环境验收。
5. UI、网关 REST、provider 配置、凭证存储、进程管理分层；禁止让 UI 自行访问网关 Token 或 OS 文件。
6. P1 可用后再引入 Managed 构建；绝不写入原用户网关目录。
7. 最后做升级、回滚、许可证和五平台测试；没有设备的 OS 标为未测试，不宣称支持。
8. 每批交付：变更文件列表、接口依据、测试命令及结果、已知失败、手工验证步骤、是否可以合并；**不能用"看起来可行"代替结果**。

### 14.1 建议的首个 PR 体量

P0 PR 只应包含：最小 DSH 配置/插件 probe、脱敏接口 fixtures、10 项 Agent 测试脚本及结果、模型 ID 适配的最小实现或明确解释、集成扩展点结论。**不要在 P0 PR 中添加 Go toolchain 下载器、十余个 UI 页面、自动更新和跨平台 build。**

### 14.2 正式交付定义（Definition of Done）

用户不需要先安装 wb2api，就能在 DSH 插件里自行完成网关部署、本人账号的浏览器授权、模型选择、Agent 对话与余额查看；已有 wb2api 用户能无损 Attach；升级失败能退回最后稳定可用的二进制与配置；不扩大网络暴露面、不泄露凭证、不破坏用户旧数据，且第三方许可证和服务条款风险有准确披露。

---

## 15. 已知未确定项（需要实测后关闭）

- [ ] 当前用户 DSH 实际安装版本与 UI/Host Slot API 是否完全匹配参考 tag。
- [ ] 用户报告 `cn:` 失败的准确触发环节（选择器、配置校验、provider resolution 或请求）。
- [ ] 具体每个模型（包括 `glm-5.2`）能否返回合规的多轮工具调用，不应把模型列表存在等同于可用。
- [ ] DSH 的受支持 Host 端配置写接口能否让插件无冲突地维护 `llm-pi-ai` 中 `workbuddy` 路由；暂不能保证"一键应用模型"零配置变更。
- [ ] macOS/Linux 构建产物路径、系统安全限制和清理策略是否与目标 DSH 桌面版一致。
- [ ] OAuth URL、返回字段及上下游服务条款在计划实施当天是否发生变化。
- [ ] global 模型的模型名 alias 方案，必须有独立原型和冒号兼容实测才能上线。

---

## 16. 证据索引（源码 / 官方说明）

**WorkBuddy2API v1.13.0（行号锚点为最小可独立验证候选；下游实施须 clone `v1.13.0` tag 后复核）：**

- R1 `internal/server/resolve_model.go` — 无前缀默认 CN；决策表来源
- R2 `internal/server/handler.go` — 注册 `/v1/chat/completions`, `/v1/models`, `/status`, `/healthz`
- R3 `internal/panel/panel.go` — 实际管理 API
- R4 `internal/panel/login.go` — OAuth start/poll；`loginTTL` 常量出处
- R5 `cmd/server/config.go` — 监听、账号、状态与随机密钥生成
- R6 `cmd/server/main.go` — 服务入口、`SIGTERM` 优雅关闭
- R7 `LICENSE` — 原作者 MIT 版权与许可

**DeepSeek Harness：**

- R8 `packages/llm/llm-pi-ai/README.md` — Provider Schema 与模型发现
- R9 `src/config.ts` — `api`、`baseURL`、`apiKeyEnv`、`models`
- R10 `packages/subprocess/subprocess-local/README.md` — 平台进程所有权与终止行为
- R11 `packages/util/home-paths/README.md` — `resolveDshHome`
- R12 官方插件开发说明与模板（仓库内 `packages/preset/agent-preset/skills/cordis-plugin-development`）

**上下游接口 permalink：**
- https://github.com/linguo2625469/workbuddy2api-panel/blob/v1.13.0/internal/server/handler.go
- https://github.com/linguo2625469/workbuddy2api-panel/blob/v1.13.0/internal/server/resolve_model.go
- https://github.com/linguo2625469/workbuddy2api-panel/blob/v1.13.0/internal/panel/panel.go
- https://github.com/linguo2625469/workbuddy2api-panel/blob/v1.13.0/internal/panel/login.go
- https://github.com/linguo2625469/workbuddy2api-panel/blob/v1.13.0/cmd/server/config.go
- https://github.com/linguo2625469/workbuddy2api-panel/blob/v1.13.0/cmd/server/main.go
- https://github.com/linguo2625469/workbuddy2api-panel/blob/v1.13.0/LICENSE
- https://github.com/linguo2625469/workbuddy2api-panel/blob/v1.13.0/README.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-pi-ai/README.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-pi-ai/src/config.ts
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/subprocess/subprocess-local/README.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/util/home-paths/README.md

**来源与性质：** V1 调研中的用户目标、命名、方案选项与目标能力被保留；关键 API、插件装载事实和生命周期规则已按公开源码修订；工期与阶段优先级属于本次工程估计，不是实测结果。涉及腾讯服务条款的判断仅为风险识别，**不构成法律意见**；MIT ≠ CodeBuddy ToS，不得再写"法律风险为零"。

---

## 附录 A — V2.1 → V2.2 变更清单（第三轮审查产物）

> 评审来源：第三方独立审阅 7 条 P0 + 9 条 P1；细节见 `REVIEW-CHANGELOG-v2.1-to-v2.2.md`。

| # | 类型 | 位置 | 变更内容 |
|---|---|---|---|
| 1 | 🔴 P0 | §3.2 | 删除虚构 `cordis.patch.yml` 示例；改为占位 + P0 7 项实测清单 |
| 2 | 🔴 P0 | §3.2 | 删除虚构 `peerDependencies` |
| 3 | 🔴 P0 | §8.3.1 | 重写供应链验证为"段 A 下载完整 / 段 B 本地产物 / 段 C 运行身份"三段独立验证；删除 `go.sum` 当独立可信证据；删除 `X-Service` 当密码学身份 |
| 4 | 🔴 P0 | §0.4 / §2.4 / §4.3 / §11 P2/P3 / §13 | Linux Desktop 踢出首版；DSH `apps/desktop/README.md` 明确"Linux 不在支持目标" |
| 5 | 🔴 P0 | §7.2 | 端口策略改"用户手动指定"；删除 `SO_REUSEADDR` 假设；等待 wb2api 支持 OS 端口 0 + 受控回报后再扩展 |
| 6 | 🔴 P0 | §8.4 | `runtime/active` 改 `active.json` + `previous.json` + 7 步切换；"二进制切换 ≠ 数据迁移"独立验收 |
| 7 | 🔴 P0 | §7.2 | 删除 Linux 兜底伪代码 (`process.kill(-pid,…)` + `spawn({detached:false})` + `prctl(PR_SET_PDEATHSIG)`) |
| 8 | 🟡 P1 | §11 P0 | 禁止 hardcoded API key；改用 DSH 凭据服务解析 |
| 9 | 🟡 P1 | §5.1 | 新增"凭证路径收敛"段：写入 → 引用 → 解析 → 调用四步闭环 |
| 10 | 🟡 P1 | §4.2 | Import 来源文件必须先停 / 暂停或冻结写入 |
| 11 | 🟡 P1 | §6.1.1 | Host 不能直接访问 Electron `shell.openExternal`；改为经 DSH shell bridge |
| 12 | 🟡 P1 | §1.1 | `cH:glm-5.2` wb2api 实际行为：走默认 CN 裸名（不报错）；插件层应主动拒绝 |
| 13 | 🟡 P1 | §9.2 | `go mod why -m all` 不是 license 工具；改 `go list -m -json all` + 实际扫描 |
| 14 | 🟡 P1 | §11.5 | NPM Publish 仅 Desktop（Windows x64 / macOS arm64 / macOS x64）；CLI 仅做辅助 |
| 15 | 🟡 P1 | §12.4 | 测试分层：unit / protocol-integration / smoke / E2E；mock HTTP 仅属 protocol 层；M01–M10 必须在 E2E 测 |
| 16 | 🟢 保留 | §5.5 | M03 / M04 工具调用闭环作硬门槛（审查人最赞赏项） |

---

## 附录 B — 三轮事实校正日志（V1 → V2 → V2.1 → V2.2）

| 类别 | 修正前 | 修正后 | 出处 / 触发轮次 |
|---|---|---|---|
| OAuth 路径 | `/panel/api/auth/login` + `/panel/api/auth/poll` | `/panel/api/login/start` + `/panel/api/login/poll?state=...` | v1.13.0 `internal/panel/login.go`（V1 → V2） |
| OAuth 响应 | RFC 8628 `{device_code,user_code,verification_uri}` | `{ok,url,state,realm}` | 实测响应（V1 → V2） |
| API 协议 | `openai-responses` 可用 | 必须 `openai-completions` | 实测受 v1.13.0 端点约束（V1 → V2） |
| `cn:` 语义 | 需要 transformer 把 `glm-5.2` → `cn:glm-5.2` | `resolveModel` 已自动处理；去前缀即可 | `internal/server/resolve_model.go`（V1 → V2） |
| 净室重写 | 作为可靠 fallback | 从正常路线删除（plan B 路径引用 §9.3；不承诺） | 工作量与法律边界实情（V1 → V2） |
| Go 工具链下载 | 可走 npm postinstall | 不走 postinstall（pnpm 11 兼容）；改用 Node 原生 fetch + tarball | DSH 安装约束（V1 → V2.1） |
| 法律风险定性 | "法律风险为零" | "MIT ≠ CodeBuddy ToS；不得写零" | 合规常识（V1 → V2.1） |
| global 模型 | 暂时禁用 | 单独 gate；§5.4 明确决策 | 已知风险（V1 → V2） |
| DSH `cordis.patch.yml` Loader 字段 | V2.1 虚构 `host.apply` / `client.slots` 等 | V2.2 占位 + P0 实测校正；禁止复制 | 对照 DSH 官方模板（V2.1 → V2.2） |
| DSH `peerDependencies` | V2.1 虚构包名 | V2.2 占位 + P0 grep 出真实包名 | grep 真实 DSH 仓库（V2.1 → V2.2） |
| 供应链验证 | V2.1 "6 段多源证据链" | V2.2 拆三段独立验证；`X-Service` 不再当密码学身份 | `internal/server/handler.go` 实测（V2.1 → V2.2） |
| Linux Desktop 定位 | V2.1 三 OS 支持 | V2.2 踢出首版；DSH 官方 README 不支持 | `apps/desktop/README.md`（V2.1 → V2.2） |
| 端口策略 | V2.1 `SO_REUSEADDR` + 启动后记 | V2.2 用户手动指定；不做 TOCTOU 伪独占 | 审查人 P0 #5（V2.1 → V2.2） |
| `runtime/active` 切换 | V2.1 atomic rename 假设 | V2.2 `active.json` + `previous.json` + 7 步 | 审查人 P0 #7（V2.1 → V2.2） |
| Linux 进程兜底代码 | V2.1 `process.kill(-pid,…)` + `prctl` | V2.2 删除伪代码；仅约束"创建新进程组" | 审查人 P0 #4（V2.1 → V2.2） |
| `shell.openExternal` 调用方 | V2.1 host 直调 | V2.2 经 DSH shell bridge 接口 | Host ≠ Electron renderer（V2.1 → V2.2） |
| 测试分层 | V2.1 "vitest + nock/undici E2E" | V2.2 区分 unit / protocol / smoke / E2E | `nock` 是 mock ≠ E2E（V2.1 → V2.2） |
| License 审计命令 | V2.1 `go mod why -m all` | V2.2 `go list -m -json all` | `go mod why` 不查 license（V2.1 → V2.2） |

---

**— V2.2 完 —**
