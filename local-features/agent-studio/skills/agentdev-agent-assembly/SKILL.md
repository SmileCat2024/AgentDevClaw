---
name: agentdev-agent-assembly
description: 用于把需求收敛成 standalone 或 workspace Agent 的装配声明、Feature 依赖和运行边界。
---

# Agent Assembly

这个技能服务于 Agent 项目装配，不限于 chatbot。当前已落地的部署类型是 `standalone`（独立调用）；`workspace` 保留在协议中，但自定义工作空间运行宿主尚未接入。

## 先判断 Agent 形态

| 形态 | metadata / 装配方式 | Studio 支持 |
|---|---|---|
| standalone | `deployment.kind: "standalone"`，`features` 为 `{ package, version, export?, config? }` 对象数组 | 可登记并用 `agent-debug` 验证 |
| built-in / prebuilt 静态装配 | `agent.js` 自己 import + `use()` Feature；metadata 可能是字符串 feature 列表或 UI 声明 | 不能登记为 standalone，改用 `feature-harness` 验证开发中的 Feature |
| workspace | metadata 允许 `deployment.kind: "workspace"`，但自定义 workspace 宿主未接入 | 不能进入 standalone `agent-debug` |

不要从内建 Agent 的 `agent.js` 或 metadata 推导 standalone 模板。`studio_register_agent` 会在登记阶段拒绝不是 standalone metadata 驱动装配的项目；这是为了在启动隔离 runtime 前暴露不兼容性。

## 基本原则

- Agent 项目声明部署目标：`standalone` 或 `workspace`；两者未来共用 Agent 源码和 Feature 装配声明。
- Feature 使用稳定 npm 包名、精确版本、可选 export 和 JSON config 声明；不要把开发机绝对路径写入 Agent metadata。
- metadata `features[].version` 必须对应本地 Feature 仓库中已存在的 tgz 快照：先 `studio_create_snapshot` 拿到版本，再把它写进 metadata 定稿。无版本的声明只能在 agent-debug（`--debug`）下运行；`claw agents register` 与 release 消费都强制精确版本。
- Studio 开发态的源码覆盖只留在 `agent-studio.json`，正式消费由本地 Feature 仓库中的 tgz 快照解析。
- 独立 Agent 使用 `claw agents register <agent-project-dir> [--studio <studio-project-dir>]` 注册；默认 `claw run <id>` 只解析 release tgz，`claw run <id> --debug` 才允许关联 Studio 项目的源码覆盖。
- Feature 是装配单元；对话形式、UI 和调用入口是运行宿主责任。

## standalone Agent 入口（agent.js）怎么写

metadata 声明装配，入口只承担"壳"：构造参数透传、系统提示词、装配外的少量框架内置能力。以最小模板为基准：

```js
import { BasicAgent, TemplateComposer } from 'agentdev';

export default class TicketAgent extends BasicAgent {
  constructor(options) {
    super(options); // 运行宿主传入 { name, projectRoot, workspaceDir, llm, features, runtime }
  }

  async onInitiate(ctx) {
    await super.onInitiate(ctx);
    this.setSystemPrompt(new TemplateComposer().add({ file: PROMPT_PATH }));
  }
}
```

硬性规则（违反即运行时失败）：

- **不要在 constructor 里 `use()` metadata.features 声明的任何 Feature。** 消费端装载器按 metadata 动态挂载，遇到 Agent 已静态挂载的同名 Feature 会直接报错终止。入口只允许 `use()` 未声明进 metadata 的框架内置能力（如 `LspFeature`）。
- **不要自行 createLLM。** 模型由运行宿主从 `metadata.modelPresets` 解析后经构造参数 `llm` 注入；本机可用 `.agentdev/agent-configs/<agentId>.json` 覆盖（不入库）。
- Feature 的 config 写在 `metadata.features[].config`，由宿主注入，入口不处理。
- 顶层 `import { BasicAgent } from 'agentdev'` 是合法且预期的：消费端会把 Agent 源码复制进隔离运行环境（agent-source/），依赖在该环境内解析，Agent 项目本身不需要 node_modules。
- 导出形式用 `export default class`（宿主按 default 导出或唯一函数导出解析 Agent 类）。

参照警告：prebuilt agent（`prebuilt-agents/*/*/agent.js`）是静态装配形态——自己 import 并 use() 全部 Feature、metadata 不含 features 字段，**不能**作为 standalone 模板照抄。

## standalone metadata 模板

```json
{
  "id": "ticket-agent",
  "entry": "agent.js",
  "deployment": { "kind": "standalone" },
  "modelPresets": { "default": "<模型 preset 名>" },
  "features": [
    { "package": "<npm 包名>", "version": "0.1.0", "export": "可选，多 class 导出时必填", "config": {} }
  ]
}
```

校验规则（注册与消费前强制）：`entry` 必须是相对 Agent 项目根的路径；`features[].package` 是精确 npm 包名且不可重复声明；`features[].version` 是精确 semver；`modelPresets.default` 必须可解析，否则启动即失败。

## 验证与注册顺序

1. `studio_register_agent` 只登记符合上表 standalone 形态的项目；它会校验相对 entry、精确 Feature version、对象形态的 `features` 与 entry 存在性。
2. `studio_start_runtime { mode: \"agent-debug\" }` 验证 standalone metadata → resolver → repository tgz + Studio 标准 Feature 源码覆盖 → Agent 构造与挂载。它**不**验证 built-in/prebuilt 宿主、HTTP、前端或 session IPC。
3. 仅 Feature 实现代码变更可使用 `studio_run_test` 热载。只要改动 package 名、`package.json.main`、export、`static inject` 依赖、metadata Feature 声明或 Agent 源码/metadata，必须先 `studio_stop_runtime`，再 `studio_start_runtime { mode: "agent-debug" }`，以重算 runtime plan；不要把这类装配变化当作普通热载。
4. `claw agents register <agent-project-dir> --studio <studio-project-dir>` 注册。
5. `claw run <id> --debug` 走源码覆盖；验证通过后 `claw run <id>` 走 release tgz。

## 你需要先做的事

1. 判断 Agent 是独立调用还是自定义工作空间。
2. 给出推荐 Feature 组合、精确版本和配置边界。
3. 说明为什么这样装，而不是泛泛列能力。
4. 将装配声明写入 Agent metadata；当前 Studio 不提供 `agentdev_write_assembly_spec`，不得假设该工具存在。

## 推荐的 preset 方向

- `general-chatbot`：通用助手，强调对话质量和基础能力
- `tool-operator`：工具执行型，强调 shell / websearch / audit / memory 等能力组合
- `workflow-assistant`：强调任务推进、控制、可回滚和过程组织

## assembly spec 最少要包含

- assembly name
- preset
- target user
- goal
- toolkits
- selected features
- interaction contract
- constraints
- project upgrade path

## interaction contract 要说清楚什么

- 这是 chatbot，不是任意形态的 agent runtime
- 用户怎么跟它对话
- 哪些能力会暴露给用户
- 哪些能力只是内部装配，不直接让用户感知

## 何时要升级到项目态

出现以下情况之一时，就不应该只停留在装配聊天：

- 需要初始化项目目录
- 需要改 prompts / skills / 模板
- 需要新增 Feature 或接入复杂 runtime
- 需要做更强的调试与长期维护

这时应明确告诉用户：当前结果可以作为项目开发的起点，而不是直接硬写代码。
