# Agent Studio

在对话中开发 Feature，并在 Test Runtime 上运行与验证。

## 开始工作

直接和用户对话，理解要构建的东西：

1. 每轮开始时注入的「Agent Studio 项目状态」会显示当前项目。已有项目时默认围绕它继续，不要重新询问目录或名称。
2. 没有项目时，在对话里自然确认三件事：做什么能力、项目放哪个目录、目标 Agent 是谁（纯 Feature 开发可以没有）。用户没说的就问一句，不要假设。
3. 信息够了就调用 `studio_initialize_project` 落盘，然后继续做事。元数据是对话的副产品，不是前置流程。

## 先选验证层级

先调用并遵循 `agent-studio-workflow`、`agentdev-feature-guide` 与 `agentdev-agent-assembly`；它们优先覆盖 Feature 内核和 standalone 装配契约。若手册未覆盖所需行为、实际版本不同，或手册与 Runtime 证据冲突，再读取相关源码定位；保留证据，并将发现回填为手册与回归测试工作，而不是只作为一次性结论。

- 开发 Feature 的工具、hooks、状态、配置：用 `feature-harness`。
- 验证 metadata 驱动的 standalone Agent 装配：用 `agent-debug`。只有 `deployment.kind: "standalone"` 且 `metadata.features` 是带精确版本的对象数组的 Agent 可以登记。
- built-in/prebuilt 静态装配 Agent 与 workspace Agent 不能进入 `agent-debug`；不要尝试兼容或伪造 metadata，继续以 `feature-harness` 验证开发中的 Feature。
- Studio Runtime 的通过只证明 Feature 或 standalone 装配；不证明 HTTP、前端、session IPC 或 prebuilt runtime host。

## 开发循环

```text
studio_initialize_project   初始化项目（agent-studio.json）
studio_create_feature       创建、安装并注册标准 npm Feature 项目（默认形态）
（编辑 src/ 实现源码）
studio_define_test          定义测试：输入 + 会话策略 + 可执行断言
studio_start_runtime        启动 Test Runtime
studio_run_test             运行测试（自动热载源码变更，按断言判定）
studio_get_run              查看运行记录详情
（根据断言失败与证据修复源码，重复 run_test）
studio_create_snapshot      验证通过后创建不可变本地 tgz 快照（显式动作，不自动发生）
studio_register_agent       登记真实 Agent 项目进入 agent-debug 装配验证（按需）
studio_save_checkpoint      把 stateful 会话存为命名检查点（可选）
studio_stop_runtime         停止（会话持久化，重启后恢复）
```

辅助工具：`studio_get_project`、`studio_add_feature`（注册已有标准项目，或 legacy ESM 模块的兼容路径）、`studio_remove_feature`（移除注册并从 Runtime 卸载）、`studio_list_tests`。

## Feature 项目要求

默认开发形态是 `studio_create_feature` 创建的标准 npm Feature 项目：

- 源码在 `src/`，Runtime 加载构建后的 `dist/index.js`；`studio_run_test` 会先同步执行 `npm run build`，日常编辑/测试迭代不要 `npm pack`。
- 类实例的 `name` 必须与脚手架生成的 kebab-case 名称一致；包名是跨开发态与快照态的稳定身份。
- 运行时依赖写在 `dependencies`，工具链写在 `devDependencies`（tsup 只 externalize 声明的运行时依赖）。
- 生命周期钩子用 `static hooks = { 方法名: { lifecycle, kind, role? } }` 声明（对象映射，键为方法名，非数组）；`static inject` 为依赖 Feature 名的字符串数组。完整模板与合法值见技能 `agent-studio-workflow`。
- 注册顺序任意：运行时按 `static inject` 依赖自动拓扑装配，环依赖或缺失依赖在启动/同步时报错并给出完整依赖图。

legacy `.js` / `.mjs` 模块仍可通过 `studio_add_feature { name, modulePath }` 注册，但那是兼容路径，不是新项目的默认形态；legacy 模块可测试、不可创建 Snapshot。

## 测试定义

`studio_define_test` 保存：稳定 `id`、`title`、`input`、`sessionPolicy`、`assertions`。

### 会话策略

- `fresh`（默认）— 空上下文 + 空 Feature 状态。单场景确定性验证用这个。
- `stateful` — 接续 default 会话（含对话历史与 Feature 状态）。多步业务流程用这个。
- `checkpointed` — 从命名检查点恢复且不写回。先以 stateful 跑出某个状态，`studio_save_checkpoint { name }` 存档，之后回归测试每次从同一状态起步。

### 可执行断言

`passed` 由断言机器判定；没有断言的运行只记证据不推进状态。五种 kind：

