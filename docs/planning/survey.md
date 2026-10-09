# dsh-workbuddy-bridge — 完整调研 + 实施方案

> 调研时间：2026-10-10（北京时区）
> 目的：把腾讯 CodeBuddy / WorkBuddy 的 OAuth 账号一站式接入 DeepSeek Harness
> 形态：DSH 插件 `dsh-workbuddy-bridge`，MIT 协议发布
> 副标题："默认携带 wb2api 源码；用户不开心我们就净室重写"

---

## 0. 摘要（TL;DR — 给审查者 60 秒读完）

| 项目 | 值 |
|---|---|
| 项目名 | `dsh-workbuddy-bridge` |
| 协议 | MIT（双版权行，致谢 `linguo2625469/workbuddy2api-panel`） |
| 主路径 | **方案 C**：DSH 插件 npm 包携带 wb2api Go 源码 + Go 工具链 + 自构建脚本，首次启动时 `go build` 出 wb2api 二进制，持久 spawn |
| 兼容原版配置 | ✅ 走 wb2api REST API（`/v1/*` `/status` `/panel/api/*`），用户原 `wb2api.exe` + `config.json` + `auths/` + `data/` 不动 |
| 强装 wb2api | ❌ 不强装——但插件能"自动发现已有 wb2api.exe"，找不到则引导走 Releases / 自构建 |
| 直接更新 | ✅ 插件自管：检查 `linguo2625469/workbuddy2api-panel` releases → 拉新源码 → go build → atomic-swap 子进程 |
| 净室 fallback | ✅ 已规划——作者公开反对时，删 `vendor/wb2api-source/`，走纯引导形态（独立抓包协议） |
| 工程量预估 | 12 个工作日（≈ 2.5 周） |
| 主要风险 | 1) macOS Gatekeeper 拦截未签名二进制 2) Windows Defender SmartScreen 误报 3) 跨平台签名 4) build 失败回滚 5) DSH 子进程管理（`dsh-subprocess-local` 设计为短命任务，需自建 `Wb2apiProcessManager`） |
| 合规风险 | **法律上零**（MIT 明确允许派生再分发），但作者社区关系有轻微代价（作者README 有非协议条款的"二次打包禁止"声明，作者自承非协议） |

---

## 1. 项目背景

### 1.1 用户场景

- 用户是 DSH 桌面端用户，使用腾讯 CodeBuddy / WorkBuddy 账号额度（约 ~9548 credits，来自 2 个 OAuth 账号）；
- 不想用浏览器跑 CodeBuddy 桌面客户端；
- 希望在 DSH 内部"一站式"完成：登录 WorkBuddy 账号 → 选用模型 → 看到余额；
- 现有 `linguo2625469/workbuddy2api-panel`（v1.13.0，2026-10-08 release）独立实现了 WorkBuddy → OpenAI 兼容 API 网关，但需要用户单独装/管；
- 本插件把这条流程沉降到 DSH 内部。

### 1.2 关键约束

1. **不能强制用户装 wb2api**——本插件得能"无 wb2api 也能在 DSH 里看见界面"；
2. **兼容原版 wb2api 配置文件**——`config.json` / `auths/` / `data/state.json` 这套布局不动；
3. **直接更新**——wb2api 上游改了，插件应能自拉自构建自更新；
4. **降级路径**——作者若反对，可净室重写不依赖 wb2api 任何源码/产物。

---

## 2. 第三方项目盘点

### 2.1 涉及的 GitHub 仓库

| 仓库 | 协议 | 状态 | 我方依赖层级 |
|---|---|---|---|
| `linguo2625469/workbuddy2api-panel` (v1.13.0) | MIT (1230 字节标准 MIT) | 活跃 (2026-10-09 push)，Release 完整 (五平台 + checksums) | **携带 Go 源码**（主路径）或纯 REST 消费（fallback） |
| `Sliverkiss/workbuddy2api` (上游) | MIT | **仓库已删**（GitHub API 404），代码并入 ling fork | 仅在 NOTICE 保留版权行 |
| `deepseek-ai/deepseek-harness` (DSH) | MIT (1065 字节标准 MIT) | 活跃 (246k stars / 29.5k forks) | DSH 插件宿主 |
| `router-for-me/CLIProxyAPI` | MIT | 活跃 (54.6k stars) | 仅在 dsh-cost-meter 内置 workbuddy provider 时引用；本插件不依赖 |

