# 从其他 Agent 迁移：概念对照

用户带着其他 Agent 的使用习惯来提问时，先在这张表里定位对应概念，再展开讲解。右列是本产品的对应做法，展开细节见各专门 reference。

## 总表

| 你在别的工具里熟悉的 | 这里的对应 |
|---|---|
| `claude mcp add` / 项目 `.mcp.json` / Claude Desktop 的 `claude_desktop_config.json` | 项目 `.agentdev/mcps/*.json`（直接兼容 `mcpServers` 键）或 设置 → MCP 网关；见 references/mcp.md |
| 项目 `.claude/skills/` 技能目录 | 项目 `.agentdev/skills/`（默认扫描）；项目内 `.claude/skills/` 也可开启扫描直接复用；见 references/skills.md |
| `CLAUDE.md` / `AGENTS.md` / `.cursorrules` 项目记忆文件 | `CLAUDE.md` 和 `AGENT.md` 原生支持：放在项目根目录自动读取注入（默认开启），另可配置最多 10 个额外文档；`.cursorrules` 改名或列入额外文档即可 |
| `/model` 命令、`ANTHROPIC_API_KEY` 等环境变量 | 设置 → 模型配置（三类入口），会话内可在输入框旁切换模型；见 references/models.md |
| `/compact`、`/clear` 上下文压缩 | 会话右键菜单：精简历史（Trim）或 总结历史（Summary）；上下文超阈值时还会自动提醒；见 references/sessions-and-data.md |
| `claude --resume`、会话恢复 | 会话保存在左侧列表，点开即续；支持从任意消息节点分支新会话 |
| `~/.claude/`、`~/.codex/` 本机数据目录 | `~/.agentdev/AgentDevClaw/`（会话、工作空间状态、Feature 资产） |
| 权限 allowlist、`--dangerously-skip-permissions` | 没有权限配置文件；助手执行删除、强推等有风险操作前会在对话中征求确认，逐次把关 |
| 子代理（Task tool）、后台命令 | 后台任务面板（长时间命令转后台实时查看）与 Coder 工作空间（无人值守编码线程）；见 references/ui-tour.md |
| hooks、自动化钩子 | Feature 体系：能力包声明工具与钩子，`/` 命令菜单里按 `skill.` 前缀出现的命令即技能入口 |
| slash 命令 | 输入框内输入 `/` 唤起菜单，含技能与功能命令 |

## 迁移速记

- **配置思路的差异**：其他工具把配置分散在命令行参数、环境变量和多个 json 文件里；这里集中在界面设置（齿轮菜单）+ 项目内 `.agentdev/` 目录两处。界面设置管模型、代理、网关这类跟着机器走的配置；`.agentdev/` 管跟着项目走的配置（MCP server、技能），可以进版本库与团队共享。
- **MCP 与技能的迁移成本最低**：MCP 配置文件兼容 `mcpServers` 键，技能是同样的 SKILL.md 格式，基本是复制文件的事。
- **模型不必从环境变量配**：在设置 → 模型配置里完成订阅登录或 API key 填写，预设对所有工作空间可用。
