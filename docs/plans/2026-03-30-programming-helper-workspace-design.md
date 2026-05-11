# Programming Helper Workspace Design

## Goal

把 `programming-helper` 从“简单的新对话入口”升级成一个更像解决方案的编程工作空间。

这个工作空间不再只表达“和一个会写代码的 Agent 聊天”，而是表达：

- 用户带着一个明确的编程任务进入
- 工作空间帮助用户选择任务入口和推进方式
- 对话、项目上下文、过程记录和最近工作可以持续沉淀
- 当需求升级时，可以自然衔接到 `Agent Creator` / `Feature Creator`

它的定位不是替代 IDE，也不是替代完全自由的项目开发平台，而是成为“高频编程任务解决方案工作台”。

## Product Positioning

`programming-helper` 应该被定义为：

一个面向日常高频研发任务的 AI 编程解决方案工作空间。

它服务的不是“我要从零做一个 Agent”，而是以下更容易理解、也更适合比赛展示的任务簇：

- 阅读和理解现有代码
- 修改、修复和重构项目
- 规划并实现一个小功能
- 排查问题并验证修复
- 维护当前任务的约束、路径和阶段结论

因此它的第一层叙事应该是“直接帮我推进一个编程任务”，第二层才是“必要时升级为更正式的 Agent / Feature 项目化开发”。

## Design Principles

### 1. 先做工作台，再做聊天入口

首页应该先帮助用户建立任务，而不是直接把用户丢进空白对话。

### 2. 复用已有成熟模式

优先复用现有的：

- `launcher-grid`
- `session-list`
- `workspace-artifacts`
- `project-docset`
- `form`

避免重新发明一套只服务 `programming-helper` 的特殊 UI。

### 3. 强化“当前任务”而不是“所有项目管理”

编程小助手应该维护当前任务上下文，但不演化成复杂项目管理系统。

### 4. 让升级路径自然存在

当用户发现当前需求已经超出“编程任务协作”范围时，工作空间应该明确提示：

- 需要装配一个专用 Agent 时，转去 `Agent Creator`
- 需要补一个能力缺口时，转去 `Feature Creator`

## Recommended Information Architecture

推荐把 `programming-helper` 改成三标签工作空间：

1. `工作台`
2. `最近任务`
3. `项目上下文`

对应含义如下。

### 工作台

默认首页，承接“开始一个编程任务”的主流程。

这里应该包含：

- 一个 `hero`，说明这是面向编码、调试、改造和排障的编程工作台
- 一个 `launcher-grid`，按高频任务给出 4 到 5 个清晰入口
- 一个 `startup-form`，用于正式记录当前任务

### 最近任务

用于查看并继续已有会话，不只是“继续聊天”，而是“继续某个任务”。

这里应该包含：

- `session-list`
- 一个轻量的任务摘要说明
- 如果后端可支持，优先按工作目录和最近更新时间组织

### 项目上下文

用于展示当前任务已经沉淀下来的共享信息。

这里应该包含：

- `workspace-artifacts`
- `project-docset`

如果当前任务没有初始化项目级文档集，则仍允许只展示空态和引导文案，而不是阻塞使用。

## Main Entry Model

推荐首页用 `launcher-grid` 替代现在的 `action-group`，把“新对话”改造成“按任务类型开始”。

建议设置 4 个主入口：

### 1. 理解代码

适合：

- 阅读陌生仓库
- 解释模块职责
- 梳理调用链
- 先分析再决定动不动代码

### 2. 实现 / 改造功能

适合：

- 做一个小功能
- 修改已有行为
- 补齐交互或接口

这是默认推荐入口。

### 3. 修 Bug / 排障

适合：

- 复现问题
- 定位报错
- 对比预期与实际行为
- 形成验证结论

### 4. 重构 / 优化

适合：

- 清理结构
- 提升可维护性
- 降低耦合
- 改善性能或可读性

每个入口点击后都进入同一个 `startup-form`，但会预填一个 `task_type`，从而影响：

- 表单默认文案
- 首轮系统注入上下文
- 空态引导
- 后续 artifact 标签

## Startup Form Design

当前 `programming-helper` 的表单字段过少，只能记录“任务目标、工作目录、限制条件”。这不足以支撑工作空间语义。

建议升级为以下字段：

- `task_type`
- `task_title`
- `goal`
- `workdir`
- `target_files`
- `expected_output`
- `constraints`
- `reference_materials`

字段说明如下。

### `task_type`

单选字段，取值：

- `understand`
- `build`
- `debug`
- `refactor`

### `task_title`

一句话标题，用来替代会话列表里含糊的“新对话”。

例如：

- 梳理支付模块调用链
- 修复登录页按钮失效
- 为工作空间增加项目文档集入口

### `goal`

核心任务描述，保留长文本。

### `workdir`

继续保留，且应作为最关键的结构化字段之一。

### `target_files`

可选，多行文本，用于记录用户已知的重点文件、目录或模块。

### `expected_output`

记录用户想得到的结果，例如：

- 只要设计方案
- 直接改代码并验证
- 先分析再决定
- 输出修复建议和测试点

这能明显改善首轮协作的准确度。

### `constraints`

继续保留。

### `reference_materials`

用于记录 issue 链接、文档路径、截图路径或补充上下文。

## Recommended Home Layout

`工作台` 页建议按以下顺序展示：

1. `hero`
2. `launcher-grid`
3. `startup-form`
4. `workspace-artifacts` 的轻量摘要块

其中第 4 项不要求必须新增新 block，可以先在后端复用现有 `workspace-artifacts` 数据，并在首页只显示最近 3 到 5 条记录。

这样首页会形成一个很明确的结构：

