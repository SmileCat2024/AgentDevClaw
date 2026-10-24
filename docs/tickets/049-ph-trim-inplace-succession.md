# 049 · 手动精简对话内接续（PH 线程驱动 · 第二批）

状态：done（2026-10-24）
上游：[ADR-0032](../../adr/0032-programming-helper-thread-driven.md) · [批次总入口](2026-10-24-ph-thread-driven.md) · 前序 [048](048-ph-thread-host-declaration.md)

## 背景与目标

048 已声明 `threadHost: true` 并接线服务端事务与前端通用件（等待表面、重绑、收件箱、只读挂载均已声明即激活）。本票处理 PH 独有的产品面差异：手动精简的提交路径。

现状：`trim-page.js` 提交成功后按 `result.agent`（successor runtime）执行 `requestSwitch` 完整导航切换——Session 时代的跳转式体验（页面重载、滚动丢失、列表碎片）。

目标：线程会话上提交精简后**视图不切换**，交给通用接续链路接管：

```
提交 → 服务端 succession（挡板 → 旧 runtime 退役 → successor READY → head 推进）
     → 前端 /responses 404 → 接续退役窗口 → 顶栏「上下文接力中…」
     → SSE head-advanced → _rebindConversationToThreadHead 原地重绑（滚动/草稿不动）
```

coder/memo 无手动精简入口，此路径为 PH 独有产品面；通用链路（thread-store 唯一重绑实现、input 收件箱、事实对账）全部复用，不新写。

## 交付边界

1. `trim-page.js` 提交执行：线程分支（`getThreadForSession` 命中且目标为 head）不 `requestSwitch`；非线程会话（存量未迁移）维持现状跳转，行为不变。
2. 提交后的页面收尾（精简配置页关闭、sidebar operation 记账、归档乐观回滚）在两种分支下各自收敛。
3. 文案语义更新：slash `/trim` 确认文案、右键精简/摘要菜单项——线程会话上不再说「创建新会话」，改「精简后继续当前对话」口径；非线程会话文案不变。
4. 端到端验收（隔离环境）：新建对话 → 发消息 → 精简提交 → 断言视图不切换、等待表面出现、head 推进后重绑、输入投递到新 head。前置：隔离数据目录补最小模型预设（048 冒烟发现的缺口：runtime 启动依赖 modelName）。

## 验收标准

- 线程会话精简提交后：无 `requestSwitch` 导航；聊天视图身份保持；顶栏接力提示出现并于 head 推进后消失；消息数据源重绑至 successor（SSE 或对账路径均可达）。
- 精简期间输入：进入 Thread Inbox，新 head READY 后投递（复用通用件，验收确认 PH 路径可用）。
- 非线程存量会话：精简行为与 048 前完全一致（跳转式），回归无变化。
- 隔离端到端脚本全过；`npm run test:core` 无新增失败（既有遗留 `ph-project-selector-ui` 除外）。

## 实施记录

- **评估结论**（复用面）：coder/memo 的接续体验全部是线程事实驱动的通用件（等待表面、唯一重绑实现、输入收件箱、只读挂载、SSE 事件发现与轮询对账），048 声明即激活，本票零重做。PH 独有作业仅两处产品面差异：手动精简的提交跳转路径（coder/memo 无手动入口，路径本就独属 PH）与 PH 会话列表聚合（050）。
- **代码改动**（2026-10-24）：
  - `public/src/modules/trim-page.js`：提交响应段新增线程分支——`result.threadSuccession.applied === true` 时不 `requestSwitch` 导航，`finishSidebarOperation('settled')` + `clearSessionLoading` + `refreshThreads(true)` 交由事实对账经 thread-store 唯一重绑原地换头；非线程响应原路径不变（含远程分支与 navGuard 早退）。
  - `public/src/modules/workspace-actions.js`：`compact_session_menu`（slash /trim /summary、右键摘要入口）同口径线程分支（含归档失败 toast、成功 toast、loadAgents 收敛）；`/summary` 确认文案按线程语义分支。
  - `public/src/modules/slash-commands.js`：`/trim` 确认文案按线程语义分支（「继续本对话 / 记录自动存档」vs「创建新会话继续」），判定复用 `isThreadHostAgentId`，索引未就绪保守回落 Session 文案。
- **判据来源**：服务端 compact_and_resume 同步路径响应携带 `threadSuccession`（`server/routes/session.js`，非线程会话为 `{applied:false, reason:'no_thread_for_session'}`）；前端此前零消费，本票为首个消费方。
- **测试**：`test/frontend-trim-page.test.js` 新增提交路径双用例（VM 沙箱驱动真实源码）——线程接续响应：不导航（requestSwitch/beginChatLoadingSession 零调用）+ 对账触发 + loading 清除 + 操作收敛；非线程响应：维持跳转导航（回归保护）。破坏验证通过：临时禁用线程分支，用例即失败（"must not navigate"），还原后 16/16 全过。
- **回归**：`test:core` 5028 用例 fail=1，唯一失败为 `ph-project-selector-ui` 遗留（stash 对照：去掉 049 改动仍失败，HEAD 既有，与 048 批为同一处）。
- **端到端冒烟**：`.tmp/smoke-049.sh`（隔离数据目录 + 拷贝本机模型预设 + key 型默认模型），12/12 全过：建线 → runtime 存活 → 真实 LLM 轮次（消息投递经 Thread Inbox 即时投递）→ 精简预览 1 轮 → 全量精简提交 → `threadSuccession.applied=true` → successor 生成 → 原会话归档 → 线程 head=successor 且含两代 → 退役会话输入被拒（HTTP 409 `session_not_head`，历史只读并引导至当前 head，ADR-0032 语义）。服务端日志同步印证 trim 全 phase 与 `head advanced`。
- **验证边界**：浏览器层未走真实 UI 提交（VM 沙箱已覆盖前端逻辑分支：不导航、对账触发、loading 清除）。用户重启服务后在真实界面提交一次精简即可完成该层确认。
