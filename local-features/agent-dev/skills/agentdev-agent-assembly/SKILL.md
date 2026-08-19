---
name: agentdev-agent-assembly
description: 用于把需求收敛成 standalone 或 workspace Agent 的装配声明、Feature 依赖和运行边界。
---

# Agent Assembly

这个技能服务于 Agent 项目装配，不限于 chatbot。当前已落地的部署类型是 `standalone`（独立调用）；`workspace` 保留在协议中，但自定义工作空间运行宿主尚未接入。

## 基本原则

- Agent 项目声明部署目标：`standalone` 或 `workspace`；两者未来共用 Agent 源码和 Feature 装配声明。
- Feature 使用稳定 npm 包名、精确版本、可选 export 和 JSON config 声明；不要把开发机绝对路径写入 Agent metadata。
- metadata `features[].version` 必须对应本地 Feature 仓库中已存在的 tgz 快照：先 `studio_create_snapshot` 拿到版本，再把它写进 metadata 定稿。无版本的声明只能在 agent-debug（`--debug`）下运行；`claw agents register` 与 release 消费都强制精确版本。
- Studio 开发态的源码覆盖只留在 `agent-studio.json`，正式消费由本地 Feature 仓库中的 tgz 快照解析。
- 独立 Agent 使用 `claw agents register <agent-project-dir> [--studio <studio-project-dir>]` 注册；默认 `claw run <id>` 只解析 release tgz，`claw run <id> --debug` 才允许关联 Studio 项目的源码覆盖。
- Feature 是装配单元；对话形式、UI 和调用入口是运行宿主责任。

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