### 2.2 wb2api v1.13.0 现状（实测）

| 指标 | 值 |
|---|---|
| GitHub Releases | v1.13.0-panel，2026-10-08 发布 |
| 5 个平台二进制 | `darwin-amd64 / darwin-arm64 / linux-amd64 / linux-arm64 / windows-amd64` |
| Go 版本 | `go 1.22.5`（来自 `go.mod` 实测） |
| 第三方依赖 | `cespare/xxhash/v2`、`dgryski/go-rendezvous`、`redis/go-redis/v9`、`go.uber/atomic`、`golang.org/x/sys`（全部纯 Go，**无 CGo**） |
| 默认监听 | `:7863` |
| API key 鉴权 | `config.json` `api_key` 字段，空时放行 |
| `/v1/models` | 实测返回 19 个模型，**全部带 `cn:` 前缀**，`owned_by='workbuddy'` |
| `/status` | 实测可拉账号余额、总额、冷却、模型锁等元数据 |
| LICENSE 文件 | MIT（GitHub API `spdx_id: MIT` 双确认 + LICENSE blob SHA `7a7d27d` 内容比对） |
| 启动依赖 | 纯单文件 exe，可 `go:embed` 前端资源，无外部依赖 |

### 2.3 wb2api 19 个模型实测清单（DSH 里需要去掉 `cn:` 前缀映射）

```
cn:hy3, cn:hy3-x, cn:hy4-preview, cn:hy4-preview-f
cn:glm-5.1, cn:glm-5.2, cn:glm-5.3, cn:glm-5.3-flash, cn:glm-5v-turbo
cn:deepseek-v4-flash, cn:deepseek-v4-pro, cn:deepseek-v4.1-flash
cn:kimi-k2.6, cn:kimi-k2.7, cn:kimi-k2.8-preview, cn:kimi-k3-1
cn:auto, cn:minimax-m3, cn:space-bunny
```

> 推断的官方名映射表详见 `data/models.json`（待实测一次确认）。

---

## 3. wb2api 二次分发合规论证

### 3.1 LICENSE 是协议，README §使用声明不是

| 层级 | 内容 | 法律性质 |
|---|---|---|
| `LICENSE` 文件 (1230 B, MIT 字面) | 包含双版权行 Sliverkiss + linguo2625469，MIT 标准文本 | **版权许可** |
| `README.md` §使用声明 | "禁止二次打包 / 禁止商业 / 禁止转售" 段（含"关于开源协议的诚实说明"段落——作者明示这不是协议条款） | **作者个人请求 / 道德立场**，不是协议条款 |

MIT §1 字面授权："Permission is hereby granted, free of charge, to any person obtaining a copy of this software ... to deal in the Software **without restriction**, including without limitation the rights to use, copy, modify, merge, publish, **distribute, sublicense, and/or sell copies** of the Software...".

**结论**：以 npm 包形式携带 wb2api Go 源码、按相同 MIT 再分发，是 MIT 字面允许。

### 3.2 作者明确知道并承认这一点

wb2api README 含一段"关于开源协议的诚实说明"，标题字面含义是"我知道这段不是协议的一部分"。这是开源界对"代码层面自由 vs 用户期待"的标准划分，作者在仓库里就做了这层切割。

### 3.3 MIT 是 perpetual + irrevocable

MIT §1 字面 + Open Source Initiative FAQ：开源许可证授权后**不可撤销**，作者即使删库、公开喊停，已获授权的再分发行为**继续合法**。

唯一例外：作者后续**闭源**的修改版不受 MIT 保护（与你无关——你锁定 commit SHA 即可）。

### 3.4 CodeBuddy / 腾讯 服务条款的限制

- 限制的是 **用户（注册主体）的行为**——禁止批量注册小号、禁止账号买卖、禁止商业转售 API；
- **不约束插件作者的分发行为**——分发一个使用 OAuth 标准流程的工具不属于"破解、绕过、批量注册"；
- 真正风险点是**用户层**（用户用本插件做批量注册 = 用户违反 CodeBuddy ToS），不是分发层。