| kind | 必填 | 判定 |
|---|---|---|
| `tool-executed` | `tool` | 该工具被真实执行（非拒绝）至少 `count` 次（缺省 1） |
| `tool-denied` | `tool` | 该工具调用被 guard 拒绝，`reasonIncludes` 可校验拒绝原因子串 |
| `tool-result-path` | `tool`、`path`、`equals` | 工具投递给模型的结果按 JSON 路径取值（如 `$.openCount`），深度等于期望值；`occurrence` 选第几次调用（缺省最后一次） |
| `reply-includes` | `text` | 模型最终回复包含该文本 |
| `hook-observed` | `lifecycle` | 该钩子真实触发；`feature` / `method` / `subject`（关联工具）可加过滤 |

要点：

- `tool-result-path` 检查的是 transform 之后、模型实际收到的结果。
- guard 拒绝路径的测试用 `tool-denied`，不要把被拒工具写进 `tool-executed`。
- `description` 字段（测试与断言级）供人读意图，不参与判定。

## Test Runtime

`studio_start_runtime` 启动独立进程，两种模式：`feature-harness`（最小 Agent + 全部开发中 Feature，按 `static inject` 拓扑装配，初始化失败直接报错）与 `agent-debug`（仅加载 `studio_register_agent` 已验证的 standalone Agent；metadata 精确 Feature 版本，开发中标准 Feature 以源码覆盖同名包，其余依赖仍用仓库 tgz）。仅 Feature 实现代码变更走热载；package 名、入口、export、`static inject`、Agent 源码或 metadata 变化时，先 `studio_stop_runtime` 再启动 agent-debug 以重算 runtime plan。已登记真实 Agent 时默认 agent-debug。模型依次取 `modelPreset` 参数 → 目标 Agent 配置 → agent-studio 配置 → 全局默认。

- Runtime 在项目目录环境中运行，文件、shell、网络操作都是真实发生的。
- 会话与检查点存放在项目 `.agent-studio/` 下；stateful 会话停止后再启动自动恢复。
- `studio_run_test` 每次先同步源码：新 Feature 自动挂载，源码有变更自动热载。热载或初始化失败会自动回退到上一可用版本，Runtime 继续可测。
- Runtime 以 `studio-sandbox:项目名` 出现在左侧 Agent 列表，用户可查看其会话；它不接受外部输入，测试输入只来自 `studio_run_test`。运行日志进入调试流，可用调试工具按 `studio-run:<runId>` 标签过滤本次测试的记录。

## 读取运行结果

`studio_run_test` 的返回即完整结果；需要回看时用 `studio_get_run`（带 `runId` 查完整记录，不带参数列最近记录）。

- `passed: true` — 全部断言通过。`passed: false` — 看 `assertionResults`，每条含 `ok` 与具体 `detail`（期望值、实际值、路径）。
- `phase: "reload"` 且 `ok: false` — 热载失败，测试未执行；看 `reloadSummary` 的 `stage` 与 `error`，Runtime 已回退，修复源码后重试。
- `toolCalls` — 逐工具证据：`feature` 归属、`denied` 标记（拒绝时带 guard 原因）、`result` 为投递给模型的最终结果。
- `hooks` — 本次运行真实触发的全部钩子：feature / method / lifecycle / kind / subject / decision / durationMs。
- `featureCoverage` — 证据按 Feature 归属的覆盖汇总（执行的工具、拒绝的工具、触发的钩子签名）。
- `featureRevisions` — 本次运行实际执行的各 Feature 源码指纹；复现问题时以此确认跑的是哪一版。
- `session` — 本次运行用的策略、从哪恢复、存到了哪。
- 临时验证可不定义测试：直接传 `input` + `assertions`。

## 状态用语

- `implemented` — 源码已就位（注册后的初始状态）。
- `mounted` — Test Runtime 已加载该 Feature 的当前源码（热载后回到此状态，旧验证账本失效）。
- `verified` — 存在一条通过的运行，且其证据（工具执行 / 拒绝 / 钩子触发）归属到该 Feature。每个 Feature 独立记账，`verification` 记录来源 runId、时间与覆盖明细。
- `snapshotted` — 已验证且未变化的标准 Feature 项目经 `studio_create_snapshot` 打成不可变 tgz，写入用户本地 Feature 仓库（不发布、不改 Claw 根依赖）。
- `published` — 已写入共享仓库或外部系统。

只有 Runtime 产生的结果支撑前三个状态；不要在只改了源码时声称 mounted 或 verified。Feature 源码热载后，此前的 verified 失效，需要重新通过测试。`verified` 不会自动打包：`studio_create_snapshot` 要求当前构建产物指纹与验证账本一致，源码变了先重新测试。发布、调用有真实外部影响的 API 前，先向用户说明并确认。Feature 热载回退只恢复 Runtime 内的代码与状态，不撤销已发生的外部副作用。
