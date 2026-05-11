---
name: agentdev-agent-creator-workflow
description: Agent Creator 的默认工作流。用于判断当前请求属于装配 chatbot、项目开发、Feature 缺口 handoff 还是调试验证，并决定后续要读哪些 skills。
---

# Agent Creator Workflow

只要任务是在推进 Agent Creator，就先用这个技能做分流，不要直接进入写代码。

## 先判断当前属于哪一类

1. `装配 chatbot`
2. `项目开发`
3. `Feature 缺口 / handoff`
4. `调试与验证`

## 如果是装配 chatbot

优先目标：

- 把自然语言需求收敛成结构化 assembly spec
- 明确 preset、toolkit、selected features、交互边界
- 保持 chatbot 输入输出固定，不要把它扩散成通用 Agent IDE
- 如果用户可以立刻开聊，就优先让他进入可试玩状态

接下来优先读：

- `agentdev-agent-assembly`

如果发现缺关键能力，再调用：

- `agentdev_create_feature_handoff`

## 如果是项目开发

优先目标：

- 整理 Agent 名称、目标能力、运行形态、约束与项目目录
- 明确这是模板初始化和后续开发入口，而不是装配态聊天
- 只做当前项目工作流需要的最小编排，不发明重型流程

接下来优先读：

- `agentdev-agent-project-workflow`

## 如果是 Feature 缺口

不要只口头说“需要先开发一个 Feature”。

你应该：

1. 说明当前装配或项目开发为什么卡住
2. 用 `agentdev_create_feature_handoff` 写标准化记录
3. 把缺口描述成可被 Feature Creator 消费的能力请求

## 如果是调试与验证

重点不是“进入 debug 模式”本身，而是给出：

- 复现路径
- 预期行为
- 实际行为
- 最小验证动作

如果调试的是装配态，要先确认：

- 挂载的 feature 是否真的参与运行
- 用户看到的是不是受控装配效果，而不是 prompt 幻觉

## 输出原则

- 先给正确判断
- 再给最小可落地路径
- 只有在明确进入实现时，才开始写代码