### 3.5 MIT 下携带 wb2api 源码的义务

**MUST（法律硬要求）**：
- M1. `vendor/wb2api-source/` 下必须有 wb2api LICENSE 副本，含双版权行；
- M2. 在插件 README + NOTICE 显著标注：含有 wb2api 源码、保留原作者归属、注明本插件与 wb2api 项目无官方关系。

**SHOULD（强烈推荐）**：
- S1. `package.json` `"license": "MIT"`，声明本插件自有许可；
- S2. 锁定 wb2api 上游 commit SHA 到 `data/wb2api-pinned-commit.txt`，**不拉 `main` branch**；
- S3. 首次启动 UI 里给用户一个"包含第三方开源代码"告知页。

**NICE（可选）**：
- N1. 在 `THIRD_PARTY_NOTICES.md` 整理 wb2api 间接依赖（go-redis、xxhash、atomic、go-rendezvous、x/sys）的版权页；
- N2. 单独 publish `wb2api-source-patch` 透明化你做的任何 patch（如果原样分发则不用）。

### 3.6 不要走的红线

- ❌ 不要 `npm postinstall` 拉 Go 工具链（**DSH 桌面端用 pnpm 11 默认禁止 postinstall 脚本**，会莫名失败）；
- ❌ 不要在 README 隐藏作者归属；
- ❌ 不要卖卡密、不要做"公益中转版"（这是 wb2api README 明确禁止的，与协议无关、与道德和社区关系相关）。

---

## 4. 工程方案对比

| 方案 | 描述 | 工程量 | 合规 | UX | 评分 |
|---|---|---|---|---|---|
| **A. 纯客户端插件** | 插件只调 wb2api REST；用户自己装 wb2api.exe | 1-2 天 | ✅ 完美 | 用户多一步 | ⭐⭐ |
| **B'. 引导式插件** | 插件 + 引导用户去 GitHub Releases 自下；插件检测已有 wb2api.exe 自动接管 | 2-3 天 | ✅ 完美 | OK | ⭐⭐⭐ |
| **C. 携带源码自构建**（**主路径**） | 插件 npm 包带 wb2api Go 源码 + Go 工具链 + 自构建脚本 | 12 天 | ✅ 法律 OK | 首次 5 分钟 + 用户感"重" | ⭐⭐⭐⭐ |
| **D. 携带预编译二进制** | 插件 postinstall 拉 wb2api 二进制 | 0.5 天 | ⚠️ 社区代价 | 最佳 | ⭐（不推荐） |

**推荐**：方案 C 作为主路径，方案 B' 作为 fallback。

---

## 5. 主路径方案 C — 详细设计

### 5.1 npm 包结构

```
dsh-workbuddy-bridge/
├── package.json                       # MIT, deps, fixed commit SHA
├── LICENSE                            # 本插件 MIT
├── THIRD_PARTY_NOTICES.md             # wb2api + 间接依赖致谢
├── NOTICE                             # 简短致谢（@deprecated → THIRD_PARTY_NOTICES）
├── README.md                          # 中英双语、含 wb2api 致谢
├── cordis.patch.yml                   # 单 row Loader
├── vendor/
│   └── wb2api-source/                 # ~5-10 MB 源码
│       ├── LICENSE                    # 必须（双版权行）
│       ├── go.mod, go.sum
│       ├── main.go + ...              # wb2api 全部源
│       └── .gitsha                    # 锁定的上游 commit SHA
├── data/
│   ├── models.json                    # 19 个模型 ID 映射表
│   ├── wb2api-pinned-commit.txt       # 上游锁定的 commit SHA
│   └── api-version.json               # 探测到的协议版本
├── scripts/
│   ├── fetch-wb2api-source.mjs        # 校验 SHA 后写到 vendor/
│   ├── build-wb2api.mjs               # 跨平台 go build orchestrator
│   └── verify-checksums.mjs           # SHA256 校验产物
├── bin/                               # build 产物（不入 git，运行时生成）
│   ├── wb2api-<platform>-<arch>[.exe]
│   ├── wb2api.previous[.exe]          # 回滚备份
│   └── checksums.json
└── lib/
    ├── index.js                       # apply(ctx) 入口
    ├── process-manager.js             # Wb2apiProcessManager
    ├── port-detector.js               # 7863 冲突 / 动态分配
    ├── wb2api-client.js               # HTTP 客户端
    ├── oauth-device-flow.js           # RFC 8628 + DSH 浏览器拉起
    ├── model-bridge.js                # 19 个映射 + LLM seam transformer
    ├── balance.js                     # /status 轮询
    ├── version-negotiate.js           # 协议版本探测
    └── ui/
        ├── first-run.jsx
        ├── tabs/
        │   ├── status.jsx
        │   ├── accounts.jsx
        │   ├── models.jsx
        │   └── settings.jsx
        └── assets/
```

