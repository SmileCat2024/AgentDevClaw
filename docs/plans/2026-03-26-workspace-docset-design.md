# Workspace Docset Design

## Goal

为 `feature-creator` 和后续 `agent-creator` 定义一套稳定但轻量的项目文档集结构，支撑：

- 项目级唯一需求表单
- 多份 Markdown 资料文档
- 项目级推进记录
- 为后续人工新建对话提供稳定可复用的过程文档

## Chosen Structure

每个项目目录下维护：

```text
.agentdev/claw-workspace/
  project.json
  forms/
    startup-form.json
  materials/
    material-*.md
  conversations/
    session-*.json
```

说明：

- `project.json` 是项目级壳，保存工作空间、项目类型、目录、目标、约束等稳定元信息
- `forms/startup-form.json` 保存唯一用户需求表单
- `materials/*.md` 保存跨对话稳定可复用的资料，如 AI 方案书、外部文档摘要、参考说明和路径引用
- `conversations/*.json` 保存按对话分桶的推进记录，用于后续对话交接

## Usage Model

项目文档集不是子代理调度器，也不自动派生新对话：

1. 当前项目中持续维护需求、推进记录和资料
2. 文档集持续保留在项目目录中
3. 后续如需新开对话，由人手动创建
4. 新对话再按需参考这些文档

这样可以让 `feature-creator` 的提示词和状态机保持单纯，职责集中在“主动整理与维护文档”。

## Why This Shape

- 比统一大 schema 更轻，文件格式朴素
- 比纯 artifact 平铺更适合项目推进
- 需求、推进记录、资料三层分工明确，后续也能扩展 `decision`、`verification`
- `agent-creator` 可以直接复用同一目录约定

## Deferred

这轮不做：

- 全自动从每轮对话抽取文档
- 复杂状态机
- 真正的子代理编排
- 项目管理式任务编辑器

先保证“结构稳定、可预览、可维护、可人工复用”。
