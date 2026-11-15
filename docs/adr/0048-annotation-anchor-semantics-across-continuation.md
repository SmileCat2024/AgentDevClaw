# ADR 0048: 会话标注跨接续的锚位语义

日期：2026-11-14
状态：已接受（已实施：feature 恢复语义与幂等口径、前端重放/合并/定位/徽标、宿主 mode 透传、feature 与前端测试含变异验证）

## 背景与问题

会话标注（`local-features/conversation-annotations`）的锚位是 `turn`（call 序号）+ `role` + `quote` + `occurrence`，其中 turn 是**会话内编号空间**：消息没有稳定 id，turn 只在同一会话的 transcript 内有意义。标注经 `declareContinuity` 随 SuccessorSeed 跨接续透传，但不同 handoff 形态对编号空间的处理不同：

- **trim 系 / branch**：种子消息携带原 turn（编号空间连续），导入标注的锚位继续有效。
- **summary 系（`summarized-*`）**：transcript 被摘要消息替换，turn 从 0 重新编号。导入标注的 turn 在新会话中成为**死锚**（目标轮次未到达）或**碰撞锚**（同值 turn 被无关新消息占据，选区匹配是子串搜索，碰撞会误高亮错误内容）。

原设计只考虑了 trim 语义（"接续经 declareContinuity 流转"），summary 接续后旧标注在本会话继续参与匹配是正确性缺陷，不是呈现问题。

## 决策

1. **锚位编号空间按会话界定。** 跨接续导入的标注按 handoff 形态区分恢复语义，不做无差别导入。
2. **turn-preserving（`trim*` / `branch`）导入为 live**：锚位继续有效，重放、合并、定位、幂等照常。
3. **renumbering（`summarized-*` 与未知形态）导入为 dormant（前身会话标注）**：条目携带 `dormant: true` + `originSession`，数据保留（不因接续丢弃用户记录），但在本会话中**永不参与**重放匹配、重叠合并、滚动定位与 create 幂等命中（同数字 turn 只是编号巧合）；rollback 合并的 cutoff 过滤豁免 dormant（其 turn 不在本会话边界语义内，只能由用户显式删除）。同会话的 `lastCallIndex` 属同一编号空间，renumbering 导入不采纳，由新会话自身轮次跟踪重建。
4. **未知形态保守按 renumbering 处理。** 误高亮（错误行为）比缺失高亮（降级体验）更不可接受；宁可丢失可匹配性也不让旧 turn 碰撞。
5. **判定通道：`restoreState` ctx 的 `origin.mode`**（handoff 产物形态）。由宿主装配层 `run-prebuilt-agent` 从 handoff 透传；框架 `RestoreOrigin` 类型未声明该字段，消费方按结构防御性读取。按 ADR-0028 分层：该字段目前只有 Claw 宿主生产与消费，宿主够得着就不下沉框架；将来若有框架级 feature 需要同一判别，再提升为框架契约。

## 已知边界

- 存量接续会话（本决策部署前已导入的未标记死锚）无法事后鉴别（快照中无 mode 信息），保持原样；本决策只对新的接续生效。
- 标注写入的传输层报错（`channel_not_declared` / `runtime_not_connected` 等）是 runtime 停止后的通用寻址行为，与本决策的锚位语义正交。

## 实施记录

- feature（`conversation-annotations/src/index.ts`）：`restoreState(snapshot, ctx?)` fresh 路径按 `origin.kind === 'continuity-import' && !isTurnPreservingContinuity(origin.mode)` 打标；rollback 合并豁免 dormant；create 幂等只对 live 条目。`declareContinuity` 包装的 `onInitiate` 缓冲区重放走 rollback 合并路径，标记经豁免语义存活（有测试钉住）。
- 宿主（`scripts/run-prebuilt-agent.js`）：continuity 导入 origin 增加 `mode: handoffMode`。
- 前端（`public/src/modules/annotations.js`）：replayAll / 重叠合并跳过 dormant（createTreeWalker 观察点测试钉住）。
- 测试：feature 8 个新用例（含包装重放、幂等巧合、cutoff 豁免）+ 前端碰撞契约用例（createTreeWalker 观察点）；对 rollback 豁免、幂等谓词、前端重放跳过做了移除变异，对应测试均按预期失败。
- 修订（2026-11-15）：前端曾注册的 rail「标注」面板（列表 + dormant「接续前」徽标 + scrollToAnnotation 定位）经查从未可达——注册元数据无 icon，rail 按钮自注册表派生后不为其生成按钮，历史上也无任何打开路径——已整体移除（代码与 CSS）；本决策的 dormant 数据语义（保留、不参与匹配、显式删除）不变。