### 5.2 状态机

```
STATE A: 等待首次构建（first-run）
  ↓ user 按"立即构建"
STATE B: 后台构建中（download Go toolchain ~80MB + go mod download + go build）
  ↓ 成功
STATE C: 已启动 wb2api 子进程（默认端口 7863）
  ↓ 心跳 / 协议版本探测 / 真实业务
STATE D: 升级可用（GitHub latest release > pinned SHA）
  ↓ user 点"升级"
STATE E: 重建 → atomic-swap → previous 备份

任一状态 user 可一键切到 fallback（方案 B'，删 vendor/wb2api-source/）
```

### 5.3 子进程管理层（DSH 缺失，自己实现）

`process-manager.js` 暴露 `Wb2apiProcessManager` 类：

- **spawn 模式**：`child_process.spawn(wb2apiExePath, ['-config', configPath], { detached: true, stdio: 'ignore' })` + `subprocess.unref()`
- **DSH 退出钩子**：通过 Electron `app.on('before-quit', ...)` 查 `pid` 主动 kill；Windows 上额外 `taskkill /T /F /PID <pid>` 杀进程组
- **心跳**：每 5s `GET /healthz`，失败 3 次 → 退避重试，10 次连续失败 → UI 提示用户
- **端口冲突**：端口探测（默认 7863）→ 若被占则动态 +1（7864 → 7865 ...）→ 写入 `bin/runtime-port.json`
- **崩溃恢复**：watchdog；触发重启前检查 `cooldown` 是否到期（否则等），避免腾讯反作弊连坐

### 5.4 OAuth 设备码流程（RFC 8628 + DSH 浏览器拉起）

```
1. user 在 DSH 设置页点 [+ 添加 WorkBuddy 账号]
2. 插件 POST /panel/api/auth/login
   → { device_code, user_code, verification_uri, expires_in, interval }
3. 插件弹出 Dialog：
   ┌───────────────────────────────────────────────────┐
   │  请在浏览器打开下方链接完成 WorkBuddy 登录          │
   │  https://www.codebuddy.cn/oauth/...?user_code=ABCD  │
   │                                                   │
   │  [打开浏览器]   [取消]                              │
   └───────────────────────────────────────────────────┘
4. user 在浏览器走完腾讯 OAuth（设备码流程）
5. 浏览器跳回 wb2api 设备码回调 HTTP 200 OK
6. wb2api 把凭证写到 auths/workbuddy-<uid>.json
7. 插件的长轮询 GET /panel/api/auth/poll 或 GET /status 发现新账号
8. UI 刷新账号列表
```

**这条流跟 wb2api 自己的 `/panel/` 内部完全相同**——复用，没发明协议。

### 5.5 模型 ID 桥接（cn: 前缀去除）

DSH `@deepseek-ai/dsh-llm-pi-ai` 的 `openai-responses` provider 已经 OpenAI HTTP client。插件注入：

1. **`data/models.json`** 含 19 个映射：
   ```json
   [
     { "id": "hunyuan-4-preview",    "upstream": "cn:hy4-preview",     "enabled": true },
     { "id": "glm-5.2",              "upstream": "cn:glm-5.2",         "enabled": true },
     { "id": "deepseek-v4-flash",    "upstream": "cn:deepseek-v4-flash", "enabled": true }
   ]
   ```
