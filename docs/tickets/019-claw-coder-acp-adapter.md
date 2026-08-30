# 019 — coder ACP stdio adapter 本体

- **仓库**：AgentDevClaw（`D:\code\AgentDevClaw`）
- **决策依据**：[coder-acp-adapter-design.md](../coder-acp-adapter-design.md) 全文（§4 协议契约 / §6 管线 / §7 映射 / §8 取消 / §9.3 归因）；grill Q2 / Q4–Q10 / Q17–Q19 / Q23–Q25 / Q27-A；[ADR-0004](../adr/0004-acp-adapter-external-stdio-process.md)
- **类型**：新增独立进程（ACP v1 stdio 协议端点）
- **前置**：018（路由联调）；017（游标正确性，联调前须合入）

## 背景

参考 `D:\GithubDownload\codex-acp` 的三层结构（协议入口 / session 管理 /
事件转换），adapter 是纯协议端点：不 import `@agentdev/*`、不实例化 Agent，
执行全部由 Claw server 承担（ADR-0004）。stdout 只承载 JSON-RPC，日志全走
stderr。

## 执行步骤

1. `package.json` 增加 `@agentclientprotocol/sdk`（registry **精确版本**锁定）。
2. 模块落地（职责表见设计文档 §10）：
   - `scripts/run-coder-acp.js` — 入口：stdio 装配、进程信号、退出清理
   - `scripts/coder-acp/protocol.js` — 请求校验、响应构造、错误 taxonomy
     （设计文档 §4.0：`-32602` / `-32000` UNREACHABLE / `-32001` BUSY /
     `-32002` TIMEOUT / `-32003` CLAW_ERROR）
   - `scripts/coder-acp/claw-client.js` — 本机 HTTP client（base URL、超时、
     错误归一；不依赖 Express / 框架）
   - `scripts/coder-acp/session-manager.js` — ID 映射（设计文档 §3 状态结构）、
     activePrompt 串行约束、cancelGeneration、断开仅清内存
   - `scripts/coder-acp/event-mapper.js` — §7 映射表、kind 分类、eventId
     去重、缺失字段规则（缺 id 生成 fallback；仅 completed 的 tool 先补
     最小 `tool_call`；raw 字段缺失省略不造假）
   - `scripts/coder-acp/main.js` — SDK handler 注册、自有 stderr logger
     （不引入框架 console 桥，无 headless-log-preamble 依赖）
3. 方法实现：
   - `initialize`：capability 按设计文档 §4.1（`loadSession: false`、无
     image / embeddedContext / fs / terminal / MCP / modes）；不触网
   - `session/new`：调 018 原子路由；`mcpServers` 仅接受 `[]`、
     `additionalDirectories` / `sessionModes` 非空一律 `-32602`；`cwd` 原样
     交 server 校验
   - `session/prompt`：仅 text block（多块合并单条消息），非文本 `-32602`；
     管线 = 基线捕获（cursor + knownEventIds + maxTurn）→ thread command
     （`source: "acp"` + `idempotencyKey`）→ 500ms 轮询（§11 可配）→
     update 映射 → 终态（completed→`end_turn`；failed→`-32003`；
     cancelled→`cancelled`；`turn <= baseline.maxTurn` 的终态仅告警不判定）
   - `session/cancel`（notification）与 `ctx.signal`（`$/cancel_request`）
     汇入同一 cancelGeneration：标记 → 调 018 interrupt（一次）→ 停发该代
     update → in-flight prompt 返回 `cancelled`；cancel 早于 `turn.started`
     时不等待 `turn.cancelled` 事件立即返回
4. 超时：默认 30 分钟（`CLAW_ACP_PROMPT_TIMEOUT_MS`，`0` 禁用）；超时
   `-32002`，**不自动 interrupt**。
5. 测试（全部 node:test，Claw HTTP 用本地 mock，无真实模型）：
   - `test/coder-acp-event-mapper.test.js`（§12 用例清单）
   - `test/coder-acp-session-manager.test.js`（§12 用例清单）
   - `test/coder-acp-wire.test.js`：spawn adapter，stdin 喂
     initialize / session/new / session/prompt；断言 stdout 每行可
     `JSON.parse`、收到 `session/update` 与 PromptResponse、无日志混入
     stdout、诊断在 stderr

## 验收标准

- 三套测试全绿；017 + 018 合入后真实链路冒烟：initialize / new（合法与
  非法 cwd）/ prompt（文本 update + 终态）/ cancel / server 未启动错误路径。
- adapter 进程内 `grep` 无 `@agentdev/` import（ADR-0004 纪律）。

## 风险提示

- 017 未合入时，去重只防重复不防丢失——联调与验收必须在 017 之后。
- SDK API 名与示意代码可能随版本漂移，以锁定版本类型声明为准；升级 SDK
  视为协议面变更，需重跑 wire 测试。
