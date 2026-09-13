# 用户数据存储分区治理与 feature 持久资产收敛

## 状态

已接受（2026-09-13 存储体系梳理决策，Phase 0 + Phase 1）。

## 背景

对 `~/.agentdev`（用户级）与项目内 `.agentdev/`（项目级）的实地盘点暴露出三类问题：

1. **用户级三套寻址并行**。数据根 `~/.agentdev/AgentDevClaw`（`resolveUserDataDir`，支持 `AGENTDEV_DATA_DIR` 覆盖）之外，仍有写入点直连 `~/.agentdev/` 顶层：playwright-shell 的浏览器资产（`~/.agentdev/assets/`）、框架 core 的 LSP 二进制缓存（`~/.agentdev/lsp-bin`）与 file-history（`~/.agentdev/file-history/`）、装配安装根（`~/.agentdev/agent-dev/`、`feature-dev/`）。`AGENTDEV_DATA_DIR` 多实例隔离对这些路径全部失效。
2. **同一 feature 双根**。playwright-shell 的浏览器资产在 `~/.agentdev/assets/`，登录档案却在数据根内 `playwright-shell/profiles/`。
3. **`.agentdev` 目录身份过载**。任意被打开为项目的目录（包括用户 home 本身）都会被植入 docset（`claw-workspace/`）、`temp/`、`audit/` 等运行产物，与框架读取约定（`skills/`、`mcps/`、`prompts/`、`bashrc`）混在同一目录，入库与否无法用一条规则表达。

问题背后的共性需求：feature 是可插拔的，但部分 feature 需要**持久化预备的重资源**（浏览器二进制、LSP server 二进制）——它们可重建、生命周期跟随 feature 是否被装配（而非会话）、体积大且希望跨会话复用。这类"feature 持久资产"此前没有明确的存储归属，各 feature 各自硬编码，是路径逃逸数据根的主要来源。

## 决策

### 1. 数据根内部分区模型

`resolveUserDataDir()` 之下按存储性质分区，新写入点各归其区：

| 分区 | 位置 | 性质 |
|---|---|---|
| 配置 | `feature-setup.json`、`workspaces/<agentId>/feature-config/`、`auth.json` 等 | 用户意图，跨会话稳定 |
| 会话与线程 | `workspaces/<agentId>/sessions/`、`prebuilt-sessions/`、`threads/`、`context-handoffs/` | 会话生命周期数据 |
| 会话媒体 | `images/`、`uploads/` | 会话产生的二进制 |
| **feature 持久资产** | **`assets/<feature>/…`** | 可插拔 feature 预备的重资源：可重建、生命周期跟 feature 装配、清理安全 |
| 遥测与诊断 | `usage/`、`diagnostics/` | 只追加的观测数据 |

### 2. feature 持久资产规则

- 路径固定为**数据根 `assets/<feature-name>/…`**（如 `assets/playwright-shell/browsers`、`assets/lsp/bin`），由装配层（agent.js）**显式传参注入**，不依赖 feature/框架包的默认值。
- 框架与生态包自身的默认路径（如 core LSP 的 `~/.agentdev/lsp-bin`）保留，服务于不经 Claw 装配的框架用户；Claw 装配一律覆盖。
- 新增带持久资产需求的 feature，接口必须接受路径注入；评审时硬编码 `homedir()/.agentdev/...` 的默认路径不得成为 Claw 的唯一取值。
- 旧布局一次性 `rename` 迁移到新分区（新根已存在或旧根缺失则跳过）；迁移失败保持新根不动——资产可重建，缺失时由对应工具报缺并给修复指引，不静默回退旧布局。

### 3. `AGENTDEV_DATA_DIR` 是唯一隔离闸门

一切用户数据写入路径必须最终经 `resolveUserDataDir()` 解析。绕过数据根的直连路径视为缺陷。

### 4. 项目内 `.agentdev/` 分区

- **读取约定区**（随仓库走、可入库）：`skills/`、`mcps/`、`prompts/`、`bashrc`。
- **运行产物区**（不建议入库）：`claw-workspace/`（docset）、`temp/`。被打开为项目的目录植入这些子目录是预期行为，但仅限白名单内的子目录名。

### 5. audit-feature 废弃

2026-09-13 起 `@agentdevjs/audit-feature` 废弃、不再维护：Claw 移除全部挂载（预制 agent、agent 生成模板、装配推荐组合、打包与本地链接清单），删除根依赖；框架仓库包保留并打 DEPRECATED 标记，仅为历史兼容。其相对路径 `dbPath`（相对进程 cwd 解析，落到 Claw 项目根 `.agentdev/audit/`）的问题随废弃一并消解。既有 `audit.db` 数据无消费方，可手动删除。

### 6. 遗留物处置

| 遗留物 | 处置 |
|---|---|
| `~/.agentdev/file-history/` | Claw 未挂载 FileHistoryFeature，目录为历史遗留，可手动清理 |
| `~/.agentdev/claw-workspace/`、`~/.agentdev/temp/` | 以 home 为项目目录的历史会话产物，可手动清理 |
| `~/.agentdev/agent-dev/`、`feature-dev/`（装配根） | 暂保持（Phase 2 议题：迁移会破坏历史会话的 `openDirectory` 引用，需迁移脚本配套） |
| `~/.agentdev/assets/playwright-shell/browsers` | 首次使用时自动 rename 迁移到数据根 `assets/` 分区 |

## 取舍

- **不动框架包默认值**：file-history、lsp、image-reader 的 `~/.agentdev/` 直连默认值服务于框架自身用户；Claw 侧用装配传参覆盖（lsp-bin 本次落地，image-reader 既有 `storageDir` 注入已覆盖）。改默认值需跨仓库发版，收益仅限默认路径美观。
- **不迁移装配根**：`agent-dev/`、`feature-dev/` 承载真实用户工作现场，历史会话引用旧路径，迁移成本与风险单独立项评估。
- **可重建资产迁移失败不回退**：避免"永远用旧路径"的静默 fallback 掩盖迁移问题；缺失状态可被工具明确报告。

## 不变量

- 新增用户数据落盘位置必须位于 `resolveUserDataDir()` 之下。
- feature 持久资产必须位于数据根 `assets/<feature>/`，且经装配层显式注入路径。
- 项目内 `.agentdev/` 的运行产物不得混入读取约定区，读取约定区不得写入运行产物。
- 已废弃的 feature 不得重新出现在任何装配面（预制 agent、生成模板、推荐组合、打包与链接清单）。