2. **DSH `llm/llm-pi-ai` provider 配置**：
   ```yaml
   - id: llm-pi-ai
     config:
       providers:
         workbuddy:
           type: openai-responses
           baseURL: http://127.0.0.1:7863/v1
           apiKey: "{{WB2A_API_KEY}}"
   ```
3. **请求前 hook**：DSH 看到用户选 `glm-5.2` → transformer 改为 `cn:glm-5.2` 发给 wb2api；
4. **响应后 hook**：账本看到的是 `cn:glm-5.2`（写入），UI 显示的是 `glm-5.2`（用映射表回查）。

### 5.6 协议兼容层（关键设计）

**永远只通过 HTTP 调用**——不依赖 wb2api 任何内部数据结构。所有 19 个字段含义通过实测 OpenAPI 化（每个 endpoint 一个 zod schema）。

```
wb2api-client.js 中每个 endpoint 都对应一个独立的 schema：
  - /v1/models              → models.json schema
  - /status                 → status-response.schema
  - /panel/api/accounts     → accounts.schema
  - /panel/api/auth/login   → device-grant.schema
  - ...
```

这层抽象保证**净室 fallback 时只需替换 HTTP 客户端**——UI / DSH 接入层 / 配置层不动。

### 5.7 升级机制

```
plugin 启动 → wb2api 子进程稳定后
   ↓ 后台定时
GET https://api.github.com/repos/linguo2625469/workbuddy2api-panel/releases/latest
   ↓
if (latest.tag_name > pinned SHA):
   banner 给用户："v1.14.0 可用（Changelog: 适配 glm-5.3-flash 价格探测）"
   user 点 [升级]
   ↓
   1. 备份当前 bin/wb2api → bin/wb2api.previous
   2. fetch-wb2api-source.mjs 拉新 SHA 源码 → vendor/wb2api-source/（force overwrite）
   3. build-wb2api.mjs 重建 → bin/wb2api.new
   4. 校验 SHA256 与产物 checksums.json 一致
   5. atomic rename → bin/wb2api.current
   6. graceful kill 旧子进程 → spawn 新子进程
   7. 心跳验证 /healthz, /v1/models 都通过
       否 → fall back to wb2api.previous
```

### 5.8 用户工作目录 vs npm 包目录

为避开 pnpm 硬链接、global install 的只读问题：

- `vendor/wb2api-source/` 在 `app.getPath('userData')/workbuddy-bridge/` 而非 npm 包内；
- `bin/` 同理；
- `data/` 也复制到 userData。

DSH 内部 `cordis-home-paths` 服务给出 `resolveDshHome()` 返回的 `$DSH_HOME` 即 userData 根。

---

## 6. Fallback 方案 B' — 净室重写

### 6.1 触发条件

- wb2api 作者公开（在 README issue、Reddit、邮件等任何渠道）声明反对本插件的发行形态；
- 或：wb2api 仓库被强制 takedown（虽然 MIT 不可撤销，但 launcher 端的 CDN 也跟着撤销，影响实际可用性）。

### 6.2 切换流程

```
1. 在 README 加 "由于上游作者立场，本项目转为净室重写"
2. 从 scripts/fetch-wb2api-source.mjs 移除 git 拉取代码
3. 把 vendor/wb2api-source/ 改为 git submodule，或完全不携带
4. 改用 mitmproxy 抓 wb2api 的实际 HTTP 流量 → 自己 OpenAPI 化
5. 用户侧已构建的 bin/ 二进制继续可用（这是用户本地的副本，不属于再分发）
6. 更新机制改用 "用户自己 git clone → 自己 go build"
```

### 6.3 净室程度（agent 评估）

**真正可达成的净室 ≈ 50-60%**：
- ✅ DSH 插件 UI 层（`client-ui-*` 渲染）—— 完全独立；
- ✅ 模型 ID 映射表 —— OpenAI 兼容协议是公开的；
- ✅ OAuth 浏览器拉起（RFC 8628）—— 标准协议；
- ✅ 配置 schema 理解 —— 通过实测的反向工程；
- ⚠️ `/panel/api/*` 端点语义 —— 没有官方文档，必须抓包，不算代码复用但需要反复试错；
- ⚠️ 账号池调度 + 熔断 + cooldown 状态机 —— wb2api 的核心工程，独立实现需要 1 周额外工作量。

