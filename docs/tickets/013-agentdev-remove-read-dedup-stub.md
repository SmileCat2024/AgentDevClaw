# 013 — 移除 read 工具的 file_unchanged 去重短路（加急）

- **仓库**：AgentDev（`D:\code\AgentDev`）
- **决策依据**：2026-08-21 coder 运行质量审计（会话 79761-146c84 与
  80590-8e766c 双会话实测踩坑，人类操作者同样命中）；移除方向已拍板
- **类型**：行为修正（正确性优先于 token 优化）
- **优先级**：**加急**——每次长会话都在真实发生误判

## 背景

`src/features/opencode-basic/tools.ts` 的 read 工具存在去重短路：同一文件
同一 offset/limit 范围 + mtime 未变 → 返回 `file_unchanged` stub（无内容）。
判定状态 `readDedupState` 是模块级 Map，**跨 call / 跨 turn / 跨会话存活**
（runtime 复用时甚至跨线程会话），但从不校验模型上下文里是否仍持有该内容。

实测危害（三个独立样本）：

1. 会话 146c84：002 票面读取被误判已读，模型拿到空 stub；
2. 会话 8e766c：`handoff-package.js` 读取命中，模型被迫自述
   "force a re-read" 并用先 edit 改 mtime 再 read 的 hack 自救，多花工具往返；
3. 2026-08-21 人类操作者经 read 工具读 007 票面，同样收到 file_unchanged
   （内容不在其有效上下文中）。

省 token 的收益远小于正确性损失：模型对"读过"的信任被系统性破坏，
长会话与精简接力场景必然复发。

## 关键边界：readDedupState 双职责，只移除其一

`readDedupState` 同时是两套机制的数据源，**只移除去重短路，写保护不动**：

| 机制 | 位置 | 处置 |
|------|------|------|
| 去重短路（本票移除） | tools.ts:437-457 dedup 命中返回 stub；:91 `FILE_UNCHANGED_STUB` | **删除** |
| 先读后写保护 + staleness 校验 | write（:564 起）/ edit（:1127 起）以 `readDedupState` 判定"已读过"与 mtime 一致性 | **保留，零改动** |
| 读取记录 | read 成功路径 `readDedupState.set(...)`（:503） | **保留**（写保护依赖） |
| 状态序列化 | index.ts captureState/restoreState（:119-126）与 Claw `ContinuityAwareOpencodeBasic` 的 continuity 转移 | **保留** |

移除后 read 每次返回完整内容，`set` 记录像现在一样照常写入。

## 执行步骤

1. `tools.ts`：删除 dedup 命中短路分支（437-457）与 `FILE_UNCHANGED_STUB`
   常量；read 主路径与其余逻辑不动。
2. 残留核查：框架全库 grep `file_unchanged` / `FILE_UNCHANGED_STUB` 零命中；
   `readDedupState` 剩余引用仅限 set 记录 / 序列化 / write-edit 写保护。
3. 测试面核实：src/test 下预核无直接断言 file_unchanged 的用例；执行时
   复查行为测试（如连续两次 read 同一文件的用例，断言应改为返回完整内容
   或删除）。
4. `npm run build` + 框架测试全绿。
5. Claw 侧验证（junction 消费，**整服重启**）：同一文件二次 read 返回完整
   内容；读一次后 write/edit 不被先读后写保护拦截（保护仍生效的反向确认：
   未读直接 write 仍被拒绝）。

## 验收标准

- 框架 build + 测试全绿；步骤 2 的 grep 零残留。
- Claw 冒烟：二次 read 全量返回 + 先读后写保护双方向（未读拒写 / 已读可写）。

## 风险提示

- token 消耗回归（重读全量返回）——已接受，正确性优先。
- 与 007 并行：改动面不重叠（本票只动 `src/features/opencode-basic/tools.ts`，
  007 在 `src/core/workthread` 等），但同仓库工作树被 007 持有中——
  **在 007 提交后执行**，或独立分支 cherry-pipe，避免工作树互相覆盖。
