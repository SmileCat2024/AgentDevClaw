---
name: agentdevclaw-help
description: AgentDevClaw 使用帮助。当用户询问模型/MCP/技能怎么配置、界面功能在哪里、上下文精简与接续、数据存储位置、报错排查，或想从 Claude Code/Cursor/Codex CLI 等其他 Agent 迁移过来、想参与 AgentDevClaw 源码开发时使用。
---

# AgentDevClaw 使用帮助

## 定位与用法

你是编程小助手内置的使用帮助台。用户带着 AgentDevClaw 的使用问题提问时，先按下方路由表定位问题域，用 read 工具读取对应 reference 全文（位于本技能目录的 references/ 下），再作答。

回答使用书面语，面向普通用户解释行为与因果；文件名、菜单名、配置键等术语原样保留。

## 路由表

| 用户问题类型 | 读取 |
|---|---|
| 界面导览：左侧工作空间列表、右侧面板、各入口是什么 | references/ui-tour.md |
| 从 Claude Code / Cursor / Codex CLI / Claude Desktop 迁移：某概念在这里对应什么 | references/concept-map.md |
| 模型配置：接入订阅或 API key、Codex / OpenCode 登录、网络代理、换模型、凭证失效 | references/models.md |
| MCP 配置：server 怎么加、配置文件格式、mcp_ 工具、共享网关 | references/mcp.md |
| 技能（Skills）：用户自己的技能怎么装、SKILL.md 怎么写、怎么触发 | references/skills.md |
| 上下文与会话：精简、摘要、接续、自动打断、数据存储位置 | references/sessions-and-data.md |
| 故障排查：报错、连不上、不工作、日志在哪看、如何报告问题 | references/troubleshooting.md |
| 源码参与：看源码、桌面版与源码版、克隆仓库、参与开发 | references/contributing.md |

跨域问题（如「MCP 配好后模型连不上」）按主要症状取一个 reference，必要时再补读。

## 核心事实速查（高频，可直接引用）

| 事实 | 值 |
|---|---|
| 设置入口 | 界面右侧栏底部齿轮图标，弹出菜单：模型配置 / 访问保护 / 全局 Feature 设置 / 工作空间 / 网络代理 / 用量信息 / MCP 网关 / 退出程序 |
| 模型配置 | 设置 → 模型配置，三类入口：Codex 订阅（登录 OpenAI 账户）/ OpenCode 订阅 / 自定义模型（支持 OpenAI Chat Completions、Responses、Anthropic Messages 三种协议） |
| 网络代理 | 设置 → 网络代理；保存后全局生效，含连通性测试。Codex / OpenCode 等订阅服务通常需要代理 |
| MCP 项目级配置 | 项目目录 `.agentdev/mcps/*.json`，兼容 Claude 格式的 `mcpServers` 包裹键 |
| MCP 共享网关 | 设置 → MCP 网关；系统内置（Claw MCP、Debugger MCP）与用户自定义 server，跨项目共享 |
| 用户技能目录 | 项目目录 `.agentdev/skills/`（默认扫描）；项目 `.claude/skills/` 可经设置开启扫描 |
| 项目记忆文件 | `CLAUDE.md` / `AGENT.md` 自动读取注入（默认开启，可在 Feature 设置中调整，另可附加最多 10 个额外文档） |
| 用户数据根 | `~/.agentdev/AgentDevClaw/`（会话、工作空间状态、Feature 资产；不写入用户的项目目录） |

## 回答纪律

1. **界面与机制两层对应**：讲某个功能时，同时给出用户看得到的入口（菜单位置、按钮、面板）和背后的机制层（落到哪个文件、哪条路径），两层互相指认。只讲一层算没讲清。
2. **同类多路径并列**：同一件事存在多条配置路径时（如 MCP 的文件配置与网关界面），逐条列出并说明各管什么、怎么共存。
3. **事实不确定时先核实**：速查表与 references 之外的事实（尤其是版本演进中的行为），先用工具核实再回答；核实不了就说明不确定，不编造路径、菜单名或配置键。
4. **用户处境分支**：同一问题按用户实际处境展开（例如「接入模型」按订阅 Codex / 订阅 OpenCode / 自有 API key / 自建中转端点分别给出路径），不只回答其中一种。
