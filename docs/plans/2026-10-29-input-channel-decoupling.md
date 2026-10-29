# 实施计划：正常输入与输入租约解耦（ADR-0035）

- 日期：2026-10-29
- 决策依据：[ADR-0035](../adr/0035-input-channel-decoupling.md)
- 状态：未实施

## 总体形态

协议层（框架 viewer、宿主 inputLoop、server 网关）零改动；改动全部在 Claw 前端，以删除为主。分三阶段推进，每阶段独立可验收、可回退（阶段一为行为切换点，二、三为删除与清理）。

## 阶段一：composer 端点统一（行为切换）

**改动**

1. `input-composer.js` `resolveInputSurfaceMode`：删除第 7 级 `hasRequests → 'requests'` 判定，非 choice 输入请求不再触发模式切换（choice 第 5 级、frozen / compacting 等前置级保留）。
2. 空闲 lease 回填（`delivery: 'input'`）的反馈等价性锁定：现 else 链（`persistent-input.js` 直投分支）已覆盖乐观回显、calling 态标记、立即轮询；新增断言测试固化三项，防后续重构回归。
3. lease 伴生反馈迁移（随模式退役立即失去触发点，必须与本阶段同批）：`_notifyLeaseActionError`（输入动作失败 toast）的调用点从 `renderRequestComposer` 搬到 persistent 渲染主干；lease `initialValue`（宿主 `setNextDraftInput` 回传的 rollback 草稿）在 persistent composer 按 requestId 去重回填，仅当前无草稿时写入，不覆盖用户输入。
4. choice 挂起竞态窗口收到 409 `input_mode_conflict` 时，前端呈现"请先完成选择"提示，不静默失败；composer 隐藏不销毁，已敲文本原地保留。
5. 语音输入、slash 激活等提交入口复查：确认全部经 `submitQueuedInput`，无残留 `/input` 文本提交调用（语音 requests 分支在阶段二前已无触发路径）。

**验证**

- `test/frontend-input-convergence.test.js` / `frontend-input-composer.test.js`：requests 模式断言迁移为"空闲 lease 挂起时 composer 仍为 persistent 端点"。
- 新增行为锁定：vm 驱动 `submitQueuedInput`，stub 服务端返回 `delivery: 'input'`，断言走 user-turn 端点且清理语义不变（复用 `test/thread-direct-input-images.test.js` 的 harness 模式）。
- 场景手测清单：空闲发言（含图片）、calling 排队、choice 问答、rollback / compact（含失败提示与草稿回填）、语音输入（persistent 路径）、PH 线程域、memo 唯一活动线程、coder 线程列表。

**回退边界**：本阶段只动模式判定与端点选择，`submitInput` 编排仍在（无调用方），回退 = 恢复矩阵第 7 级。

## 阶段二：requests 模式与翻转逻辑退役（删除）

1. `input-composer.js`：`applyComposerMode` 的 requests 分支（函数收敛为 persistent 语义）、`readInputSurfaceModeState` 的 `hasRequests` 状态源、lease footer 渲染（现状 `NEXT_TURN_ACTIONS` 仅 rollback / compact，均被动作过滤契约滤除，footer 恒空，无功能损失）、`_composerMode` / `_composerRequestId` 翻转状态。
2. `input-render.js`：requests 渲染分支三处（`getInputRenderSignature` 的 requests 分支、`renderInputRequests` 渲染分支、`renderRequestComposer` 整体——伴生反馈已在阶段一迁出）。
3. `input-helpers.js`：`_submitInputInner`、`_submitInputViaThread`（仅被前者调用）、`submitInput` 与 `handleInputKey` 的 request 端点绑定。**保留**：`submitInputAction`（rollback / compact action 回填）、`autoResize`、rollback 查询纯函数。
4. `voice-input.js`：requests 提交分支（`targetId.startsWith('input-')` 路径）与 `_shouldPreserveVoiceInputForRender` 的 `'requests'` 枚举项；`app-chat-input.js` 对 `submitInput` 语义的注释引用同步更新。
5. `rollback-dialog.js`：仍消费 `inputRequests` 快照与 `lease.requestId`（`submitInputAction` 路径不变），仅删除对 requests 模式输入面的依赖假设。
6. 全库 grep 复核：`submitInput(`/`'requests'` 无残留引用（`submitInputAction` 除外）。

**验证**：全量前端 vm 测试 + 场景手测清单复跑；`npm run check:cycles` 无新增环。

## 阶段三：观察窗口后清理

- 观察窗口（建议一个常规迭代周期）无输入链路回归后，删除 `input-helpers.js` 内已无调用方的辅助残骸与相关 i18n 文案。
- 同步文档：`docs/reference/frontend-rendering-patterns.md` 输入面章节、[AGENT.md](../../AGENT.md) 相关描述、本计划与 ADR 状态改 Accepted（已实施）。

## 风险与观察点

- **空闲发言的服务端路径变化**：从 `/input` 直填 lease 变为 `/user-turn` → viewer 转 lease 回填。对 inputLoop 透明，但排查输入问题时路径认知需更新（ADR-0035 后果节已声明）。
- **lease 伴生反馈的触发时机**：动作失败 toast 与草稿回填迁移到 persistent 渲染主干后，lease 广播到达时 composer 可能因 choice / frozen / compacting 处于其它模式——查收逻辑须放在渲染主干（任何模式路径都过），或明确接受延迟到下一轮 persistent 渲染，不得只在 persistent 分支内查收。
- **lease 广播事件序**：composer 不再依赖 `input-requests` 事件切模式，但 rollback 按钮可见性仍读 `inputRequests` 快照——确认事件订阅面完整保留。
- **草稿与焦点**：模式翻转消失后，翻转窗口的焦点 / IME / 草稿写回边界问题整体消失；注意 `syncPersistentComposerSession` 的会话重绑路径不再有模式参与，行为回归确认。
- **旧会话恢复**：刷新页面时若有挂起的文本 lease（inputLoop 在等），恢复后的输入面恒 persistent——发言经 user-turn 回填，与旧行为（requests 模式）等价，手测覆盖。
