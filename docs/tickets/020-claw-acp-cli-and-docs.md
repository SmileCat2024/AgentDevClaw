# 020 — ACP CLI 接入与文档

- **仓库**：AgentDevClaw（`D:\code\AgentDevClaw`）
- **决策依据**：[coder-acp-adapter-design.md](../coder-acp-adapter-design.md) §10 / §11 / §13；grill Q13-A；[ADR-0004](../adr/0004-acp-adapter-external-stdio-process.md)
- **类型**：CLI + 文档收尾
- **前置**：019

## 背景

ACP client 需要一个稳定、跨平台的启动命令配置到自己的 agent 启动项里；
对外行为契约（能力边界、限制、stdout/stderr 纪律）需要与实现一致的文档
承载点。`claw` 已是项目对外 CLI，命令面归它管。

## 执行步骤

1. `bin/claw.mjs` 增加 `claw acp coder` 子命令：spawn
   `node scripts/run-coder-acp.js`，stdio **inherit**（stdout/stderr 直通，
   不加任何包装层），透传子进程退出码。
2. `agents/README.md` 新增 ACP 章节：
   - 启动配置示例（client 侧配置 `claw acp coder`）
   - 能力边界（四方法集；不支持项清单）
   - stdout 只承载 JSON-RPC / 诊断在 stderr 的契约
   - 配置项表（设计文档 §11）
   - v1 已知限制（设计文档 §13：整段消息粒度、500ms 轮询延迟、UI 并发输入
     误归因、无 close/load、仅文本输入）
3. `CLAUDE.md` 增补一小节（放在「Plain Agent 与 claw CLI」相邻位置）：
   ACP 适配层定位一行（独立 stdio 进程、执行权威在 server、链接设计文档与
   ADR-0004）+ 重启语义（adapter 改动只需新起子进程；018 类 server 路由改动
   需整服重启）。
4. 文档一致性自检：文档中的能力声明逐项对照 019 实际实现（声明 = 实现，
   无多写也无漏写）。

## 验收标准

- `claw acp coder` 手动 JSON-RPC 会话冒烟通过（initialize → session/new →
  prompt → cancel 全链路，经 CLI 命令启动而非直接 node 脚本）。
- 文档与实现一致；设计文档 / ADR / tickets 交叉链接有效。

## 风险提示

- 无重大风险；注意 CLI 帮助文本与 README 同步。