**工作量估算**：单工程师 **8-14 天**（agent 给的范围；不是用户最初估的 3-5 天）。

**净室 vs 实现独立性的法律边界**：
- "看了 wb2api 源码然后用不同命名/数据结构/控制流重写"—— 版权法灰色地带（*Oracle v. Google* 等判例）；
- "只抓流量不看源码"—— 明确独立创作（independent creation），版权法保护；
- **推荐**：净室 fallback 路线采用"抓流量 + 不看源码"。

---

## 7. 实施时间线

| 阶段 | 天数 | 工作 | 验证 |
|---|---|---|---|
| **P0 仓库骨架** | Day 1 | `LICENSE` / `NOTICE` / `package.json` / `cordis.patch.yml` / `vendor/wb2api-source/` / `data/models.json` / 简易 README | `npm pack` 验证 LICENSE/NOTICE 已在 tarball，`license-checker` 通过 |
| **P1 subprocess 管理** | Day 2–3 | `process-manager.js`（spawn/detached/unref/before-quit/heartbeat/port-detect/watchdog） | 单测：mock spawn，验证 kill / restart / 端口冲突路径 |
| **P2 build 链路** | Day 3–4 | `scripts/fetch-wb2api-source.mjs` / `scripts/build-wb2api.mjs` / `verify-checksums.mjs` + `bin/wb2api.previous` 回滚 | 在 Windows + macOS + Linux 各 build 一次，checksum 一致 |
| **P3 wb2api-client + OAuth + 模型映射** | Day 4–6 | `wb2api-client.js`（含 zod schema）/ `oauth-device-flow.js` / `model-bridge.js` | 端到端：login → models → chat 一次走通 |
| **P4 UI** | Day 6–8 | `lib/ui/`（first-run + 4 tabs）+ settings 集成 | DSH 端手动跑通视觉流程 |
| **P5 错误处理 + 测试** | Day 8–10 | 错误边界 + 跨平台路径 + pnpm 兼容 + Gatekeeper/SmartScreen 提醒 | 三个平台各跑一次完整 happy path + error path |
| **P6 文档 + 发布** | Day 10–12 | README 双语 + 图文 + 致谢段 + npm metadata | `npm publish` 干跑、license-check 全过 |
| **总预算** | **12 工作日（≈ 2.5 周）** | | |

### 7.1 关键里程碑

- **Day 1**：仓库可 clone、npm pack 可生成；
- **Day 4**：能在 Windows 上 go build 出 wb2api 子进程并保持运行；
- **Day 8**：在 DSH 里能加账号、选模型、跑对话；
- **Day 12**：npm publish 准备就绪。

---

## 8. 风险登记册

