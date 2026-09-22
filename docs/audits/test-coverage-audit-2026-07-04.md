# 测试覆盖审计报告

> 生成时间：2026-07-04
> **更新时间：2026-07-12 — 审计中发现的问题已基本解决，详见文末"解决状态"**
> 范围：server.js 拆分重构（a2ea2d4）完成后的全面测试覆盖审查
> 原始测试状态：541 cases / 537 pass / 0 fail / 4 skip（全绿）
> 当前测试状态：1,008+ cases（inline mirror 清零，安全函数已覆盖）

---

## 一、总览数据

### 1.1 代码 vs 测试量

| 维度 | 行数 |
|------|------|
| 服务端代码（server.js + routes/ + shared/ + root + context-continuity） | ~18,364 |
| 服务端测试（test/*.test.js） | 8,361 |
| local-features 源码 | ~4,690 |
| local-features 测试 | ~792 |

### 1.2 测试文件清单

| 测试文件 | 行数 | 被测对象 | 测试方式 |
|---------|------|---------|---------|
| `dispatch-routes.test.js` | 909 | `routes/dispatch.js` + `runtime-call-envelope.js` | **直接 import** |
| `group-chat-data-layer.test.js` | 786 | `routes/group-chat.js` 辅助函数 | **inline mirror** |
| `call-arbiter.test.js` | 638 | `scripts/run-prebuilt-agent.js` CallArbiter | **inline mirror** |
| `workspace-creators.test.js` | 510 | `routes/workspace-creators.js` + `workspace.js` | **直接 import** |
| `speech-model.test.js` | 431 | `routes/model-config.js` 语音模型 | **inline mirror** |
| `im-data-pipelines.test.js` | 389 | `routes/im.js` | **直接 import** |
| `im-config-serializer.test.js` | 379 | `routes/im.js` withIMWorkspaceConfig | **inline mirror** |
| `session-utils.test.js` | 370 | session 工具函数 | **inline mirror** |
| `flow-capabilities.test.js` | 333 | `routes/flow.js` | **直接 import** |
| `session-extraction.test.js` | 320 | `routes/session.js` + `session-helpers.js` | **直接 import** |
| `claw-core.test.js` | 292 | claw-mcp provider 架构 | 混合 |
| `feature-mount-unmount.test.js` | 287 | Agent feature mount/unmount | 真实 Agent |
| `session-model-meta.test.js` | 284 | session 元数据持久化 | **inline mirror** |
| `collect-identities.test.js` | 278 | `routes/agent-discovery.js` collectIdentities | **inline mirror** |
| `trim-compact-fixes.test.js` | 274 | `context-continuity/handoff-package.js` | **直接 import** |
| `runtime-call-envelope.test.js` | 262 | `server/runtime-call-envelope.js` | **直接 import** |
| `title-mirror-helpers.test.js` | 254 | `scripts/run-title-mirror.js` | 混合（mirror-runtime.js 部分导入） |
| `session-ui-context.test.js` | 251 | `public/src/app-core.js` 前端逻辑 | vm sandbox 求值 |
| `shared-modules.test.js` | 229 | `server/shared/*` | **直接 import** |
| `session-cleanup.test.js` | 220 | session 清理逻辑 | **inline mirror** |
| `system-feature-config.test.js` | 177 | `routes/system-feature-config.js` | **inline mirror** |
| `tool-registry.test.js` | 130 | agentdev ToolRegistry | 真实导入 |
| `partial-compact-rollback.test.js` | 107 | compact-rollback 特性 | 真实 Agent |
| `feature-continuity.test.js` | 88 | `context-continuity/feature-continuity.js` | **直接 import** |
| `branch-checkpoint.test.js` | 83 | branch checkpoint 校验 | **inline mirror** |
| `feature-utils.test.js` | 80 | `server/shared/feature-utils.js` | **直接 import** |

### 1.3 按测试方式统计

| 方式 | 文件数 | 占比 | 说明 |
|------|-------|------|------|
| 直接 import 真实代码 | 12 | 46% | 代码修改后测试自动跟随 |
| inline mirror（复刻逻辑） | 11 | 42% | **代码修改后测试不会报错——虚假安全** |
| 混合 / 其他 | 3 | 12% | 部分导入、部分复刻，或特殊机制 |

---

## 二、核心问题：11 个 inline mirror 测试详情

inline mirror 测试在测试文件内**复制粘贴**了被测逻辑，而非 import 真实代码。重构后真实代码已迁移到新模块，mirror 副本可能早已与源码脱节。**修改源码不会导致这些测试失败**。

### 2.1 逐个分析

#### `call-arbiter.test.js`（638 行）— 风险：高

- **复刻对象**：`scripts/run-prebuilt-agent.js` 中的 `CallArbiter` 类
- **真实代码位置**：仍在 `scripts/run-prebuilt-agent.js:265`
- **脱钩风险**：CallArbiter 是并发调用仲裁的核心，任何状态机修改都不会被测试捕获
- **修复难度**：中。CallArbiter 嵌入在 run-prebuilt-agent.js 的运行时上下文中，需要 extract 到独立文件后 import

#### `collect-identities.test.js`（278 行）— 风险：高

- **复刻对象**：`scripts/run-prebuilt-agent.js` 的 `collectIdentities`
- **真实代码位置**：已迁移到 `server/routes/agent-discovery.js:306`（作为闭包函数返回）
- **脱钩风险**：重构后 collectIdentities 已经换到新位置，mirror 副本可能过时
- **修复难度**：高。当前实现是 `createAgentDiscoveryModule(ctx)` 返回的闭包，不便于直接 import 测试

#### `session-utils.test.js`（370 行）— 风险：高

- **复刻对象**：server.js 的 `buildSessionTitle`、`computeNextSessionNumber`、`normalizeSessionMetadata`
- **真实代码位置**：
  - `buildSessionTitle` → `server/shared/session-access.js:188`
  - `normalizeSessionMetadata` → `server/shared/session-access.js`（被 session-helpers.js 引用）
  - `computeNextSessionNumber` → `server/routes/session-helpers.js`
- **脱钩风险**：真实代码已分散到多个模块，mirror 版本是一个统一的副本
- **修复难度**：低。这些函数现在都已经在模块中直接 export，改 import 即可

#### `session-cleanup.test.js`（220 行）— 风险：高

- **复刻对象**：server.js 的 `cleanupEmptySessions`、`selectEmptySessions`、`resolvePostCleanupState`
- **真实代码位置**：`cleanupEmptySessions` → `server/routes/session-helpers.js:695`
- **脱钩风险**：cleanup 逻辑决定哪些会话被删除，逻辑出错会丢用户数据
- **修复难度**：中。`selectEmptySessions` 和 `resolvePostCleanupState` 当前未独立 export

#### `system-feature-config.test.js`（177 行）— 风险：中

- **复刻对象**：server.js 的 `readSystemFeatureConfig`、`writeSystemFeatureConfig`
- **真实代码位置**：已迁移到 `server/routes/system-feature-config.js:85`（`readSystemFeatureConfigFile`）
- **脱钩风险**：中等。文件 I/O 逻辑有变化但核心序列化路径相似
- **修复难度**：低。改 import 路径即可

#### `speech-model.test.js`（431 行）— 风险：中

- **复刻对象**：server.js 的 `normalizeSpeechModel`、`convertAudioToWav`、`encodeWav`、`generateSilentWav`、`isFfmpegAvailable`
- **真实代码位置**：`normalizeSpeechModel` → `server/routes/model-config.js:252`
- **脱钩风险**：normalize 逻辑是配置读写的关键路径
- **修复难度**：中。WAV 编码相关函数未独立 export

#### `group-chat-data-layer.test.js`（786 行）— 风险：高

- **复刻对象**：server.js 的 `searchInText`、`composeDispatchPrompt`
- **真实代码位置**：`server/routes/group-chat.js`（3242 行，47 个函数中仅复刻了 2 个）
- **脱钩风险**：极高。group-chat.js 是全项目最大模块，复刻覆盖率 < 5%
- **修复难度**：高。大量函数是 `createGroupChatModule(ctx)` 返回的闭包

#### `im-config-serializer.test.js`（379 行）— 风险：中

- **复刻对象**：server.js + group-admin 的 `createSerializer`、`gcDispatchGuard`
- **真实代码位置**：`createConfigSerializer` → `server/routes/im.js`（被 `withIMWorkspaceConfig` 使用）
- **脱钩风险**：序列化逻辑变化不会反映到测试
- **修复难度**：中

#### `session-model-meta.test.js`（284 行）— 风险：中

- **复刻对象**：`session-helpers.js` 的 `createPrebuiltSession` / `resolveSessionModel`
- **真实代码位置**：部分函数已在模块中 export（`session-helpers.js:1659` 区域）
- **脱钩风险**：session 元数据决定持久化行为，mirror 版本和真实代码可能已不一致
- **修复难度**：中

#### `branch-checkpoint.test.js`（83 行）— 风险：低

- **复刻对象**：server.js branch 端点的 `findMissingCheckpoints`
- **真实代码位置**：已迁移到 session 相关路由模块
- **脱钩风险**：逻辑简单，脱钩概率低，但仍是隐患
- **修复难度**：低

#### `title-mirror-helpers.test.js`（254 行）— 风险：低

- **复刻对象**：`scripts/run-title-mirror.js` 的辅助函数
- **真实代码位置**：部分已通过 `scripts/mirror-runtime.js` 导入
- **脱钩风险**：较低。已有部分真实 import
- **修复难度**：低

### 2.2 inline mirror 总结

| 修复难度 | 测试文件 | 优先级 |
|---------|---------|--------|
| 低（改 import 即可） | session-utils、system-feature-config、branch-checkpoint、title-mirror-helpers | **P0-a** |
| 中（需要 export 补充） | session-cleanup、session-model-meta、speech-model、im-config-serializer | **P0-b** |
| 高（需要架构调整） | call-arbiter、collect-identities、group-chat-data-layer | **P0-c** |

---

## 三、零覆盖模块详情

### 3.1 零覆盖路由模块（8 / 16）

```
routes/agent-discovery.js        423 行 — agent 发现、身份注册、会话索引读取
routes/agent-lifecycle.js        832 行 — agent 启停状态机、spawn 子进程
routes/assembly-helpers.js       195 行 — feature 装配、依赖哈希
routes/feature-repository.js     631 行 — feature 包扫描、元数据推断
routes/fs-operations.js          218 行 — 命令执行、目录选择
routes/model-config.js           553 行 — 模型预设序列化/反序列化
routes/project-docset.js         344 行 — 项目文档集 ID 生成、payload 清洗
routes/system-feature-config.js  216 行 — 系统 feature 配置读写
routes/group-chat.js            3242 行 — 群聊系统（47 个函数）
```

#### 各模块可测纯函数清单

**`routes/workspace.js`（894 行）— 纯函数密集，ROI 最高**

| 函数 | 类型 | 风险面 |
|------|------|--------|
| `normalizeFeatureConfigs(rawConfigs)` | 纯函数 | feature 配置序列化 |
| `normalizeWorkspaceState(raw)` | 纯函数 | workspace 状态持久化 |
| `normalizeWorkspaceFeatureProject(raw)` | 纯函数 | feature-creator 草稿 |
| `normalizeWorkspaceAgentProject(raw)` | 纯函数 | agent-creator 草稿 |
| `normalizeWorkspacePhProject(raw)` | 纯函数 | programming-helper 项目 |
| `upsertWorkspacePhProject(state, rawProject, ts)` | 纯函数 | 项目增删改 |
| `removeWorkspacePhProject(state, projectId)` | 纯函数 | 项目删除 |

> 注：workspace.js 有 workspace-creators.test.js 覆盖，但仅覆盖了 creator 路由注册，normalize 系列函数未被测试。

**`routes/project-docset.js`（344 行）**

| 函数 | 类型 | 风险面 |
|------|------|--------|
| `sanitizeProjectDocsetId(value)` | 纯函数 | ID 注入防护 |
| `buildProjectDocsetMarkdownId(title, createdAt, fallbackPrefix)` | 纯函数 | markdown ID 生成 |
| `cleanProjectDocsetPayload(raw)` | 纯函数 | payload 清洗 |
| `normalizeProjectConversationRecord(raw)` | 纯函数 | 对话记录规范化 |
| `extractMaterialSourcePath(content)` | 纯函数 | 素材路径提取 |

**`routes/assembly-helpers.js`（195 行）**

| 函数 | 类型 | 风险面 |
|------|------|--------|
| `isValidFeatureName(value)` | 纯函数 | feature 名校验（安全面） |
| `resolveFeatureCreatorOutputDir(parentDir, featureName)` | 纯函数 | 路径拼接（注入风险） |
| `toFileDependencySpec(targetPath)` | 纯函数 | file: 协议格式化 |
| `computeDependencyHash(dependencies)` | 纯函数 | 依赖哈希（影响缓存） |

**`routes/model-config.js`（553 行）**

| 函数 | 类型 | 风险面 |
|------|------|--------|
| `normalizeModelPresetsData(data)` | 纯函数 | 预设数据规范化 |
| `flattenModelPresets(data)` | 纯函数 | 扁平化转换 |
| `buildStructuredModelPresets(flatPresets, existingData)` | 纯函数 | 结构化转换 |
| `normalizeSpeechModel(raw)` | 纯函数 | 语音配置规范化 |
| `normalizeSpeechPreset(raw)` | 纯函数 | 语音预设规范化 |

> 注：`normalizeSpeechModel` 已被 `speech-model.test.js` 以 inline mirror 覆盖，但不信任。

**`routes/feature-repository.js`（631 行）**

| 函数 | 类型 | 风险面 |
|------|------|--------|
| `normalizeFeatureRequirements(raw)` | 纯函数（未 export） | 需求规范化 |
| `normalizeFeatureTypes(values)` | 纯函数（未 export） | 类型规范化 |
| `normalizeFeatureCompatibility(raw, types)` | 纯函数（未 export） | 兼容性规范化 |
| `inferFeatureTypes(pkg, baseId)` | 纯函数（未 export） | 类型推断 |
| `inferFeatureManifest(pkg, archiveName)` | 纯函数（未 export） | manifest 推断 |
| `mergeFeatureRepositoryPackages(...catalogs)` | 纯函数（已 export） | catalog 合并 |

### 3.2 零覆盖 server 根模块（4 / 5）

**`server/conversation-renderer.js`（941 行）— 用户可见数据核心**

负责将对话消息渲染为 HTML，被 `routes/session.js` 的导出功能调用。

| 函数 | 行数 | 风险 |
|------|------|------|
| `escapeHtml(text)` | ~5 | XSS 防护第一道关 |
| `renderMarkdown(text)` | ~80 | markdown 渲染 |
| `groupByTurn(messages)` | ~50 | 消息分组逻辑 |
| `renderConversationHtml(messages, options)` | ~100 | 主渲染入口 |
| `parseToolResult(content)` | ~30 | 工具结果解析 |
| `buildToolCallIndex(messages)` | ~40 | 工具调用索引 |
| `formatToolError(data)` | ~20 | 错误格式化 |

> 风险评估：`escapeHtml` 是 XSS 防护核心，如果实现有误会导致导出的 HTML 中存在注入漏洞。

**`server/usage-ledger.js`（344 行）— 新增模块，纯函数密集**

| 函数 | 类型 | 风险面 |
|------|------|--------|
| `cleanText(value)` | 纯函数 | 输入清洗 |
| `toNumber(value)` | 纯函数 | 数值解析 |
| `normalizeDate(value)` | 纯函数 | 日期解析 |
| `normalizeUsage(usage)` | 纯函数 | usage 数据规范化 |
| `normalizeModel(model)` | 纯函数 | 模型信息规范化 |
| `buildUsageEvent(raw)` | 纯函数（已 export） | 事件构建 |
| `stableHash(value)` | 纯函数 | 哈希去重 |
| `hashBaseUrl(value)` | 纯函数 | URL 哈希 |

**`server/claw-mcp.js`（368 行）**

Claw 自有 MCP 工具注册（explorer spawn、sub-agent resume 等）。

**`server/model-preset-resolver.js`（137 行）**

模型预设解析，决定 agent 用哪个 LLM。两个 export 函数都依赖文件 I/O 和 `createLLM()`，适合 mock 测试。

### 3.3 零覆盖 context-continuity 模块（2 / 4）

**`server/context-continuity/summarized-handoff.js`（300 行）**

compact resume 链路核心。用户做上下文精简时直接依赖。

| 函数 | 类型 | 风险 |
|------|------|------|
| `sanitizeFragment(value)` | 纯函数 | ID 清洗 |
| `cleanInlineText(value)` | 纯函数 | 文本清洗 |
| `cleanMultilineText(value)` | 纯函数 | 多行文本清洗 |
| `buildSourceRecord(sourceRecord)` | 纯函数 | 源记录构建 |
| `buildCompactOverview(sourceRecord)` | 纯函数 | 概览构建 |
| `normalizeSummaryPolicy(rawPolicy)` | 纯函数 | 策略规范化 |
| `buildSummarySeedMessage(summaryText)` | 纯函数 | 种子消息构建 |

**`server/context-continuity/claude-compact-prompts.js`（165 行）**

compact prompt 模板。纯字符串模板，行为稳定但无回归保护。

### 3.4 零覆盖 local-features（2 个活跃 feature）

| feature | 行数 | 状态 | 测试 |
|---------|------|------|------|
| **group-admin** | 500 | **活跃维护** | **零测试** |
| conversation-export | 84 | 活跃维护 | 零测试 |

`group-admin` 是工作群 Beta 的核心后端逻辑：群状态查看、消息读取、任务派发、摘要写入、身份提醒注入。500 行 TypeScript 无任何测试覆盖。

### 3.5 浅覆盖 local-features

| feature | 行数 | 测试行数 | `it()` 数 | 问题 |
|---------|------|---------|----------|------|
| context-handoff-seed | 367 | 71 | 0 | smoke 级别，无断言 |
| context-compaction-mirror | 52 | 64 | 0 | smoke 级别，无断言 |
| flow（悬置） | 1,383 | 179 | 0 | 浅 |

---

## 四、模块级测试覆盖矩阵

### 4.1 完整映射

| 服务端模块 | 行数 | 有测试 | 测试方式 | 有效覆盖 |
|-----------|------|--------|---------|---------|
| `server.js`（入口） | 781 | 间接 | — | 路由注册 |
| `routes/group-chat.js` | 3242 | 假 | inline mirror（2/47 函数） | **< 5%** |
| `routes/session-helpers.js` | 1698 | 是 | 直接 import | **~30%**（部分函数） |
| `routes/session.js` | 1313 | 是 | 直接 import | **~25%** |
| `routes/im.js` | 1099 | 是 | 直接 import + inline mirror | **~40%** |
| `routes/dispatch.js` | 978 | 是 | 直接 import | **~60%** |
| `routes/workspace.js` | 894 | 部分 | 直接 import（仅路由注册） | **~10%** |
| `routes/agent-lifecycle.js` | 832 | **否** | — | **0%** |
| `routes/feature-repository.js` | 631 | **否** | — | **0%** |
| `routes/flow.js` | 589 | 是 | 直接 import | **~40%** |
| `routes/model-config.js` | 553 | **否** | — | **0%** |
| `routes/agent-discovery.js` | 423 | 假 | inline mirror | **0%**（mirror） |
| `routes/workspace-creators.js` | 372 | 是 | 直接 import | **~60%** |
| `routes/project-docset.js` | 344 | **否** | — | **0%** |
| `routes/fs-operations.js` | 218 | **否** | — | **0%** |
| `routes/system-feature-config.js` | 216 | 假 | inline mirror | **0%**（mirror） |
| `routes/assembly-helpers.js` | 195 | **否** | — | **0%** |
| `conversation-renderer.js` | 941 | **否** | — | **0%** |
| `claw-mcp.js` | 368 | 间接 | claw-core.test.js | **~20%** |
| `usage-ledger.js` | 344 | **否** | — | **0%** |
| `runtime-call-envelope.js` | 358 | 是 | 直接 import | **~70%** |
| `model-preset-resolver.js` | 137 | **否** | — | **0%** |
| `shared/string-helpers.js` | ~100 | 是 | 直接 import | **~50%** |
| `shared/session-access.js` | 232 | 是 | 直接 import | **~40%** |
| `shared/agent-access.js` | 78 | 是 | 直接 import | **~60%** |
| `shared/feature-utils.js` | ~80 | 是 | 直接 import | **~80%** |
| `shared/constants.js` | 35 | 间接 | — | 常量 |
| `shared/im-channels.js` | 99 | **否** | — | **0%** |
| `shared/fs-helpers.js` | 17 | **否** | — | **0%** |
| `shared/ipc.js` | 18 | **否** | — | **0%** |
| `shared/proxy.js` | 34 | **否** | — | **0%** |
| `shared/runtime-hooks.js` | 9 | **否** | — | **0%** |
| `context-continuity/handoff-package.js` | 649 | 是 | 直接 import | **~40%** |
| `context-continuity/feature-continuity.js` | 136 | 是 | 直接 import | **~30%**（浅） |
| `context-continuity/summarized-handoff.js` | 300 | **否** | — | **0%** |
| `context-continuity/claude-compact-prompts.js` | 165 | **否** | — | **0%** |

### 4.2 有效覆盖率估算

| 分类 | 模块数 | 有效覆盖 | 零覆盖 | 假覆盖（inline mirror） |
|------|-------|---------|--------|----------------------|
| routes/ | 16 | 5（31%） | 8（50%） | 3（19%） |
| server root | 5 | 1（20%） | 4（80%） | 0 |
| server shared | 10 | 4（40%） | 6（60%） | 0 |
| context-continuity | 4 | 2（50%） | 2（50%） | 0 |
| **合计** | **35** | **12（34%）** | **20（57%）** | **3（9%）** |

> 有效覆盖：直接 import 真实代码且有实质性断言
> 假覆盖：inline mirror，修改源码不会导致测试失败

---

## 五、4 个 skipped 测试

当前有 4 个测试被 `# SKIP`：

| 测试 | 文件 | skip 原因 |
|------|------|----------|
| converts a valid WAV input | speech-model.test.js | 依赖 ffmpeg，环境未安装时跳过 |
| produces non-empty output | speech-model.test.js | 同上 |
| returns null for garbage input | speech-model.test.js | 同上 |
| returns null for empty input | speech-model.test.js | 同上 |

这 4 个 skip 是合理的（依赖外部 ffmpeg），但因为整个 speech-model.test.js 是 inline mirror，即使能跑也只是测了复制品。

---

## 六、优先级排序的行动建议

### P0 — 消除虚假安全（1~2 天）

**目标**：把 11 个 inline mirror 测试中的低难度项改为直接 import。

| 任务 | 难度 | 涉及文件 |
|------|------|---------|
| session-utils → import `session-access.js` + `session-helpers.js` | 低 | test/session-utils.test.js |
| system-feature-config → import `routes/system-feature-config.js` | 低 | test/system-feature-config.test.js |
| branch-checkpoint → import 对应 session 路由模块 | 低 | test/branch-checkpoint.test.js |
| title-mirror-helpers → 完全改用 `mirror-runtime.js` | 低 | test/title-mirror-helpers.test.js |
| session-model-meta → import `session-helpers.js` export | 中 | test/session-model-meta.test.js |
| session-cleanup → 需在 `session-helpers.js` 补 export `selectEmptySessions` | 中 | server/routes/session-helpers.js + test/session-cleanup.test.js |
| speech-model → import `routes/model-config.js` 的 normalize 函数 | 中 | server/routes/model-config.js（补 export）+ test/speech-model.test.js |
| im-config-serializer → import `routes/im.js` 的序列化函数 | 中 | server/routes/im.js（补 export）+ test/im-config-serializer.test.js |

### P1 — 高 ROI 纯函数补测（2~3 天）

**目标**：为零覆盖的高密度纯函数模块补充测试。

| 任务 | 模块 | 可测函数数 | 估时 |
|------|------|----------|------|
| workspace.js normalize 系列 | routes/workspace.js | 7 | 半天 |
| project-docset.js sanitize/clean 系列 | routes/project-docset.js | 5 | 半天 |
| usage-ledger.js 新模块 | server/usage-ledger.js | 8 | 半天 |
| assembly-helpers.js 校验/哈希 | routes/assembly-helpers.js | 4 | 1 小时 |
| model-config.js normalize 系列 | routes/model-config.js | 5 | 半天 |
| feature-repository.js 推断函数 | routes/feature-repository.js | 5（需补 export） | 半天 |

### P2 — 关键路径保护（3~5 天）

| 任务 | 重要性 | 说明 |
|------|--------|------|
| summarized-handoff.js 补测 | 高 | compact resume 核心链路，7 个纯函数可直接测 |
| group-admin feature 补测 | 高 | 500 行活跃维护零测试 |
| conversation-renderer.js 补测 | 高 | escapeHtml 是 XSS 防线，renderConversationHtml 是导出核心 |
| model-preset-resolver.js 补测 | 中 | 决定 agent 用哪个 LLM |
| agent-lifecycle.js 状态机 | 中 | 需要集成测试，难度较高 |

### P3 — 架构级改善（长期）

| 任务 | 说明 |
|------|------|
| CallArbiter extract 到独立文件 | 从 run-prebuilt-agent.js 抽出，独立 import 测试 |
| group-chat.js 拆分 + 函数 export | 3242 行 47 函数，需要逐步 export 纯函数 |
| collectIdentities 从闭包中提取 | agent-discovery.js 返回闭包，需要重构为可独立测试 |
| conversation-renderer 快照测试 | HTML 渲染输出适合 snapshot test |
| 前端 JS 自动化测试框架 | 目前 39 个 modules 零前端测试 |

---

## 七、风险评估总结

### 7.1 最高风险区域（修改时无保护网）

| 区域 | 行数 | 当前保护 | 修改出错的影响 |
|------|------|---------|-------------|
| `routes/group-chat.js` | 3242 | **无** | 群聊消息分发、任务派发全部失效 |
| `routes/agent-lifecycle.js` | 832 | **无** | agent 启停异常、子进程泄漏 |
| `conversation-renderer.js` | 941 | **无** | 导出 HTML 注入、渲染错误 |
| `routes/model-config.js` | 553 | **无** | 模型配置丢失、预设序列化错误 |
| `routes/feature-repository.js` | 631 | **无** | feature 包扫描错误、元数据丢失 |
| `context-continuity/summarized-handoff.js` | 300 | **无** | compact resume 生成错误种子 |
| `local-features/group-admin` | 500 | **无** | 群管理员工具全部失效 |
| `server/usage-ledger.js` | 344 | **无** | 用量统计错误 |

### 7.2 inline mirror 风险（修改后不报错）

| 区域 | mirror 文件 | 与源码同步概率 |
|------|------------|-------------|
| `scripts/run-prebuilt-agent.js` CallArbiter | call-arbiter.test.js | **低**（类逻辑复杂） |
| `routes/group-chat.js` 辅助函数 | group-chat-data-layer.test.js | **低**（3242行只复制了2个函数） |
| `routes/agent-discovery.js` collectIdentities | collect-identities.test.js | **极低**（已迁到新位置） |
| `routes/session-helpers.js` cleanup | session-cleanup.test.js | **中**（逻辑已迁移） |
| `routes/model-config.js` speech | speech-model.test.js | **中** |

### 7.3 安全相关测试缺口

| 安全面 | 相关代码 | 测试状态 |
|--------|---------|---------|
| XSS（HTML 转义） | conversation-renderer.js `escapeHtml` | **无测试** |
| 命令注入 | fs-operations.js `runCommand` | **无测试** |
| 路径穿越 | assembly-helpers.js `resolveFeatureCreatorOutputDir` | **无测试** |
| Feature 名注入 | assembly-helpers.js `isValidFeatureName` | **无测试** |
| Session ID 注入 | project-docset.js `sanitizeProjectDocsetId` | **无测试** |
| 文件路径注入 | project-docset.js `extractMaterialSourcePath` | **无测试** |

---

## 八、结论

当前测试体系从数量上看有 26 个文件、8,361 行、541 个 case 且全绿，表面上健康。但深入审计后发现：

1. **42% 的测试文件是 inline mirror**，与真实代码脱钩，提供的保护是虚假的
2. **57% 的服务端模块零有效覆盖**（20/35），包括多个高风险区域
3. **安全相关纯函数（XSS、命令注入、路径穿越）全部无测试**
4. **最大模块 group-chat.js（3242行）有效覆盖 < 5%**
5. **活跃 feature group-admin（500行）完全零测试**

最紧迫的工作不是写更多新测试，而是先把 inline mirror 测试改为直接 import（P0），然后为高 ROI 纯函数补测（P1）。这两步能在 3~5 天内显著提升测试体系的真实有效性。

---

## 九、解决状态（2026-07-12 更新）

截至 2026-07-12，审计报告中提出的 P0-P2 问题已基本解决：

| 审计问题 | 优先级 | 状态 |
|---------|--------|------|
| 11 个 inline mirror 测试改为直接 import | P0 | ✅ 全部完成 |
| 8 个零覆盖路由模块补测 | P0-P1 | ✅ 全部完成 |
| 安全函数补测（XSS/注入/路径穿越/Session ID） | P1 | ✅ 已覆盖 |
| group-admin feature 零测试 | P1 | ✅ 30 cases |
| CallArbiter 未独立 | P2 | ✅ 已提取为 `server/call-arbiter.js` |
| 高 ROI 纯函数补测 | P1 | ✅ usage-ledger / workspace normalize 等 |

**测试用例总数**：541 → **1,008+**（几近翻倍）

**仍存在的缺口**（已归入 `docs/plans/2026-07-12-quality-improvement-guide.md`）：
- `session-helpers.js` 中 4 个纯函数未 export（extractToolCallLabel、buildSessionTrimPreview、extractDomainsFromText、buildLightPrebuiltSessionRecord）
- 57 个前端模块仅有 1 个测试文件覆盖
- `group-chat.js`（已膨胀至 4,441 行）仍在密集迭代中，暂不拆分
