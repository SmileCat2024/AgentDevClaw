# Claw CLI 产品语义重设计

## 定位

Claw CLI 是 **面向 agent 的子代理调度工具**。它的用户不是人，而是主代理（Claude Code、任意 LLM agent 等）。CLI 为主代理提供两种能力：

1. **探索**：派出一个自主探索代理，收集某个领域的知识
2. **派遣**：基于已有探索知识，派出一个目标驱动的子代理执行具体任务

主代理自身有自己的对话上下文（在 Claude Code 里、在别的运行时里），CLI 不管理主对话。

## 三种实体

### 1. 探索对话 (Exploration)

裸启动的自主探索会话。没有父上下文，从零开始。

- **创建方式**：`claw spawn --goal "探索XX"`
- **运行方式**：自主运行，完成后自然结束
- **完成时**：自动锁定为探索记录（不可变）
- **自动锁定机制**：
  - 锁定是轻量操作（只更新 session index 中的 status 和 sessionType），不涉及 LLM 调用
  - 领域标签通过简单文本匹配生成（非 LLM），用于展示
  - 摘要生成（compact）是**显式、手动**的操作，不自动触发
- **前端 UI 应该展示**：
  - 摘要是否已生成（"已生成" / "未生成"）
  - 未生成时提供手动触发按钮（调用 compact）
  - 这把所有"黑盒"异步操作暴露在表面上
- **锁定后的内容**：
  - `goal`：原始探索目标
  - `conversation`：完整对话记录
  - `domains`：通过文本匹配生成的领域标签（如 "Flow编排", "Feature挂载"）
  - `summary`：由 compact 显式生成，初始为空
- **性质**：不可变。创建后只能被读取和消费，不能被修改或追加

### 2. 子代理对话 (Sub-agent Session)

从探索记录派生的目标驱动会话。

- **创建方式**：`claw spawn <exploration-id...> --goal "基于XX分析YY"`
- **上下文来源**：消费一个或多个探索记录（全量或摘要拼接）
- **运行方式**：自主运行，带着目标完成任务
- **完成时**：
  - `goal`：原始任务目标
  - `finalOutput`：最后一轮 assistant 输出 = 交付物/总结
  - `domains`：LLM 自动概括的涉及领域标签
  - `domainOverview`：LLM 生成的领域概览（2-3 句话）
  - `sourceExplorations`：消费了哪些探索记录
- **性质**：可续的。主代理可以 resume 追加指令，子代理在原有对话上继续

### 3. 摘要 (Summary)

探索记录的派生产物，不是独立实体。

- **创建方式**：`claw compact <exploration-id>`
- **用途**：当子代理需要消费多个探索记录时，用摘要代替全量对话，节省上下文窗口
- **性质**：从属于探索记录的附属品。探索记录是源，摘要是浓缩版本
- **与当前 compact 的区别**：不再是"续接用压缩"，而是"知识蒸馏"，目的是让多个探索记录可以被高效拼接注入子代理

## 状态流转

```
                    claw spawn --goal "探索XX"
                            │
                            ▼
                    ┌───────────────┐
                    │  探索对话       │
                    │  status: running│
                    └───────┬───────┘
                            │ 自然完成
                            ▼
                    ┌───────────────┐
                    │  探索记录       │
                    │  status: locked │  ← 不可变
                    └───────┬───────┘
                            │
              ┌─────────────┼─────────────┐
              │             │             │
              ▼             ▼             ▼
        claw compact   claw spawn    claw spawn
        生成摘要        (full)        (summary)
              │             │             │
              ▼             │             │
        ┌──────────┐       │             │
        │ 摘要文件  │       │             │
        └──────────┘       │             │
                           ▼             ▼
                    ┌───────────────┐
                    │  子代理对话     │
                    │  status: running│
                    └───────┬───────┘
                            │ 自然完成
                            ▼
                    ┌───────────────┐
                    │  子代理(已完成) │
                    │  finalOutput   │  ← 可读、可 resume
                    │  status: done  │
                    └───────┬───────┘
                            │ claw resume --msg "再挖XX"
                            ▼
                    ┌───────────────┐
                    │  子代理(续接)   │
                    │  status: running│
                    └───────────────┘
```

## 命令体系

### 会话创建

| 命令 | 说明 |
|------|------|
| `claw spawn --goal <text>` | 裸启动探索对话，无父上下文 |
| `claw spawn <exp-id...> --goal <text> [--mode full\|summary]` | 从探索记录启动子代理，`--mode summary` 时消费 compact 生成的摘要 |

两个命令其实是同一个，区别是有没有传 exploration-id。不传 = 探索对话，传了 = 子代理对话。

### 信息查询

| 命令 | 说明 |
|------|------|
| `claw explorations` | 列出所有探索记录，显示领域概览卡片 |
| `claw show <id>` | 显示探索记录的完整内容 或 子代理的最终输出 |
| `claw subs` | 列出所有子代理，显示目标、领域概览、状态 |

### 知识加工

| 命令 | 说明 |
|------|------|
| `claw compact <exploration-id>` | 对探索记录生成摘要，用于后续子代理的轻量上下文拼接 |

### 会话续接

| 命令 | 说明 |
|------|------|
| `claw resume <sub-id> --msg <text>` | 在子代理对话上追加指令继续执行 |

### 已废弃

| 旧命令 | 原因 |
|--------|------|
| `claw ls` / `claw sessions` | 不再面向人，替换为 `explorations` / `subs` |
| `claw summaries` | 替换为 `claw explorations`（探索记录本身就包含概览） |
| `claw summary-show` | 替换为 `claw show <exploration-id>` |
| `claw seed` | 子代理上下文构建由 spawn 内部自动完成，无需单独 seed |
| `claw spawn --clean` | 裸启动本身就是探索对话，不需要 --clean 标志 |

