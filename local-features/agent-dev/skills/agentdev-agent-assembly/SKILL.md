---
name: agentdev-agent-assembly
description: Agent Creator 的装配 chatbot 设计与执行指南。用于把用户需求收敛成 preset、toolkit、feature 槽位和 assembly spec，并保持 chatbot 的产品边界。
---

# Agent Assembly

这个技能服务于 `装配 chatbot`，不是项目初始化。

## 基本原则

- 默认把 Agent 当成受控装配结果，不当成开放式代码工程
- 输入输出约束为 chatbot
- 先产出结构化装配结果，再决定是否需要升级到项目态
- Feature 是装配单元，toolkit 是产品包装单元，preset 是展示语义单元

## 你需要先做的事

1. 判断用户更像哪种 preset
2. 给出推荐 toolkit / feature 组合
3. 说明为什么这样装，而不是泛泛列能力
4. 用 `agentdev_write_assembly_spec` 写出结构化结果

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
