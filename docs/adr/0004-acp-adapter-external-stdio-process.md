# ADR 0004: ACP 接入——适配器外置为独立 stdio 进程，执行权威留在 Claw server

- 日期：2026-08-21
- 状态：已接受（grill 会话定稿；执行为 docs/tickets 批次 6，017–020）
- 前置：ADR-0002（Session Continuity as Transformation，批次 2——本决策消费其 WorkThread / 看板语义）

## 背景

ACP client 通过 stdio 启动 agent 子进程并与之 JSON-RPC 通信。coder 是 Claw
server 托管的工作空间 agent：session / thread / CallArbiter / interrupt 全部由
server 进程管理。承载方式存在三个真实选项（grill Q1/Q3）：

1. 混入 server.js（`npm start -- --acp`）
2. adapter 直接实例化 `CoderAgent`（绕过 server）
3. 独立 adapter 进程 + 本机 HTTP 调用已运行的 Claw server

同时 grill Q26 拒绝了「Claw server 侧游标覆盖层」这一对框架 WorkThreadBoard
游标缺陷的补偿方案。

## 决策

1. **ACP 端点是独立 stdio 子进程**（`claw acp coder` →
   `scripts/run-coder-acp.js`）。adapter 不 import `@agentdev/*`、不实例化
   Agent，只做协议转换 + 本机 HTTP 调用 Claw server。
2. **执行权威与数据生命周期全部留在 server**：ACP `session/new` 创建 Claw
   session + thread；adapter 断开 / 退出不删除、不停止任何 Claw 持久化对象。
3. **server 为 ACP 提供原子编排路由**（创建 / 精确中断），adapter 不自行组合
   现有端点——避免多端点编排留下孤儿 session / runtime / thread，也使
   viewerAgentId 等 ViewerWorker 内部概念不出现在 adapter 层。
4. **ACP session ID 直接使用 Claw sessionId**（2026-08-24 修订；原为「解耦、
   adapter 生成 UUID」）。`session/list` / `session/resume` 要求会话标识跨
   adapter 进程重启可恢复，持久化真相在 Claw server——直接采用 Claw
   sessionId 免除第二套映射的回填成本，本地单用户场景亦无泄露顾虑。
   **threadId 仍不外泄为协议标识**（仅作为 list 元数据）。
5. 框架缺陷（board 事件游标跨裁剪丢事件）在 AgentDev 权威源码修复（017），
   不做 server 侧补偿层。

## 备选方案（rejected）

- **混入 server.js**：stdio client 生命周期绑定整个 Web 服务；stdout 属于
  server 进程，JSON-RPC 帧与服务日志必然混流；client 重启等于动主服务。
- **adapter 直接实例化 CoderAgent**：制造第二套 coder runtime，绕过 workspace
  thread / CallArbiter / 精确 interrupt，破坏既有会话连续性语义；与本会话
  确认的「复用现有投递链路」前提直接冲突。
- **走 ViewerWorker API**：绕过 thread 控制面，丢失 session 精确定位，
  与 CLAUDE.md「前端→agent 控制 IPC 必须优先 runtimeId / 精确 session」的
  纪律相悖。
- **server 侧游标覆盖层**（server 自维护绝对序号补偿 board 裁剪缺陷）：
  补偿层掩盖框架缺陷，与仓库「在权威源码位置修复」纪律冲突；且 server 重启
  后覆盖层映射失效。

## 后果

- **正面**：协议演进不牵动 server；Claw UI 与 ACP client 共享同一执行真相；
  adapter 可独立演进、独立重启（改动只需新起子进程）；stdout 纯度可机械
  验证。
- **负面**：Claw server 成为前置运行时（未运行即报错，不自动拉起）；事件
  只能轮询（500ms 粒度），且正确性依赖 017 框架修复先行合入。
- **纪律**：adapter 永不 import `@agentdev/*`；stdout 永远只有 JSON-RPC；
  adapter 与 server 之间只允许本机 HTTP 契约。
