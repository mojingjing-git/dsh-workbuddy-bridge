# V2.2 → V2.2.1 变更摘要

> 配套主文件：`dsh-workbuddy-bridge-plan-v2.2.1.md`
> 第二轮复审来源：第三方独立审阅 12 条观察事项（5 处合并残留 + 1 处新事实错误 + 6 项细节修订）
> 关键判断：**不再出 V2.3 计划书**——本轮是 P0 启动前的"定点修补"，剩余 P2/P3 修订在对应阶段检查表内化处理

---

## 1. 三个合并残留（已修订）

### ① §8.2 / §11 P3 / §13 仍引用 `runtime/active` 旧机制

**V2.2 状态**：
- §8.4 已改为 `active.json` + `previous.json`
- 但 §8.2 目录树仍写 `runtime/active`（目录/符号链接）
- §11 P3 仍写"§8.4 不可变目录 + atomic rename"
- §13 风险表"Windows 二进制"行 block-criterion 仍写"runtime/active 原子 rename"

**V2.2.1 修订**：
- §8.2 目录树：`runtime/active` → `runtime/active.json` + `runtime/previous.json`（注 V2.2 起）
- §11 P3 改为"§8.4 不可变目录 + `active.json` / `previous.json` 切换，**不**用 `runtime/active` 目录或 symlink"
- §13 "Windows 二进制"行 block-criterion 改为"`active.json` 提交后 supervisor 启动新版 + 校验 `wb2api.sha256` + `/healthz` service + `/v1/models` 任一失败回滚到 `previous.json`"
- §13 新增 P1 文档残留风险行："grep V2.2.1 文档剩余 `runtime/active` 字符串 = 0" 作为解除条件

### ② Linux 已踢出首版，但 P2 仍要求测试 Linux

**V2.2 状态**：P2 第 8 条写"macOS arm64/amd64 和 Linux amd64/arm64 逐平台验证"。

**V2.2.1 修订**：
- P2 拆为"首要完成条件（Windows x64）/ 真实测试机到位才纳入发布（macOS）/ 不阻断 P2 退出条件（Linux）"
- 第 7 条新增"smoke test 用**明确指定测试端口**，绑定失败即报错更换，不据此宣称实现了自动端口分配"
- 第 4 条 Linux 单独标"不在首版发布目标；用户在 Linux 上跑通并报告的问题，登记到 §13 风险表 P1 而**不**作为 P2 退出阻塞"

### ③ §3.2 占位段引用虚构包路径

**V2.2 状态**：§3.2 P0 实测清单第 5 项写"`~/.dsh/profiles/desktop/node_modules/@deepseek-ai/dsh-host-runtime/`"。

**V2.2.1 修订**：
- 第 5 项改为"根据第 1 步拿到的**真实包名清单**定位；**禁止**预设 `@deepseek-ai/dsh-host-runtime` 这类未经核实的包名路径"
- §3.2 末尾新增"官方模板 vs 占位"段：P0 第一步改为"克隆 `templates/decoration` 到本地，按其结构写本插件的 patch"，把模板校验过的字段作为**唯一可信来源**

---

## 2. 三个事实错误（已修订）

### ① `cH:` 大小写敏感判定错误

**V2.2 写**："`cH:glm-5.2` 未识别 → wb2api 走默认 CN 裸名"
**实测 `resolve_model.go` 第 22 行**：`if prefix != "cn" && prefix != "global" { return "cn", model }` —— **大小写敏感**，前缀不识别时**整个原串作为 bare 透传**（`cH:glm-5.2 → (cn, cH:glm-5.2)`），容易以错误模型名打到上游。

**V2.2.1 修订**：§1.1 决策表行更新为 `(cn, cH:glm-5.2) → cH:glm-5.2`；§5.2 算法主动拒绝规则加强；§13 新增"非小写前缀被透传" P0 风险。

### ② Release `checksums.txt` 不覆盖源码 archive

**V2.2 §8.3.1 段 A 写**："archive SHA256（来源 release tarball）"
**实测 v1.13.0 Release assets**：只有 5 个平台预编译二进制 + `checksums.txt`（仅二进制 SHA256）；**无源码 archive attachment**。GitHub 自动 `tarball_url` / `zipball_url` 不是 release assets。

**V2.2.1 修订**：
- §8.3.1 段 A 重写："V1 必须把 v1.13.0 源码 archive **在发行前由受控流程**生成并固定 SHA256（先 git clone + git checkout + tar 打包，发布时校验）；不要'首次下载时边下载边生成可信预期值'"
- 嵌入实测 `checksums.txt` 内容（5 行二进制 SHA256 + 文件名）
- §11 P2 第 1 条验收点改为"受控流程生成的源码 archive SHA256 校验"
- §13 风险表"供应链"行 block-criterion 改为"段 A 下载完整 + 段 B 本地产物 + 段 C 运行身份三段独立验证；`checksums.txt` 覆盖预编译二进制但不覆盖源码 archive——后者须受控流程生成"