- 上方告诉用户这里能解决什么
- 中间告诉用户从哪种任务开始
- 下方让用户立刻填写并进入
- 再往下展示最近沉淀，形成“这个空间真的在持续推进工作”的感受

## Conversation And Context Model

`programming-helper` 不应该继续只维护“会话列表”，而应该维护“任务会话”。

建议语义调整为：

- 一个 session 对应一轮主要编程任务
- session 标题优先来自 `task_title`
- session 预览优先来自 `goal`
- `workdir` 成为 session 的关键元信息

首轮进入对话时，Agent 应自动消费表单内容，并以“当前正在推进一个编程任务”的方式启动，而不是泛泛地说“你是一个专业的编程助手”。

系统提示词层面建议增加以下语义：

- 当前任务类型
- 当前工作目录
- 目标结果
- 限制条件
- 是否应先分析还是直接实现

## Artifact Strategy

推荐 `programming-helper` 复用 `workspace-artifacts`，但 artifact 种类要更偏向编程任务：

- `draft`
- `plan`
- `progress`
- `verification`
- `decision`
- `debug-report`

不建议一开始引入太重的项目管理概念。

推荐写入时机如下：

- 任务范围收敛后：写 `plan`
- 中途形成阶段结论时：写 `progress`
- 完成验证或说明未验证原因时：写 `verification`
- 遇到关键取舍时：写 `decision`
- 排障流程中形成复现与定位结论时：写 `debug-report`

这样能让“项目上下文”页真正成为编程过程沉淀区，而不是空壳。

## Project Docset Strategy

推荐为 `programming-helper` 增加与 `feature-creator` / `agent-creator` 同构的 `project-docset`，但语义更轻。

建议复用同一目录约定：

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

但在使用上做轻约束：

- 没有项目目录时可以不强制初始化
- 一旦用户提供了明确 `workdir`，就优先在该目录维护文档集
- 文档集重点保留“需求、过程、资料”，不额外派生复杂 task schema

对 `programming-helper` 来说，`project-docset` 的价值主要是：

- 让多轮编程协作共享同一份任务背景
- 让后续新对话能直接复用需求和资料
- 让比赛展示时能看到真实的工作沉淀

## UX Flow

推荐主流程如下：

1. 用户进入 `工作台`
2. 选择一个任务入口
3. 填写启动表单
4. 创建任务会话并进入聊天
5. 在聊天页通过 header 打开 `project-docset`
6. 在 `项目上下文` 页查看 artifacts 与资料沉淀
7. 回到 `最近任务` 继续任何一个任务

推荐的升级分流如下：

- 如果当前需求已演化成“需要一个长期维护的专用 Agent”，提示进入 `Agent Creator`
- 如果当前问题是“缺少某个能力模块”，提示进入 `Feature Creator`

这个分流应该是增强项，不应该打断编程工作台的主线。

## UI Copy Direction

文案语气要从“聊天助手”改成“任务协作工作台”。

例如：

- 不再强调“新对话”
- 改为“开始一个任务”
- 不再强调“继续会话”
- 改为“继续最近任务”
- 不再说“启动信息”
- 改为“任务简报”或“任务启动单”

首页 hero 建议表达：

- 面向真实编码任务
- 支持分析、实现、排障和优化
- 当前任务、项目上下文和过程记录会持续沉淀

## Block Reuse Recommendation

建议优先复用现有 block，不新增前端 block：

- `hero`：保留
- `launcher-grid`：新增，用于任务入口
- `session-list`：保留，但文案升级为任务语义
- `form`：保留，扩充字段
- `workspace-artifacts`：新增
- `project-docset`：新增

这意味着第一阶段主要工作是：

- 改 `programming-helper/metadata.json`
- 让后端为该 workspace 提供 artifacts / docset 数据
- 调整 session 标题与摘要生成逻辑
- 优化 agent 首轮提示词注入

而不是先扩展一套新的前端 block 类型。

## Suggested Metadata Shape

推荐 `programming-helper` 顶部切换为：

- `workbench`
- `recent`
- `context`

`home.blocks` 推荐结构：

- `hero`，显示在 `tab:workbench`
- `launcher-grid`，显示在 `tab:workbench`
- `startup-form`，显示在 `focus`
- `session-list`，显示在 `tab:recent`
- `workspace-artifacts`，显示在 `tab:context`
- `project-docset`，显示在 `chat-header-only`

如果希望 `context` 页更完整，也可以把 `project-docset` 同时放在 `tab:context`，而不仅是聊天页 header。

## Non-Goals

这一轮不建议做的事：

- 把 `programming-helper` 做成完整 IDE
- 做复杂看板、任务树、多人协作
- 放开用户自定义工作空间表单和页面
- 新增专属于该 workspace 的重型交互组件
- 在首页直接混入 `Agent Creator` 那种 Feature 选配流程

## Implementation Priority

建议分三步推进。

### Phase 1

先完成工作空间结构升级：

- tabs
- launcher-grid
- 新表单字段
- session-list 文案改造

### Phase 2

接入沉淀能力：

- workspace artifacts
- project docset
- 表单与 docset 的映射

### Phase 3

再做体验增强：

- 按任务类型预填文案
- 更好的 session 标题生成
- 与 `Agent Creator` / `Feature Creator` 的升级跳转

## Final Recommendation

推荐采用“编程任务工作台”方案，而不是“增强版聊天首页”方案。

原因很直接：

- 它更符合比赛里“解决真实高频场景”的叙事
- 它和当前 `Agent Creator` / `Feature Creator` 的成熟经验是一致的
- 它对现有前端 block 体系最友好
- 它能在较小新增成本下显著提升 `programming-helper` 的产品感和可展示性

一句话总结：

`programming-helper` 的目标不是把聊天入口做得更花，而是把“编程任务推进”做成一个能看见上下文、过程和升级路径的工作空间。
