# ADR 0022: Agent Studio 的 Feature-First 模型

日期：2026-10-07
状态：已接受

## 背景与问题

Agent Studio 此前以「项目」为一级实体：目录内 `agent-studio.json`（schema 4）承载项目档案（name / goal / features[] / tests[]），workspace state 侧另有 `projects.json` 注册表按项目 id 记账。产品语义上，用户在 Studio 里做的事是**开发一个个 feature**——会话跟着 feature 走、运行时指定一个目录——「项目」是强加在目录上的一层包装。这个错位在实现上产生了三类可观察的问题：

1. **三套并行的会话分组互不一致**：侧栏按 `openDirectory` 分组（ADR-0010 投影）、首页「项目」tab 按 `projects.json` 出卡片、项目详情页按 `studioProjectId` 过滤会话。直接后果：从 hero「新建项目」创建的会话（真正干活、初始化项目的那个）不写 `studioProjectId`，在项目详情页不可见。
2. **目录解析跨会话泄漏**：feature 的目录解析链回退到 workspace state 的 `openDirectory`——一个全工作空间共享、随任何一次会话创建被改写的字段。会话在首次调用 studio 工具前可能解析到别的会话漂移过来的目录。
3. **「项目」语言污染工具面**：`studio_initialize_project` 工具、每轮注入的「项目状态」、SKILL.md 与 system.md 的工作流描述，都会引导 agent 用「先建项目再做事」的心智与用户对话。

## 决策

### 1. feature 是唯一的一级实体；目录降级为运行环境字段

- 新增全局注册表 `~/.agentdev/AgentDevClaw/workspaces/agent-studio/features.json`：每条记录 `id = 包名`（legacy 模块无包名时用 feature 名），字段含 `directory`（可变）、`entry`、`buildCommand`、`status`（implemented → mounted → verified → snapshotted）、`verification`、`snapshot`、`staticInject`、`description`。**feature 状态与验证账本的唯一权威。**
- 目录内 `agent-studio.json` 保留文件名，语义降级为**目录环境清单**（schema 4 → 5）：只装目录级的东西——工具链、测试定义、Test Runtime 状态、agent-debug 登记。`name` / `goal` / `environment` / `projectDir` 删除；`features[]` 移交全局注册表。
- Test Runtime 仍按目录起进程；会话/检查点/运行记录仍留目录 `.agent-studio/` 下，不搬家。
- **目录移动** = `studio_add_feature` 以同名新路径重新注册：账本字段（status/verification/snapshot）保留，状态有效性由源码指纹在运行路径上另行判定；运行中的 runtime 按旧目录键控，移动前先 stop。

### 2. 会话与 feature 多对多绑定

- 会话记录持 `studioFeatureIds: string[]`（可空），`studio_create_feature` / `studio_add_feature` 执行时自动 append 到当前会话（runtime 经宿主注入的 sessionId/agentId/serverOrigin 调 server 窄口径端点回写）；从 feature 卡片「新建对话」预填 id。单值绑定会让「一次对话搭出互相依赖的两个 feature」丢一半记录。
- 首页顶部「最近的对话」区承接未绑定会话（新会话在 feature 诞生前暂存于此，诞生后自动进卡片）。

### 3. 目录解析链不再读共享状态

`activeProjectDir`（会话快照，会话内显式指定）→ `workspaceDir`（运行时宿主传入的会话自身目录）。workspace state 的 `openDirectory` 共享回退删除——它就是跨会话漂移的根源。会话自己的目录才是权威。

### 4. 工具面与工作流语言同步去「项目」化

- `studio_initialize_project` 删除；清单懒创建（`studio_select_toolchain` / `studio_create_feature` 首次自动落盘），对话里没有「初始化」步骤。
- `studio_get_project` → `studio_get_directory`；每轮注入改名「当前目录与 Feature 状态」，数据源 = 目录清单 + 全局注册表。
- Test Runtime 侧栏标签 `studio-sandbox:项目名` → `studio-sandbox:目录名`。
- system.md 与 SKILL.md 两处同步重写（同步规则不变：两处都注入给 dev agent）。

### 5. 迁移：一次性、幂等、服务启动时执行

`projects.json` + 各目录 schema ≤ 4 档案的 `features[]` → 生成 `features.json`；旧档案就地升级 schema 5；会话按 `openDirectory` 匹配把 `studioProjectId` 换算为该目录全部 feature 的 `studioFeatureIds`（宁多绑不丢可见性；目录已删的会话留空，由「最近的对话」兜底）；会话重绑定成功后删除 `projects.json`。注册表已有记录优先于旧档案数据，保证中断重跑安全；损坏条目跳过并记日志，不阻断其余迁移。

## 不做清单（显式边界）

- **不保留 studioProjectId 兼容层**：该字段唯一消费者就是旧项目详情页过滤，新模型无消费者；留一半旧一半新正是乱源的形态。
- **不动全局 Agent 注册表（agent-registry.js）的 `studioProjectDir` 字段名**：它是 `claw run` 消费的存储键，语义是「注册该 Agent 的 Studio 目录」，属内部存储命名，不在 UI/工作流语言范围。
- **不把目录档案（agent-studio.json）也收进全局注册表**：runtime 进程键、`.agent-studio/` 存储、测试定义天然按目录组织，搬走只增加改动面没有收益。
- **侧栏投影不动**：ADR-0010 的「工作空间 → 项目目录 → 运行中会话」本来就是「目录 = 环境」语义，与新模型一致。

## 后果

**正面**：用户心智与数据模型对齐（feature 是账本单元，目录是环境）；会话归属不再三套口径；目录漂移类 bug 的根源字段消失；工具面不再引导 agent 走「建项目」流程。

**代价**：一次性迁移触及存量 `projects.json`、各目录 schema ≤ 4 档案与历史会话索引（个人单机数据，量小）；`studio_*` 工具改名波及技能文档与测试，需一次对齐；旧「项目」概念下手动整理过 `agent-studio.json` 的用户，其 features[] 状态账本会经迁移进全局注册表，`name`/`goal` 字段丢弃。

**实施细节与文件清单**：见 [docs/plans/2026-10-07-agent-studio-feature-first-refactor.md](../plans/2026-10-07-agent-studio-feature-first-refactor.md)。
