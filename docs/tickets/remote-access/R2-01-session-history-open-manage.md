# R2-01 — 远程会话历史：发现、打开与管理（Phase 3 第一刀）

- **仓库**：AgentDevClaw
- **决策依据**：ADR-0011（protoclaw 适配套路）、ADR-0012（统一呈现与激活语义）
- **类型**：protoclaw 域远程转发 + 前端会话列表统一
- **前置**：**R1-09 全部合入**（`focusedAgentId` host 级收敛 + `getCurrentControlAgentId` 收敛点 + accessor 是本票寻址的前提；R1-09 的 A–E 已合入，F 项测试合入即视为前置满足）
- **状态**：已立项未派发

## 范围（已批准切片）

读链路 + 激活 + 管理操作，形成"发现 → 打开 → 管理"闭环：

| 端点 | 方法 | 用途 |
|---|---|---|
| `/protoclaw/prebuilt_sessions?agentId=` | GET | 历史会话列表 |
| `/protoclaw/search_sessions` | GET | 会话搜索 |
| `/protoclaw/session_record` | GET | 会话记录（转录） |
| `/protoclaw/prebuilt_sessions/activate` | POST | **激活**（远程端启动 runtime） |
| `/protoclaw/prebuilt_sessions/delete` | POST | 删除 |
| `/protoclaw/prebuilt_sessions/archive` | POST | 归档 |
| `/protoclaw/prebuilt_sessions/:sessionId/title` | PUT | 改名 |
| `/protoclaw/prebuilt_sessions/todo` | POST | todo 设置 |
| `/protoclaw/generate_session_title` | POST | AI 标题（LLM 调用发生在远程端） |
| `/protoclaw/generate_recap` | POST | AI recap |

## 服务端改动

### 路由远程分支（照 Phase 2 现状模式，Q3 批复）

每路由 8-12 行薄分支，模式已在 6 个端点验证（`agent-lifecycle.js:367/658`、`model-config.js:444/701/766`、`tool-state.js:35`）：

```js
const hostTarget = resolveForwardHostTarget(agentId, sessionId);
if (hostTarget.scope !== 'local') {
  return await forwardProtoclawRoute(res, hostTarget, '/protoclaw/xxx', {
    method: 'POST',
    body: { agentId: bareId(agentId), sessionId: bareId(sessionId), ... },
  });
}
// 本地路径原样，零改动
```

- 族级中间件已评估并 **rejected**：21 个路由 body/query 重写规则不同质，中间件要么内置规则表（显式性没赢）要么统一规则（错配风险）。
- `server/routes/session.js` 的写路由已有 `readOperationMetadata` / `createOperationTrace` / `attachOperationMetadata` 契约（:269/:587/:995/:1246/:1289/:1357），远程分支保持 trace 语义。

### 幂等闸补齐（本票必须）

现状：`idempotency_key_required` 强制闸只在 proxy.js（/api/agents 族，:249）；protoclaw 域写端点（含 Phase 2 已接的 swap 系）**没有幂等强制**。本票把闸补到 session.js 全部写端点的远程分支：远程目标 + 无 `idempotencyKey` → 400，请求不过隧道。本地路径保持现状（session.js 的 readOperationMetadata 是 trace 增强，不强制）。

## 前端改动

### 会话列表统一（ADR-0012 决策 1）

- workspace surface 的会话列表来源从"仅本地 `prebuilt_sessions`"扩展为"本地 + 各 connected 连接的转发列表"，**混合排序、无来源分区、无远程徽标**。
- 调用点锚点（2026-08-30 grep 复核，覆盖全部 `/protoclaw/prebuilt_sessions` 读消费方；施工时以当时 grep 为准逐个核对）：
  - 列表拉取：`app-main.js:903/1328`、`session-ui.js`（3s 刷新）、`home-dashboard.js:60`、`dispatch-actions.js:161/199`、`external-runtime.js:93`、`ph-project-actions.js:122`、`model-settings.js:720/755`、`ctx-menu-handlers.js:447`
  - 搜索：`ph-session-list.js:150`（`/protoclaw/search_sessions`）
  - 会话记录：`workspace-actions.js:481`（`session_record`）
  - 同链路旁证（不属本票转发范围，但受列表/身份链影响，施工时核对）：session_summary / session_generate_summary → `debug-summary-upload.js:138/150/158/220/226`；trim_preview 前端 `slash-commands.js:67`、`session-dialogs.js:90/381`（属 R2-02 范围）。