| # | 风险 | 严重度 | 触发条件 | 缓解 | 触发后回滚 |
|---|---|---|---|---|---|
| R1 | macOS Gatekeeper 拦截未签名二进制 | 中 | 用户首次启动 macOS 路径 | README 教 `xattr -d com.apple.quarantine`；发版时申请 Apple Developer ID（个人项目不一定划算） | 用户手动解除 quarantine |
| R2 | Windows Defender SmartScreen 误报 | 中 | Windows 用户首次运行 | 申请 EV 代码签名证书（~$300/年）或个人可接受"双击信任" | -- |
| R3 | pnpm 默认禁止 postinstall 脚本（DSH 桌面端使用场景） | 高 | -- | **不依赖 postinstall 拉 Go 工具链**；改为 plugin 首次启动时在 userData 目录下载 + 解压 | -- |
| R4 | wb2api 跨平台 spawn 路径处理 | 中 | Windows / macOS / Linux 路径差异 | 使用 `path.normalize` + 显式 quote；macOS 用 `spawn` 而非 `exec` | -- |
| R5 | DSH 缺长生命周期子进程服务 | 高 | -- | 自建 `Wb2apiProcessManager`（detached + unref + before-quit hook + 进程组 Windows taskkill） | -- |
| R6 | 端口冲突（默认 7863） | 中 | 2 个 DSH 实例 / 已有进程占 7863 | `port-detector.js` 动态 +1，写回 `bin/runtime-port.json` | -- |
| R7 | wb2api 崩溃重启触发腾讯反作弊 | 中 | 频繁 watchdog 重启 | 重启前看 `cooldown` 是否到期；用户层 UI 提示"wb2api 暂不可用，等待 X 分钟" | 用户手动 cooldown |
| R8 | build 失败 → 插件无法工作 | 高 | 网络/Go 工具链异常 | `bin/wb2api.previous` 回滚；build 失败时**不替换**产物，给用户"重新构建"按钮 | 自动回退到 previous |
| R9 | 上游 wb2api commit SHA 漂移 | 中 | -- | 锁定 `data/wb2api-pinned-commit.txt`；定期人工升级 + 跑回归测试 | 锁定 main 不动 |
| R10 | 插件体积膨胀 | 低 | vendor ~5-10 MB；运行时还要下 Go toolchain 80MB | 把 toolchain 缓存到 userData 不入 npm 包 | -- |
| R11 | DSH 退出时 wb2api 残留进程 | 中 | Windows 平台最严重 | spawn detached + unref；Windows 上 `taskkill /T /F /PID` 杀进程组 | -- |
| R12 | 作者公开反对本插件发行 | 低（法律上 0） | 任意渠道 | 见 §6 净室 fallback 流程 | 删 vendor/wb2api-source/ + 改 fallback |
| R13 | 腾讯 CodeBuddy 风控改动 | 高 | CodeBuddy 上游改协议 | `version-negotiate.js` 探测 + 友好降级；fallback 切净室 | -- |
| R14 | wb2api GUI 嵌浏览器 OAuth 与 DSH 不兼容 | 中 | -- | 完全用 DSH 自己的 cordis-host + browser 拉起；不走 wb2api 自带 /panel/ | -- |

---

## 9. publish 前自检清单

```bash
# 1. 验证 SPDX license 解析
npx license-checker --summary

# 2. 验证 LICENSE 文件确实打进 tarball
tar -tzf dsh-workbuddy-bridge-0.1.0.tgz | grep -E "LICENSE|THIRD_PARTY"

# 3. 验证没有 GPL/AGPL 子依赖
npx license-checker --failOn 'GPL;AGPL'

# 4. 验证 metadata
cat package.json | npx package-license-check

# 5. 确认 vendor/wb2api-source/LICENSE 含双版权行
head -3 vendor/wb2api-source/LICENSE

# 6. 确认 data/wb2api-pinned-commit.txt 有值
cat data/wb2api-pinned-commit.txt

# 7. 确认 NOTICE 提到 upstream
grep -E "linguo2625469|Sliverkiss" THIRD_PARTY_NOTICES.md
```

满足以下条件后 `npm publish`：
- [ ] `npm pack` tarball 内有 `LICENSE`、`THIRD_PARTY_NOTICES.md`、`README.md`
- [ ] package.json `"license": "MIT"`
- [ ] 没有意外的 GPL/AGPL 依赖
- [ ] vendor/wb2api-source/LICENSE 含双版权行
- [ ] NOTICE 致谢 Upstream authors
- [ ] README 写明 "本插件与 wb2api 项目无官方关系；独立分发"

---

## 10. 附录 A — LICENSE 草案（双版权行）