### ③ `shell.openExternal` 进程模型错误

**V2.2 §6.1.1 写**："Electron renderer 的 API；Host 插件运行在 DSH 主进程或独立 Node worker，**不能**直接访问 renderer 的 `shell`"
**事实**：`shell.openExternal` 在 Electron main 进程与 unsandboxed renderer **都**可用；真正问题是"DSH Host 插件能不能加载 electron 模块"。

**V2.2.1 修订**：
- §6.1.1 改正事实
- 不变结论：DSH Host 运行环境**未必**能直接 `require('electron').shell`；先探测 DSH 是否提供外部浏览器打开 bridge 接口；不可用则一律走"复制 URL"按钮
- §13 新增"DSH 是否提供外部浏览器打开 bridge 接口未知" P1 风险

---

## 3. 三个 P2/P3 阶段前修订（已写进 P2/P3 检查项）

### ① 升级数据迁移顺序（V2.2.1 §11 P3 / §8.4 修订）

**审查人 P0（升级事务必须修正）**：
> 新网关在启动时就可能读取或修改旧格式的状态文件。"启动新版后才考虑迁移"不能保证安全回滚。

**V2.2.1 修订**：§11 P3 新增升级数据迁移顺序步骤：
1. 构建新版并检查兼容性
2. **先停旧进程、确认数据写入结束**
3. **备份需要迁移的全部状态**（`state.json` + `config.json` + `auths/` + 其他可能变化的文件，**不**只备份 `state.json`）
4. 必要时迁移至隔离目录
5. 切换 `active.json` 并启动新版
6. 验证
7. 失败时恢复旧二进制和对应数据

§13 新增"升级时新版本直接读旧格式 state.json 致不可逆破坏" P0 风险。

### ② §1.1 `/healthz` 503 措辞

**V2.2 写**："真正进程退出 = 子进程 `exit` 事件 + `/healthz` 网络失败（如 ECONNREFUSED）"
**审查意见**：Managed 子进程退出的最直接判据就是 `exit` 事件 + 操作系统进程不存在查询，**不**需要等 `/healthz` 网络失败。

**V2.2.1 修订**：
- §1.1 明确：`/healthz` 503 不等于进程死亡；`/healthz` ≠ 身份认证
- Managed 子进程退出 = 进程 `exit` / `close` 事件 + OS 进程查询
- `/healthz` 的 `service: workbuddy2api` 与 `X-Service` 头仅做"识别冒充服务"用，不构成进程身份认证

### ③ §11.5 发布自豁免

**V2.2 §11.5 第 8 项写**："仅当上述三平台不具备真实环境时，该项标注'未验证'，**不作为发布阻塞**"——这会导致没有 Mac 测试结果却以支持 macOS 的名义发布。

**V2.2.1 修订**：每平台独立发布，**不允许"未测但先打 macOS 标签"**：
- Windows 通过 → 发 Windows 版
- macOS 通过 → 追加 macOS
- 未实测的平台**不**列入 README 支持矩阵

---

## 4. 审查人 #11 风险表同步（V2.2.1 全部对齐）

V2.2 风险表里几条 block-criterion 引用了已废弃的设计（`runtime/active` 原子 rename、6 步验证链），V2.2.1 全部改正：

| 风险行 | 旧 block-criterion | 新 block-criterion（V2.2.1） |
|---|---|---|
| Windows 二进制 | `runtime/active` 原子 rename | `active.json` 提交后 supervisor 启新版 + 校验 + 失败回滚到 `previous.json` |
| 供应链 | §8.3.1 链 6 step 全过 | 段 A + 段 B + 段 C 三段独立验证；源码 archive SHA256 由受控流程生成 |

并新增 4 条 P0/P1 风险：
- "非小写前缀 `cH:` 被 wb2api 当模型名原串透传"（P0）
- "升级时新版本直接读旧格式 state.json 致不可逆破坏"（P0）
- "DSH 是否提供外部浏览器打开 bridge 接口未知"（P1）
- "DSH `runtime/active` 旧式引用残留"（P1 文档）

---

## 5. 审查人保留的设计（V2.2.1 不动）

审查人最终批准意见已明确：
- 架构方向 ✅ 通过
- P0 协议探针 ✅ 立即执行
- P1 Attach MVP ✅ P0 验收后执行
- P2 Managed 🔧 构建前定点修订
- P3 更新与发布 🔧 升级事务必须修正

V2.2.1 改的就是审查人列出的 P2/P3 修订要点（不阻碍 P0，**不**再出 V2.3）。剩余工程化内容都在阶段检查表内化。

---

## 6. P0 启动前的最终检查

