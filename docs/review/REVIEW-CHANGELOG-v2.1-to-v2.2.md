# V2.1 → V2.2 变更摘要

> 配套主文件：`dsh-workbuddy-bridge-plan-v2.2.md`
> 第三方审查：V2.1 第三轮审查报告（7 条 P0 + 9 条 P1）
> 关键判断：**V2.1 不能再写更多文档，必须清错并启动 P0**

---

## 1. 三条 P0 的处理（直接删 / 改伪代码 / 改边界）

### 🔴 P0 #1 — cordis.patch.yml 示例是虚构的

**原 V2.1**：给出 `host.apply` / `host.services` / `client.slots` 等 Loader 字段示例。
**V2.2 改动**：§3.2 改为占位段，**删除整段示例**；新增"禁止复制"提示 + "P0 必须实测 7 项"清单。
**为什么**：审查人对照 DSH 官方插件模板确认这些字段不是 Loader 的实际结构。V2.1 写"以 P0 实测为准"的免责说明没用——读者第一周就会复制。

### 🔴 P0 #2 — peerDependencies 是虚构的

**原 V2.1**：`@deepseek-ai/dsh-core` / `dsh-host-runtime` / `dsh-client-runtime` 等包名 + 版本约束。
**V2.2 改动**：§3.2 删除；§3.2 P0 实测清单里第 1–2 项取代——通过 `grep -r "@deepseek-ai/" packages/*/package.json` 找真实包名。
**为什么**：这些包名 DSH 仓库没有。

### 🔴 P0 #3 — 供应链"多源证据链"的安全结论错误

**原 V2.1**：把上游 commit / archive / toolchain / go.sum / build / `X-Service` 当"多源证据链"。
**V2.2 改动**：§8.3.1 重写为"段 A 下载完整 + 段 B 本地产物 + 段 C 运行身份"三段独立验证。
**错误要点**：
- ❌ `go.sum` 不构成"上游源码独立可信性证明"（与上游同一分发路径）
- ❌ `X-Service` = `"workbuddy2api"` 是字符串常量，**不**是密码学身份认证——攻击者可伪装同一字符串
- ❌ "启动期服务身份与 build manifest 一致" 不能验证"运行的就是刚才 build 的那个二进制"

正确做法：段 A 依赖 GitHub Release 元数据（可信第三方源）；段 B 是 self-consistency；段 C 只是进程所有权 + 服务身份识别（区分冒充服务，**不**做密码学证明）。

---

## 2. 四条 P0 的处理（涉及工程取舍，已与用户拍板）

### 🔴 P0 #4 — Linux Desktop 官方不支持

**审查人立场**：DSH `apps/desktop/README.md` 明确 "Linux is not a supported Desktop release target"。
**你的拍板**：**踢出首版严格范围**（采纳审查人建议）。
**V2.2 改动**：
- §0.4 / §2.4 / §4.3 / §11 P2/P3 全面更新支持矩阵
- 新增"Linux Desktop 非官方发布目标，不作首版承诺"段
- §4.3 跨平台冲突矩阵删除 Linux 强保证行
- §13 风险表新增 "Linux Desktop 不在 DSH 官方发布目标"，标 P1（环境）

**用户立场记录**：用户认可 Linux 可实际运行的事实，但仅在 P0 探针阶段 + 用户主动登记后才纳入。

### 🔴 P0 #5 — 端口分配无闭环

**审查人立场**：`SO_REUSEADDR` + 启动后记录不能解 TOCTOU；建议 "wb2api 接受 OS 端口 0 后回报实际端口"。
**你的拍板**：**冲突时用户手动指定**（不动 wb2api）。
**V2.2 改动**：
- §7.2 端口策略段新增 "V1 不实现自动选择未占用端口；走用户手动指定"
- 端口被占（`EADDRINUSE`）立即提示换端口
- 显式说明："实现自动分配须以 wb2api 接受 OS 随机端口 + 受控启动通道上报为前提；本计划不预先承诺"

