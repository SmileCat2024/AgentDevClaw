# 022 — agent-studio/src/index.ts 拆分（四刀：assertions / runtime-process / project-store / tools）

- **仓库**：AgentDevClaw（`D:\code\AgentDevClaw`）
- **决策依据**：2026-08-23 前端回涨文件调研 grill 会话（Q1-Q5）；结构与测试引用已核实
- **类型**：TS 源码搬移 + 一处最小重构（getTools 工厂化，Q5 决策 a）
- **前置**：无（与 019-021 零交集，可任意穿插；验证链最长建议排最后）

## 背景

`local-features/agent-studio/src/index.ts` 单文件 2,116 行，承载 5 个职责：

| 区段（快照行号） | 内容 | 行数 |
|---|---|---|
| 12-135 | 类型定义（20+ interface/type） | ~120 |
| 212-494 | 断言引擎纯函数（已导出、被测试直接引用） | ~280 |
| 495-927 | Test Runtime 子进程生命周期 + fingerprint | ~430 |
| 928-1300 | 项目档案 / registry / runs 持久化 + normalize 层 | ~370 |
| 1304-2116 | `AgentStudioFeature` 类，**其中 `getTools()` 单方法 ~640 行**（14 个 studio_* 工具 schema+execute 全在一个方法内） | ~810 |

`getTools()` 是迭代瓶颈：每新增一个工具都在同一方法内堆积。类方法与工具定义的
耦合极浅（execute 内仅 `this.resolveProjectDirectory()` 等实例调用），工厂化重构
机械且可 grep 验证，故一刀到位（Q5 决策）。

测试从 `../src/index.js` import 以下符号，拆分后 index.ts 必须 re-export 全部：
`AgentStudioFeature` / `evaluateAssertions` / `computeFeatureCoverage` /
`advanceFeatureStatuses` / `normalizeAssertion` / `normalizeTestCase` +
类型 `StudioToolCallEvidence` / `StudioHookEvidence` / `StudioFeatureEntry` / `StudioRunRecord`。

## 执行步骤

1. `src/assertions.ts`（~430 行含类型）：
   - 类型：`ASSERTION_KINDS` / `AssertionKind` / `StudioAssertion` / `StudioTestCase` /
     `StudioFeatureVerification` / `StudioToolCallEvidence` / `StudioHookEvidence` /
     `StudioFeatureCoverage` / `AssertionEvaluation` / `StudioRunRecord` / `SessionPolicy`
   - 函数：`getPathValue` / `deepEqual` / `parseEvidenceResult` / `descaleComparable` /
     `evaluateAssertions` / `evaluateAssertion` / `computeFeatureCoverage` / `isCovered` /
     `advanceFeatureStatuses` / `normalizeAssertion` / `normalizeTestCase` /
     `normalizeSessionPolicy`
2. `src/runtime-process.ts`（~450 行）：
   - 常量：`READY_TIMEOUT_MS` / `SYNC_TIMEOUT_MS` / `RUN_TEST_TIMEOUT_MS` /
     `INSPECT_TIMEOUT_MS` / `SHUTDOWN_TIMEOUT_MS`
   - 类型与状态：`StudioReadyPayload` / `RuntimePendingRequest` / `RuntimeHandle` /
     `runtimeHandles`
   - 函数：`findProjectScript` / `findRuntimeScriptPath` / `findAgentRegistryModuleUrl` /
     `findCreateFeatureCliPath` / `findPrepareRuntimeScriptPath` /
     `normalizeStandaloneAgentMetadata` / `getRuntimePlanPath` / `getRuntimeOverridesPath` /
     `getRuntimeHandle` / `failPendingRequests` / `fingerprintModule` /
     `fingerprintAgentDefinition` / `fingerprintFeatureSource` / `runProjectCommand` /
     `runFeatureBuild` / `runSnapshotScript` / `prepareAgentDebugPlan` / `runtimeRequest` /
     `startRuntimeProcess` / `stopRuntimeProcess` / `syncFeaturesToRuntime` /
     `markRuntimeStopped`
3. `src/project-store.ts`（~400 行）：
   - 常量：`PROJECT_FILE_NAME` / `REGISTRY_FILE_NAME` / `RUNS_DIR_NAME` /
     `RUNS_FILE_NAME` / `RUNS_KEEP_COUNT` / `RUNS_RESULT_TRUNCATE`
   - 类型：`StudioFeatureSource` / `StudioFeatureSnapshot` / `StudioFeatureEntry` /
     `StudioAgentDefinition` / `AgentStudioProject` / `WorkspaceState` / `StudioProjectEntry`
   - 函数：`cleanValue` / `normalizeFeatureStatus` / `normalizeVerification` /
     `normalizeFeatureEntry` / `normalizeTestRuntimeStatus` / `getDefaultStatePath` /
     `getProjectPath` / `getRunsPath` / `readRuns` / `truncateRunEvidence` / `appendRun` /
     `describeCoverage` / `buildProjectMarkdown` / `readFeatureProjectEntry`
   - 边界存疑的符号（如 `readFeatureProjectEntry` 语义偏 store 但被 runtime 链调用）：
     按实际依赖方向归置，跨文件 import 即可，不复制定义。
4. `src/tools.ts`：
   - `assertionParameterSchema` + 新增 `buildStudioTools(feature: AgentStudioFeature): Tool[]`
     工厂，迁入 14 个 `createTool` 定义；execute 内 `this.xxx` 全部改为
     `feature.xxx`（机械替换，grep 逐个核对）
   - index.ts `getTools()` 改为 `return buildStudioTools(this)`
5. `src/index.ts` 保留：`AgentStudioFeature` 类壳（构造 / 生命周期 / registry 编排 /
   getHookDescription）+ 全量 re-export（清单见背景节）。
6. 全程不改任何工具名、参数 schema、状态机、会话策略——
   **agent-studio-workflow SKILL 与 system.md 明确不同步**（仅行为变更才触发同步，
   本次为结构搬移）。

## 验收标准

- 构建：`npm run build:local-features` 零错误。
- 测试：`npm run test:features` 全绿（studio-feature.test.ts 经 index re-export
  消费，测试文件零改动）。
- 静态验证（grep 清单）：
  - 每个被迁符号在新文件有且仅有一处定义；index.ts 仅剩 re-export 与类壳
  - `tools.ts` 中 `this.` 零残留（全部替换为 `feature.`）
- 运行验证：重启 agent-studio runtime，dev agent 的 14 个 `studio_*` 工具在
  inspector 全部可见；任选 `studio_get_project` 与一次带断言的测试运行走通
  （断言判定路径覆盖 assertions.ts）。
- 行数：index.ts ≤ 700；四文件合计与原 2,116 行偏差 < 5%（允许 import/export 开销）。

## 风险提示

- 区段行号为调研快照，以 grep 符号边界为准。
- `runtimeHandles` 为模块级可变 Map（进程内单例语义），迁入 runtime-process.ts 后
  确认 index.ts 与 tools.ts 均通过该模块的函数访问，不得出现第二份引用副本。
- `getTools()` 工厂化是本批四票中唯一非纯搬移点：替换 `this` → `feature` 时逐个
  核对方法可见性（private 方法需改为 internal 或经接口暴露，以最小改动为准）。
- 验证需 `npm run build:local-features` + 重启 agent-studio runtime（子进程动态
  import dist，无需整服重启）。