- 远程列表的拉取经转发端点（agentId 用 host 级命名空间 id），或复用 `remote_catalog` 聚合（以实现时更省的为准，两案皆符合套路——拉取方式是传输细节，不改变列表语义）。
- 混入过滤：远程目录的转发列表只并入与当前打开 workspace 目录匹配的条目（按目录路径对齐）；宿主级 / IM 门户类无目录会话不并入列表（对齐 ADR-0010 "无目录 runtime 不制造伪项目组"）。
- 混入过滤：远程目录的转发列表只并入与当前打开 workspace 目录匹配的条目（按目录路径对齐），宿主级/IM 门户类无目录会话不并入列表。

### 激活流程（ADR-0012 决策 2）

- 点击远程历史会话 → `POST /protoclaw/prebuilt_sessions/activate`（转发，裸 host id + 裸 sessionId）→ 远程 `startManagedAgent` → 远程 catalog 出现运行中 runtime → 本地侧栏投影自动带出（Phase 1.5 链路，零新代码）。
- **无确认层**；断线/远程不可达按 ADR-0011 三分类显式呈现（`activate` 路由已返回 operation 契约）。
- 锚点：`app-main.js:278-279`（create/activate 二分支）——远程路径统一走 activate。

### 管理操作（ADR-0012 / Q6 批复）

- 上下文菜单（归档/删除/改名/todo 设置）在远程历史会话项上可用，delete 复用既有二次确认 UI。
- 调用点锚点（2026-08-30 grep 复核）：`ctx-menu-items.js:250/320/508/583/652`（archive/title/todo）、`ctx-menu-handlers.js:277/439/447`（delete/列表）、`workspace-actions.js:583`（delete）、`assembly-actions.js:822`（delete）、`session-mutation.js:192`（archive）、`wg-threads-panel.js:575`（archive）、`session-ui.js:293/406`（generate_session_title / title）、`auto-title.js:320`（generate_session_title）。
- AI 标题消费方补充：`session-ui.js:293` 与 `auto-title.js:320` 均调 `generate_session_title`，远程路径需确认身份来源走 host 级命名空间 id（LLM 调用发生在远程端，用远程模型配置）。
- **身份来源统一**：所有调用点的 agentId 改用 host 级命名空间 id（`getCurrentControlAgentId()` / `getEntryHostAgentId()`），杜绝 Phase 2 实测过的 `getCurrentAgentRecord()` → null → 400 同族问题（tool_state 400 / agent_detail 404 的教训）。每个调用点施工时逐个核对，这是本票最大的回归面。

## 测试

- 服务端：十个路由的转发用例（照 `test/remote-write.test.js` harness 模式：转发形状 / 裸 id 展开 / 未知连接 404 契约 / 幂等闸 400 / 本地分支零网络）。
- 幂等闸：session.js 写端点远程无键 400 用例。
- 前端：远程历史会话列表项的合并渲染 + 点击激活的请求形状（vm 沙箱）。
- 回归：全量 `npm run test:core` + eslint + `git diff --check`。

## 验收标准

- 双机冒烟：本地 workspace surface 看到远程目录的历史会话（与本地混合）；点击激活 → 远程起 runtime → 侧栏出现运行中会话并进入可交互视图；归档/改名/删除/todo 生效且确认 UI 复用；断线时操作显式失败。
- 远程 AI 标题生成（generate_session_title）使用远程模型配置。

## 明确不做

- branch / trim / compact / summary（R2-02）。
- checkpoint/rollback 新端点（runtime continuation 机制经 input 链路已通，本票只做验收确认）。
- 分页（ADR-0012 决策 3）、远程确认层、/api/logs（Phase 4）。
- capability 域 slash 命令远程矩阵（独立票）。