### 🔴 P0 #6 — `runtime/active` atomic rename 不直接照搬

**审查人立场**：rename 不是事务保证；建议 `active.json` + `previous.json` + 平台替换流程。
**你的拍板**：**采纳 `active.json`**。
**V2.2 改动**：
- §8.4 替换 V2.1 的 "atomic rename" 三步骤为 7 步切换流程：
  1. 写入新版本到 `runtime/versions/<new-v>/`（不可变）
  2. backup 当前 `active.json` → `previous.json`
  3. 写入临时 `active.json.tmp`
  4. 平台替换提交（POSIX `rename(2)` / Windows `MoveFileEx(MOVEFILE_REPLACE_EXISTING)`）
  5. supervisor 停旧 → 启新
  6. 启动校验：`wb2api.sha256` + `/healthz` service + `/v1/models` 任一不过则回滚
  7. 数据迁移：仅在 schema 变更时执行，**先备份不静默**

新增"二进制切换 ≠ 数据迁移成功"段，要求两件事分别验收。

### 🔴 P0 #7 — DSH 找不到可信最小 cordis 模板时怎么办

**你的拍板**：**只在 §3.2 占位，P0 必须实测**。
**V2.2 改动**：
- §3.2 给出"DEMO forbidden" + 7 项 P0 实测清单
- §13 风险表新增 P0 行 "DSH 找不到可信的最小 cordis 模板"

---

## 3. 一条 P0 收尾——V2.1 §7.2 Linux 伪代码

**审查人立场**：`process.kill(-pid, signal)` + `spawn({detached:false})` 是错的组合；`prctl(PR_SET_PDEATHSIG)` 需 cgo。

**V2.2 改动**：§7.2 显式删除伪代码，列出"伪代码模式"作为禁止项；推荐"创建新进程组（POSIX `setsid` / Windows Job Object）作为进程容器"——具体代码由 P0/P2 选型确认，**不在文档中给伪代码**。

---

## 4. P1 修订 9 条（文档内部一致性问题）

| # | 位置 | 问题 | V2.2 处理 |
|---|---|---|---|
| 1 | §11 P0 | 允许 hardcoded API key | 改为"仅 DSH 凭据服务解析的 apiKeyRef；禁止源码或 fixtures 嵌入真实 key" |
| 2 | §5.1 / §3.1 | apiKeyEnv 与插件保存凭证的路径不清 | §5.1 新增"凭证路径收敛"段：写入 → 引用 → 解析 → 调用四步闭环 |
| 3 | §4.2 | Import 来源文件一致性 | §4.2 第 2 步新增"源实例必须先停 / 暂停或冻结写入" |
| 4 | §6.1.1 | `shell.openExternal` 不能直接用 | §6.1.1 重写：Host 不能直接访问 Electron Shell，必须经 DSH 提供的 shell bridge 接口 |
| 5 | §1.1 `cH:glm-5.2` 描述 | "未识别 → 报错" | 改为"wb2api 走默认 CN 裸名（实测行为）；插件层应主动拒绝" |
| 6 | §9.2 `go mod why -m all` | 不是 license 工具 | §9.2 改为 `go list -m -json all` + 实际扫描 |
| 7 | §11.5 | CLI 应是发布门槛 | §11.5 移除 CLI 验收门槛，仅 Desktop Windows / macOS 验收 |
| 8 | §12.4 | `nock` / `undici` mock 不算 E2E | §12.4 重写：unit / protocol-integration / smoke / E2E 四类分明，mock 仅属 protocol 层；M01–M10 必须在 E2E 测 |
| 9 | §0.3 / §13 | Linux Desktop 边界 | 已在 P0 #4 合并处理 |

---

## 5. 审查人保留的设计（V2.2 不动）