## 数据模型

### sessionType

从 `main | sub` 变为 `exploration | sub`。不再有 main——main 在调用方自己的运行时里。

### 探索记录元数据 (meta)

```json
{
  "id": "exp-1779350789768",
  "type": "exploration",
  "status": "running | locked",
  "goal": "探索 AgentDevClaw 的 Flow 编排架构",
  "domains": ["Flow编排", "Feature挂载", "ToolRegistry", "节点行为"],
  "domainOverview": "探索了 Flow Feature 的运行时架构，覆盖了 Hook 驱动的阶段行为控制、Feature tools 的权限模型，以及节点级别的 prompt 注入机制。",
  "createdAt": "2026-05-21T08:30:00Z",
  "lockedAt": "2026-05-21T08:45:00Z",
  "hasSummary": true
}
```

### 子代理元数据 (meta)

```json
{
  "id": "sub-1779351000456",
  "type": "sub",
  "status": "running | done | paused",
  "goal": "基于 Flow 运行时分析，深入 ToolRegistry 权限检查的完整流程",
  "sourceExplorations": [
    { "id": "exp-1779350789768", "mode": "full" },
    { "id": "exp-1779350890123", "mode": "summary" }
  ],
  "domains": ["权限检查", "工具注册", "双层控制面"],
  "domainOverview": "分析了 ToolRegistry 的权限检查流程，发现当前实现从 ctx.agent.tools 拿 registry 而非假设全局方法。",
  "finalOutput": "(子代理最后一轮 assistant 输出的完整文本)",
  "createdAt": "2026-05-21T09:00:00Z",
  "completedAt": "2026-05-21T09:15:00Z"
}
```

### 摘要文件 (compact 产物)

```json
{
  "sourceExplorationId": "exp-1779350789768",
  "summaryText": "(蒸馏后的结构化摘要)",
  "importantFiles": ["..."],
  "importantSkills": ["..."],
  "createdAt": "2026-05-21T09:30:00Z"
}
```

存放在探索记录目录下或 handoffs 目录下，从属于探索记录。

## 关键不变量

1. **探索记录不可变**：一旦 locked，对话内容不再改变
2. **锁定是轻量的、自动的**：不涉及 LLM 调用，只更新状态字段
3. **摘要是显式的、手动的**：compact 不自动触发，前端 UI 暴露摘要生成状态
4. **子代理可续但探索不续**：resume 只作用于子代理对话，探索记录永远不能再追加
5. **子代理上下文只来自探索记录**：子代理的消费来源只能是探索记录（全量或摘要），不能是其他子代理的对话
6. **finalOutput 即交付**：子代理的最后一轮输出就是它的"总结"，不需要再压缩

## 与现有代码的映射

### 需要改的

| 现有 | 变化 |
|------|------|
| `sessionType: main\|sub` | → `exploration\|sub`，删除 main 概念 |
| `cmdCompact` 对任意 session | → 只接受 exploration-id，产物挂到探索记录下 |
| `cmdSpawn` 的 `--clean` 路径 | → 就是默认的探索对话启动，不再需要 --clean 标志 |
| `cmdSpawn` 需要 handoff | → 探索对话不需要 handoff，子代理对话需要探索记录作为上下文 |
| `scanHandoffSummaries` | → 改为扫描探索记录，探索记录本身包含 domain 概览 |
| `claw summaries` | → `claw explorations` |
| `claw summary-show` | → `claw show <id>` |
| `claw seed` | → 废弃，上下文构建由 spawn 内部处理 |
| `claw ls` | → `claw explorations` + `claw subs` |

### 可以复用的

| 现有 | 复用方式 |
|------|----------|
| `run-compact-mirror.js` | 用于 `claw compact <exploration-id>` 生成摘要 |
| `run-one-shot-agent.js` | 用于运行探索对话和子代理对话 |
| `spawn_one_shot` API | 复用，增加 sessionType 区分 |
| `summary_export` API | 复用，语义改为"从探索记录生成摘要附属品" |
| 探索完成自动锁定 | 新增：需要在 one-shot 完成回调中自动设置 status=locked 并生成 domain 概览 |

## 典型使用流程

主代理（Claude Code）想了解一个陌生项目：

```
# 1. 派出探索代理
> claw spawn --goal "探索 AgentDevClaw 项目的产品定位和核心架构"
→ exp-001  探索完成，已锁定
  领域: 产品定位, Flow编排, Feature体系, 前端架构

# 2. 查看探索结果概览
> claw explorations
  exp-001  产品定位和核心架构  领域: 产品定位, Flow编排, Feature体系, 前端架构  ✓已锁定

# 3. 基于探索派子代理深入特定领域
> claw spawn exp-001 --goal "深入分析 Flow Feature 的运行时 Hook 驱动机制"
→ sub-001  子代理完成
  领域: Hook驱动, CallStart, StepStart, 节点prompt注入

# 4. 看子代理的结论
> claw show sub-001
  (子代理最后一轮完整输出)

# 5. 觉得不够，续接
> claw resume sub-001 --msg "ToolRegistry 的权限检查和 Feature mode 双层控制面具体怎么交互的？"
→ sub-001  继续运行中...

# 6. 再派出另一个方向的子代理
> claw spawn exp-001 --mode summary --goal "前端 workspace 状态管理机制分析"
→ sub-002  子代理完成
  领域: ClawFW状态机, block渲染, surface切换
```
