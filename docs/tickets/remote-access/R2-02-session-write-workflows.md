# R2-02 — 远程会话写工作流：分支与上下文精简（Phase 3 第二刀）

- **仓库**：AgentDevClaw
- **决策依据**：ADR-0011、ADR-0012
- **类型**：protoclaw 域远程转发（重操作）
- **前置**：R2-01 合入（转发模式、幂等闸、前端身份来源已定型）
- **状态**：已立项未派发

## 范围（已批准切片）

| 端点 | 方法 | 用途 |
|---|---|---|
| `/protoclaw/sessions/branch` | POST | 从指定消息节点创建分支会话 |
| `/protoclaw/session_trim_preview` | GET | trim 预览 |
| `/protoclaw/session_summary` | GET | 摘要查询 |
| `/protoclaw/session_generate_summary` | POST | 摘要生成（LLM 调用在远程端） |
| `/protoclaw/context_handoffs/compact_and_resume` | POST | 压缩并续聊 |
| `/protoclaw/context_handoffs/compacted_resume` | POST | 压缩产物续聊 |

## 关键语义边界（施工前必读）

- **trim/summary 的组合语义权威在框架侧**：`TrimTranscriptWithSummaryTransformation`（`@agentdevjs/core`，ADR-0002）是唯一权威，thread 接力与手动精简共用。远程端执行完整变换（远程的框架 dist），本地**零变换逻辑**——本票只做转发，绝不本地复刻组合语义。
- **branch 的新会话落地在远程端**：新会话文件、checkpoint 提取（session.js:308-357 的运行态迁移）全部发生在远程；本地只接收响应中的新 session 元数据并以命名空间展示。分支后的续聊走 R2-01 的激活链路。
- **checkpoint/rollback 无新工作**：runtime continuation 机制（CallArbiter）经 input 写链路触达，Phase 2 已覆盖。本票只做双机验收确认（远程会话内建立检查点 → 回退生效）。
- **compact_and_resume 的 resume 目标**：激活发生在远程端（压缩产物在远程磁盘）。前端响应处理与新会话切换沿用 R2-01 的统一链路。

## 服务端改动

六个路由远程分支（照 R2-01 定型模式）：`resolveForwardHostTarget` → scope 判断 → `forwardProtoclawRoute` + `bareId` 展开。branch/compact 系是写端点，幂等闸随 R2-01 的 session.js 闸一并覆盖（确认无遗漏）。

## 前端改动

- 调用点锚点：`app-main.js:346`（compact_and_resume）、`session-dialogs.js:510`（branch 分支对话框）。
- 身份来源同 R2-01 纪律：host 级命名空间 id，逐调用点核对。
- 分支/压缩完成后的 UI 收敛：响应中的新会话以命名空间 id 进入既有列表刷新链（无远程特判）。

## 测试

- 六路由转发用例（转发形状 / 裸 id / 契约失败 / 本地分支零网络）。
- branch 响应的新会话元数据往返（远程返回 → 前端列表项）。
- 全量回归 + eslint + `git diff --check`。

## 验收标准

- 双机冒烟：远程会话分支（新会话出现在远程目录组）；远程 trim 预览与执行；远程摘要生成（远程模型配置）；compact_and_resume 在远程端续聊成功。
- 远程会话内 checkpoint → rollback 实测生效。

## 明确不做

- 本地 trim/summary 逻辑复刻（框架权威，远程执行）。
- 分支历史的可视化（远程 genealogy 视图——无需求，不立）。
- /api/logs、分页、确认层（沿用 R2-01 暂缓清单）。
