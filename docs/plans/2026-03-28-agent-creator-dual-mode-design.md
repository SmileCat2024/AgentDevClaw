# Agent Creator Dual-Mode Design

## Goal

把 `agent-creator` 从“创建 Agent 项目的入口”重构成双形态工作空间：

1. `装配 chatbot`
2. `项目开发`

前者是默认主入口，强调自然语言参与的受控装配、立刻开聊、试玩、保存和复用。后者是升级路径，强调初始化项目目录并进入后续开发与调试。

## Product Semantics

### 装配 chatbot

- 用户首先感受到的是“装一个 Agent”，不是“写一套 Agent 代码”
- 输入输出边界固定为 chatbot
- Agent Creator 通过自然语言和结构化表单共同收敛出 assembly spec
- 如果发现缺少关键能力，应写 `Feature handoff`

### 项目开发

- 这是从装配态升级到工程态的入口
- 用户填写项目级需求后，初始化 Agent 项目目录
- 后续继续用现有 AgentDev / Claw 机制推进开发
- 复杂、框架无关的 workflow orchestration 暂不在这一层实现

## Workspace State

### `assembly-form`

用于装配 chatbot 的草稿：

- `assembly_name`
- `preset`
- `target_user`
- `goal`
- `recommended_toolkits`
- `selected_features`
- `constraints`

### `startup-form`

用于项目开发的草稿：

- `agent_name`
- `install_mode`
- `target_dir`
- `goal`
- `target_user`
- `runtime_style`
- `planned_features`
- `constraints`

## Runtime / Session Contract

- prebuilt session 增加 `formId`
- `assembly-form` 创建的会话视为装配会话
- `startup-form` 创建的会话视为项目开发会话
- `agent-creator` 首页按两类会话分别展示

## Feature Responsibilities

`agent-dev` 负责：

- 注入装配态与项目态工作空间草稿
- 提供 `plan / code / debug` 模式约束
- 提供 `agentdev_write_assembly_spec`
- 提供 `agentdev_create_feature_handoff`
- 提供工作空间产物写入与读取

## UI Contract

`agent-creator` 顶部切换为两个 tab：

- `装配 Chatbot`
- `项目开发`

每个 tab 有自己的启动入口、会话列表和过程产物视图。

## Skill Strategy

`agent-dev` 自带三类 skills：

- `agentdev-agent-creator-workflow`
- `agentdev-agent-assembly`
- `agentdev-agent-project-workflow`

它们与项目级 `.agentdev/skills` 共同被 SkillFeature 汇总。

## Current Non-Goals

- 不在当前阶段实现复杂项目 workflow 编排
- 不在当前阶段实现装配态的完整 runtime 生成器
- 不在当前阶段做通用多形态 Agent runtime，自觉约束在 chatbot 边界
