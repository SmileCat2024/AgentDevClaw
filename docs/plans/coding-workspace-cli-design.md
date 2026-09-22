# 编程小助手工作空间简化 + CLI 设计

## 一、设计意图

当前 `programming-helper` 工作空间以"表单驱动启动"为核心交互模型：用户先填 8 个字段的任务启动单，再进入对话。这个模型的问题是：

1. 对严肃编码场景来说，启动单太重，填写成本高
2. 表单内容（goal / constraints / target_files 等）在实际对话中经常被重新定义，填不填影响不大
3. 与 Claude Code / Codex 等工具的交互心智差距大 — 用户期望的是"指向目录 -> 开聊"

目标产品形态：**项目 + 对话列表**，对标 Claude Code 的简洁度。

同时暴露一个 CLI 入口 `claw`，让 Claude Code 等外部工具能直接查询 AgentDevClaw 内的编程小助手数据（项目、对话、摘要），无需启动 Web UI。

## 二、需求

### 2.1 工作空间简化

- 删除 `hero` block、`launcher-grid` block、`startup-form` block
- 删除 `workspace-artifacts` block、`project-docset` block
- 删除 `workbench` / `context` tab，只保留 `sessions` 和 `chat`
- 主界面变为：项目信息（目录绑定）+ 对话列表 + 新建对话按钮
- 新建对话只需指定工作目录（可选），不再需要填表单
- 对话创建时自动从当前 workspace state 取 `openDirectory`

### 2.2 CLI 命令

CLI 是 `claw` 整体入口，当前只实现编程小助手相关命令：

```
claw                              显示状态概览
claw ls [--dir <path>]            列出编程小助手的项目/会话
claw sessions [--dir <path>]      列出某个目录下的对话记录
claw show <session-id>            显示某次会话的摘要信息
claw compact <session-id>         对某次会话执行上下文压缩
```

未来扩展方向：
- `claw flow ...` — Flow 工作空间命令
- `claw agent spawn ...` — 派遣子代理
- `claw summary ...` — 查询跨工作空间的经验索引

## 三、环境与依赖

### 3.1 数据位置

所有数据在文件系统上，CLI 无需 HTTP 服务：

```
~/.agentdev/AgentDevClaw/
├── workspaces/
│   └── programming-helper/
│       ├── state.json            # workspace state（含 forms, openDirectory）
│       └── sessions/
│           ├── index.json        # session 注册表
│           └── session-*.json    # 各次会话快照
├── prebuilt-sessions/
│   └── <other-agent-id>/
│       └── ...
```

### 3.2 已有基础设施

- `server.js` 中的 `readSessionIndex()` / `listPrebuiltSessions()` / `readWorkspaceState()` — 但这些依赖 Express 上下文
- `scripts/run-compact-mirror.js` — 独立进程的 compact 执行
- session 文件结构：`{ runtime: { context: { messages: [...] } } }`

### 3.3 依赖决策

CLI 不依赖运行中的 HTTP 服务，直接读文件系统。原因是：
1. Claude Code 调用时 Web 服务不一定在跑
2. 文件都在本地，没有必须走 HTTP 的理由
3. 减少启动等待

compact 命令例外：它需要加载 agent 模块和 LLM，复用 `run-compact-mirror.js` 的模式。

## 四、命令体系设计

### 4.1 当前命令

```
claw                          状态概览（哪些工作空间有数据）
claw ls                       列出编程小助手的所有会话（按时间倒序）
claw ls --dir <path>          列出与指定目录关联的会话
claw sessions                 同 claw ls（别名）
claw show <session>           显示会话详情（消息数、最后消息预览、openDirectory、创建/更新时间）
claw show <session> --full    显示完整 handoff 摘要（如果有）
claw compact <session>        对会话执行 compact-mirror 生成摘要
```

### 4.2 设计原则

- 短命令优先：`claw ls` 比 `claw programming-helper list-sessions` 好用
- 当前只有编程小助手一个工作空间，所以不需要命名空间前缀
- 未来加 `claw flow ls` 时，自然形成工作空间前缀
- `--dir` 筛选是核心能力：Claude Code 在 A 目录工作时，`claw ls --dir A` 直接看相关上下文

### 4.3 输出格式

输出面向机器可读 + 人类可读：

```
$ claw ls --dir D:\code\my-project

编程小助手 · D:\code\my-project
3 个会话

  session-1779241241016  UI回归问题重测      25条消息  2026-05-20
  session-1779156000000  修复登录页按钮失效   12条消息  2026-05-19
  session-1779070000000  重构路由模块         42条消息  2026-05-18

$ claw show session-1779241241016

会话 session-1779241241016
标题: UI回归问题重测
目录: D:\code\my-project
消息: 25 条
创建: 2026-05-20 14:30
更新: 2026-05-20 15:12
最后消息: 已验证修复生效，所有回归测试通过...
```

## 五、边界

### 5.1 不做的事

- 不改 server.js 的会话管理逻辑
- 不改前端 block 渲染框架（只改 programming-helper 的 metadata.json）
- 不引入新的 npm 依赖
- CLI 不负责创建对话（那是 Web UI 的职责）
- CLI 不启动 agent runtime（compact 除外，它走独立进程）

### 5.2 风险点

- metadata.json 改动会影响前端渲染 — 需要确认 session-list block 在没有 form block 时的行为
- agent.js 的 `onInitiate()` 从 workspace state 读 startup-form — 简化后需要适配
- `writeWorkspaceState()` 中 `buildProgrammingHelperDraftArtifact()` 依赖 startup-form 字段 — 需要兼容

### 5.3 兼容性

- 已有 session 数据不受影响（只是不填 form 字段了）
- CLI 读的是同一份 session index 和 state.json
- `run-compact-mirror.js` 不受影响