| 项 | V2.2.1 位置 | 状态 |
|---|---|---|
| 决策表 `cH:` 真实行为 | §1.1 | ✅ 已修正 |
| §3.2 不引用虚构包路径 | §3.2 P0 实测清单 | ✅ 已删除 |
| Linux Desktop 边界 | §0.4 / §2.4 / §11 P2 | ✅ 一致 |
| 端口走用户手动 | §7.2 / §11 P2 | ✅ 一致 |
| `active.json` 切换 | §8.2 / §8.4 / §11 P3 | ✅ 一致 |
| 升级数据迁移顺序 | §11 P3 | ✅ 已补 |
| 风险表 block-criterion | §13 | ✅ 已对齐 §8.4 与 §8.3.1 |
| `checksums.txt` 不覆盖源码 | §8.3.1 段 A | ✅ 已说明 |
| Shell bridge 措辞 | §6.1.1 | ✅ 已纠正 |
| 阶段发布自豁免 | §11.5 | ✅ 已删除 |

V2.2.1 已就绪，**可以启动 P0**。

---

## 7. V2.2.1 章节结构

| 章节 | V2.2.1 状态 |
|---|---|
| §0 | 不变 |
| §1 | §1.1 决策表行 + `/healthz` 措辞 |
| §3 | §3.2 占位段加"官方模板 vs 占位"段 + 删虚构包路径 |
| §4 | §4.1 Attach REST 写入权限边界 |
| §6 | §6.1.1 Shell bridge 措辞纠正 |
| §7 | 不变（已 V2.2 修订） |
| §8 | §8.2 目录树 `active.json` + §8.3.1 段 A 受控流程生成源码 archive SHA256 + 嵌入实测 checksums.txt |
| §11 | P2 Linux 验收非阻断 + smoke test 端口规则 + P3 升级数据迁移顺序 + §11.5 自豁免删除 |
| §13 | 2 行 block-criterion 改正 + 4 行新增 |
| §15 | 不变 |

---

## 8. 三轮事实校正日志已扩展至 25 行

附录 B 现在包含：

| 类别 | 修正前 | 修正后 | 触发轮次 |
|---|---|---|---|
| （V1→V2 早期行，保留） | | | |
| DSH `cordis.patch.yml` Loader 字段 | V2.1 虚构 | V2.2 占位 + P0 实测 | V2.1 → V2.2 |
| DSH `peerDependencies` | V2.1 虚构 | V2.2 占位 + grep 真实包名 | V2.1 → V2.2 |
| 供应链验证 | V2.1 "6 段多源证据链" | V2.2 三段独立验证 | V2.1 → V2.2 |
| Linux Desktop 定位 | V2.1 三 OS 支持 | V2.2 踢出首版 | V2.1 → V2.2 |
| 端口策略 | V2.1 `SO_REUSEADDR` 假设 | V2.2 用户手动指定 | V2.1 → V2.2 |
| `runtime/active` 切换 | V2.1 atomic rename 假设 | V2.2 `active.json` + `previous.json` 7 步 | V2.1 → V2.2 |
| Linux 进程兜底 | V2.1 `process.kill(-pid,…)` | V2.2 删除伪代码 | V2.1 → V2.2 |
| `shell.openExternal` 调用方 | V2.1 host 直调 | V2.2 经 DSH shell bridge | V2.1 → V2.2 |
| 测试分层 | V2.1 mock = E2E | V2.2 区分 unit / protocol / smoke / E2E | V2.1 → V2.2 |
| License 审计命令 | V2.1 `go mod why` | V2.2 `go list -m -json all` | V2.1 → V2.2 |
| **`cH:` 大小写判定** | **V2.2 走默认 CN 裸名**（错） | **V2.2.1 整串透传，插件层主动拒绝** | V2.2 → V2.2.1 |
| **Release `checksums.txt` 覆盖范围** | **V2.2 含源码 archive**（错） | **V2.2.1 仅预编译二进制；源码 archive 须受控流程生成** | V2.2 → V2.2.1 |
| **`shell.openExternal` 进程模型** | **V2.2 仅 renderer**（错） | **V2.2.1 main 与 unsandboxed renderer 都可用；DSH Host 不一定加载 electron** | V2.2 → V2.2.1 |
| 升级数据迁移顺序 | V2.2 启动后才迁移 | V2.2.1 先停旧 / 备份全量 / 迁移 / 切 active / 启新 | V2.2 → V2.2.1 |
| §11.5 发布自豁免 | V2.2 "未验证不阻塞" | V2.2.1 每平台独立发布 | V2.2 → V2.2.1 |

---

## 9. 审查人最终判断（直接引用）

> 这次复审进一步确认，剩余问题大多不处于 P0 的关键路径上，不需要等待 V2.3 才能动手。
>
> 我建议将 V2.2 作为当前开发基线，在首个 PR 中同步清理本轮发现的源码事实错误，其余问题登记到对应阶段的验收任务。
>
> 下一次值得审查的应该是 P0 的真实代码、日志和测试结果，而不是第四份计划书。

**V2.2.1 完成"首个 PR 同步清理"任务**：5 项 P0 前清理 + 3 项 P1 顺手改 + 风险表同步 + 数据迁移顺序补全。
**不**再出 V2.3。**下一步**：P0 探针 + 实际代码 / 日志 / 测试结果。

---

— 变更摘要 完 —
