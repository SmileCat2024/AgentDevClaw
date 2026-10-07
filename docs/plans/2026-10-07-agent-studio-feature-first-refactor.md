# Agent Studio Feature-First 重构实施计划

日期：2026-10-07
状态：已实施（2026-10-07，全部任务完成）
关联决策：[ADR-0022](../adr/0022-agent-studio-feature-first-model.md)

## 目标

移除「项目」概念：feature 成为唯一一级实体（全局注册表记账），目录降级为运行环境（目录清单），会话与 feature 多对多绑定，工具面/注入/UI/技能文档同步去「项目」化。存量数据一次性幂等迁移。

## 数据模型

### 全局 feature 注册表 `workspaces/agent-studio/features.json`

```jsonc
[{
  "id": "@agentdevjs/ticket-feature",  // 包名（legacy 模块用 feature 名），注册表内唯一
  "name": "ticket-feature",            // 类名/短名
  "directory": "D:/dev/demo",          // 注册所在 Studio 目录，可变（重注册 = 移动）
  "modulePath": "…/dist/index.js",
  "package": "@agentdevjs/ticket-feature",
  "source": { "kind": "project", "projectDir": "…", "entry": "…", "buildCommand": ["npm", "run", "build"] },
  "status": "verified",                // implemented → mounted → verified → snapshotted
  "verification": { "lastVerifiedRunId": "…", "coverage": { … }, "sourceDigest": "…" },
  "snapshot": { "version": "…", "archivePath": "…", "archiveDigest": "…", "createdAt": "…" },
  "staticInject": [],
  "description": "",                   // 注册时读 package.json
  "createdAt": "…", "updatedAt": "…"
}]
```

同名重注册保留账本字段（status/verification/snapshot/staticInject/createdAt），身份字段（directory/modulePath/package/export/source/description）以传入值为准。

### 目录环境清单 `agent-studio.json`（schema 5）

保留：`toolchain`、`testRuntime`、`tests[]`、`agent`（agent-debug 登记）+ `targetAgent`。
剥离：`features[]`（→ 全局注册表）、`name`、`goal`、`environment`、`projectDir`、项目 `id`。
懒创建：无独立初始化步骤，`studio_select_toolchain` / `studio_create_feature` 首次落盘。

### 会话绑定

`studioFeatureIds: string[]`（会话索引记录字段，可空）。`studio_create_feature` / `studio_add_feature` 执行时经 `POST /protoclaw/prebuilt_sessions/:sessionId/studio_feature_binding`（body: `agentId` + `featureIds`）append 回写；宿主（run-prebuilt-agent.js）向 agent 构造 config 注入 `agentId` / `sessionId` / `serverOrigin`。未注入身份时显式 skipped，不静默吞掉。

## 目录解析链

`activeProjectDir`（会话快照）→ `workspaceDir`（宿主传入的会话自身目录）。删除 workspace state `openDirectory` 共享回退。

## 改动清单

| # | 域 | 文件 | 内容 | 状态 |
|---|---|---|---|---|
| 1 | feature | `local-features/agent-studio/src/project-store.ts` | 目录清单 schema 5（读写 + normalize + 注入文案） | 完成 |
| 2 | feature | `src/feature-store.ts`（新） | 全局注册表 + `migrateLegacyRegistry` + `deleteLegacyProjectsRegistry` | 完成 |
| 3 | feature | `src/index.ts` | `resolveDirectory` 修正、懒迁移 `loadDirectory`、绑定回写、re-export | 完成 |
| 4 | feature | `src/tools.ts` | 删 `studio_initialize_project`、`studio_get_project` → `studio_get_directory`、`featureProjectDir` 参数、包名唯一性、注册即绑定 | 完成 |
| 5 | feature | `src/runtime-process.ts` | 消费面签名从 `AgentStudioProject` 改为清单 + features | 完成 |
| 6 | feature | `test/studio-feature.test.ts`、`test/feature-store.test.ts` | 重写 + 新增（迁移幂等 / 绑定回写 / 账本保留） | 完成 |
| 7 | 宿主 | `scripts/run-prebuilt-agent.js` | agent 构造 config 注入 agentId/sessionId/serverOrigin | 待做 |
| 8 | 装配 | `prebuilt-agents/official/agent-studio/agent.js` | AgentStudioFeature 构造传入会话身份 | 待做 |
| 9 | runtime | `scripts/run-studio-runtime.js` | sandbox 标签 `studio-sandbox:目录名` | 待做 |
| 10 | server | `server/routes/session.js` + `session-helpers*.js` + `shared/session-access.js` | `studioProjectId` → `studioFeatureIds` 全链路；新增绑定端点；启动迁移编排（迁移 → 会话重绑定 → 删 projects.json）；删 state.openDirectory 写入 | 待做 |
| 11 | 前端 | `modules/workspace-blocks.js`、`workspace-actions.js`、`app-main.js`、`app-ui.js` | 首页 = feature 卡片 + 最近对话条；详情页 feature 维度；payload 字段 | 待做 |
| 12 | 装配 | `metadata.json`（hero/按钮文案） | 「新建项目」→「新建对话」 | 待做 |
| 13 | 同步 | `skills/agent-studio-workflow/SKILL.md` + `.agentdev/prompts/system.md` | 工作流重写（两处同步规则不变） | 待做 |
| 14 | 测试 | `test/session-helpers-pure.test.js`、`test/session-utils.test.js`、`test/shared-modules.test.js` | 字段更替 | 待做 |
| 15 | 文档 | `AGENT.md`、glossary | Agent Studio 段重写 + ADR-0022 入列 | 待做 |

## 迁移设计（服务启动时，幂等）

1. `migrateLegacyRegistry`：读 `projects.json` → 逐目录读 schema ≤ 4 档案 → `features[]` 进全局注册表（已有记录优先）→ 档案就地升级 schema 5。损坏/缺失目录跳过并记日志。
2. 会话重绑定：按 `openDirectory` 匹配迁移覆盖目录，把该目录全部 feature id 写入该会话的 `studioFeatureIds`；已含 `studioFeatureIds` 的会话跳过；匹配不到留空。
3. 重绑定成功后 `deleteLegacyProjectsRegistry` 删除 `projects.json`。
4. 懒迁移兜底：未列入 `projects.json` 的旧档案，首次 `studio_get_directory` / `studio_start_runtime` 等读取路径上就地迁移（`loadDirectory`）。

## 验证计划

1. `npm run build:local-features` + agent-studio 域测试（45 用例，已绿）。
2. `npm run test:core`（session 域字段更替）+ 全量 `npm run test:features`。
3. 手动冒烟：schema 4 存量 → 启动迁移正确且幂等；首页 feature 卡片与旧会话归位（按 openDirectory 绑定）；hero 新建对话弹目录选择器；对话内 `studio_create_feature` 后会话出现在该 feature 卡片下；卡片「新建对话」预填目录不弹选择器；sandbox 标签为目录名。