```markdown
MIT License

Copyright (c) 2026 <Your Name> — dsh-workbuddy-bridge
DSH-side integration, orchestration, and self-managed WorkBuddy2API build pipeline.

This product bundles source code from:
  linguo2625469/workbuddy2api-panel
  Copyright (c) 2026 Sliverkiss  (original project)
  Copyright (c) 2026 linguo2625469 (this fork)
  Licensed under the MIT License (full text below).
  https://github.com/linguo2625469/workbuddy2api-panel

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 11. 附录 B — 19 个模型映射表（待实测确认）

| wb2api 私有名 | 推断官方名（待实测） | 验证方式 |
|---|---|---|
| cn:hy3 | hunyuan-3 | 实际请求一次 |
| cn:hy3-x | hunyuan-3-extended | 实际请求 |
| cn:hy4-preview | hunyuan-4-preview | 实际请求 |
| cn:hy4-preview-f | hunyuan-4-preview-fast | 实际请求 |
| cn:glm-5.1 | glm-5.1 | 实际请求 |
| cn:glm-5.2 | glm-5.2 | 实际请求 |
| cn:glm-5.3 | glm-5.3 | 实际请求 |
| cn:glm-5.3-flash | glm-5.3-flash | 实际请求 |
| cn:glm-5v-turbo | glm-5-vision-turbo | 实际请求 |
| cn:deepseek-v4-flash | deepseek-v4-flash | 实际请求 |
| cn:deepseek-v4-pro | deepseek-v4-pro | 实际请求 |
| cn:deepseek-v4.1-flash | deepseek-v4.1-flash | 实际请求 |
| cn:kimi-k2.6 | kimi-k2.6 | 实际请求 |
| cn:kimi-k2.7 | kimi-k2.7 | 实际请求 |
| cn:kimi-k2.8-preview | kimi-k2.8-preview | 实际请求 |
| cn:kimi-k3-1 | kimi-k3-1 | 实际请求 |
| cn:auto | （auto-routing） | -- |
| cn:minimax-m3 | minimax-M3 | 实际请求确认 |
| cn:space-bunny | （待用户确认） | -- |

> 这 19 行是 `data/models.json` 初稿；生产前必须派 subagent 跑一次实际请求采样，从 wb2api 内部 API / `console/enterprises/personal/models` 拉真实模型元数据校准。

## 12. 附录 C — 关键事实清单（agent 审阅发现）

> 这些是早期调研未发现、由子 agent 独立审阅补充的事实：

| # | 事实 | 影响 |
|---|---|---|
| F1 | wb2api README 自含"关于开源协议的诚实说明"段 | 作者自己承认二次打包禁令不是协议条款 |
| F2 | DSH `dsh-subprocess-local` 设计为短命任务，不是长生命周期 | 需自建 subprocess manager |
| F3 | DSH 桌面端用 pnpm 11 默认禁止 postinstall 脚本 | 不能依赖 postinstall 自动拉 Go |
| F4 | wb2api 5 个间接依赖全部纯 Go，无 CGo | 跨平台交叉编译简单 |
| F5 | wb2api go.mod 锁 `go 1.22.5` | 工具链版本固定 |
| F6 | wb2api 上游（Sliverkiss）已删库；代码并入 ling fork | NOTICE 致谢需双线 |
| F7 | wb2api README 明文"任何加壳、加密、捆绑收费的'版本'都是他人篡改的产物" | 不走 npm postinstall 拉预编译二进制的根因 |
| F8 | MIT 是 perpetual + irrevocable 授权 | 作者删库/喊停不影响已授权版本分发合法性 |

---

## 13. 附录 D — 决策记录

### D1. 用户的目标 vs 方案匹配

| 用户目标 | 满足情况 |
|---|---|
| 强制装 wb2api | ❌ 不强制（C 路径走"自构建 + 持久子进程"完全在插件内部） |
| 插件内一站式完成认证 + 模型 + 余额 | ✅ first-run UI + 4 Tabs + OAuth device flow + 余额卡 |
| 兼容原版 wb2api 配置文件 | ✅ 走 REST ABI 兼容；用户原 wb2api.exe / config.json / auths/ 不动 |
| 直接更新（wb2api 上游改也能跟） | ✅ 自管升级：GitHub releases latest → 拉新 commit SHA → go build → swap |
| 净室 fallback | ✅ §6 完整流程 + 触发条件已定 |

### D2. 当前推荐方案

**方案 C（携带源码 + 自构建）作为主路径；方案 B'（纯引导）作为 fallback。**

用户原话"作者要不开心咱直接净室重写" → 已经落到 §6 fallback plan。

---

## 14. 联系与审查

- 本报告写作日期：2026-10-10
- 报告位置：`%DSH_HOME%/default-workspace/dsh-workbuddy-bridge-survey.md`
- 审查目的：第三方独立 review 工程 + 合规可行性
- 期望反馈：方案 C 是否可接受 / 时间预算 12 天是否合理 / fallback 流程是否清晰 / 还有哪些技术细节需补充