| 模块 | 判断 |
|---|---|
| §0 产品目标与 Attach → Managed 顺序 | 保留 |
| §1.1 WorkBuddy2API 实际 HTTP 端点 | 保留（仅 cH: 描述修订） |
| §4 Attach / Managed 进程及数据隔离 | 保留（Import 来源一致性加强） |
| §5.2 CN 模型去前缀策略 | 保留 |
| §5.4 Global 模型暂不开放 | 保留 |
| §5.5 M01–M10 Agent 验收硬门槛 | 保留（移到 §12.4 E2E 层） |
| §6 OAuth 登录状态机 | 保留 |
| §7.3 Liveness / Identity / Readiness 区分 | 保留 |
| §9 许可证与服务条款分离 | 保留 |
| §11 分阶段实施、阻断条件 | 保留 |
| §12 测试与故障恢复矩阵 | 保留 |

特别保留：**M03 / M04 工具调用闭环作为硬门槛**——这是审查人最赞赏的一项。

---

## 6. V2.2 决定：进入 P0，不是出 V2.3

审查人明确建议："**不建议再继续添加大段风险登记、重复的验证表或更多假设性的实现代码。下一轮修订应主要做技术错误清除与规则收敛，然后就应该真正运行 P0。**"

V2.2 完成这一轮收敛：

- 7 条 P0 已逐一清错
- 9 条 P1 已收敛
- 文档不能再用"经验证"标榜事实上未经验证的事实

---

## 7. P0 阶段必须立即做的几件事（来自 §3.2 清单）

V2.2 把 §3.2 的实测清单固化下来，P0 第一天就要跑：

1. `grep -r "@deepseek-ai/" packages/*/package.json` 取真实包名
2. 读目标 DSH 版本各 `packages/*/package.json#exports` / `version` / 入口
3. clone `templates/decoration` 取官方插件模板
4. 找到真实 Slot 注册机制 + `dsh.client` schema
5. 读 Host API 签名 + 可用 service 列表
6. 用相邻两个 DSH 版本实测兼容性
7. 把以上 6 项结论填入 §11 P0 "插件骨架最小可运行"项的子条目

外加 §11 P0 第 7 项已修订（运行时配置 + DSH 凭据服务解析的 apiKeyRef，禁止 hardcoded）。

---

## 8. V2.2 章节结构（与 V2.1 对比）

| 章节 | V2.2 状态 |
|---|---|
| §0 | 修订：新增 0.4 修订段 / §0.3 六规则保留 |
| §1 | 1.1 决策表 + P0 必须实测校准；1.4 上游假设保留 |
| §2 | §2.4 Linux Desktop 踢出范围 |
| §3 | §3.2 占位 + P0 7 项实测清单（V2.2 推翻 V2.1 例） |
| §4 | §4.2 Import 来源一致性；§4.3 Linux 强保证删 |
| §5 | §5.1 凭证路径收敛段（apiKeyEnv 四步闭环）；§5.2 决策表 |
| §6 | §6.1.1 shell bridge 重写 |
| §7 | §7.2 Linux 伪代码删 / 端口策略改 |
| §8 | §8.3.1 供应链三段重写 / §8.4 active.json 七步 |
| §9 | §9.2 License 命令纠错 |
| §10–§13 | §11 P0 hardcoded 改；§11.5 CLI 移除；§12.4 测试分层；§13 风险表新增 3 行 |
| §14–§16 | 保留 |

总体：**架构与阶段不变；技术性错误清空**。

---

## 9. 审查人的最终判断（直接引用）

> V2.1 已经可以指导 P0 的探索工作，但还不能作为 P0–P3 全流程的无监督执行规范。
>
> V2.1 审查结果：架构方向 ✅ 通过；直接实施准备度 ❌ 不足；首个 P0 探针 ✅ 可启动；Managed / 发布工程 ❌ 需修订。
>
> 现在这版（V2.2）满足：
> - **架构方向 ✅ 通过**
> - **直接实施准备度 → 🟡**（P0 阶段实测后才能达到完整就绪）
> - **首个 P0 探针 ✅ 可启动**
> - **Managed / 发布工程 → 仍需修订**（P0/P1 完成后再复核）

---

— 变更摘要 完 —
