# 048 — threadHost 声明与服务端线程域接线

状态：已实施并完成定向验收；整批端到端验收见 [总入口](2026-10-24-ph-thread-driven.md)；原则性决策见 [ADR-0032](../adr/0032-programming-helper-thread-driven.md)。遗留说明：`test:core` 存在一条与本案无关的既有失败（`ph-project-selector-ui.test.js`「托管显式选择」空态渲染，stash 对照复现于 HEAD）。

## 目标

编程小助手声明 `threadHost: true`，新会话（目录对话与项目对话，含 branch）自动建立线程；服务端线程域（建线、接续挡板、head 推进、删除守卫、输入网关、SSE 事件）对 PH 生效；手动精简入口按新口径保留；041–047 交付物（会话移动、项目改绑）补线程域 busy 判定。

## 现状与缺口

- 服务端钩子链已通用接线，声明即生效，无服务端编排改动：[server.js](../../../server.js) 启动按 metadata `threadHost` 派生注册宿主集合；[session.js](../../../server/routes/session.js) 的创建（含 branch）调 `onSessionCreated`、compact/trim/summary 端点已接线 begin/apply/failSessionSuccession（含 K14 非 head 拒绝与 R8 旧 head 退役）、删除端点已接 `assertSessionDeletable`；[input-gateway.js](../../../server/thread-control/input-gateway.js) 按「会话是否真有线程」路由——混合期存量会话天然 direct 直投，行为与现状一致。
- 前端 `/protoclaw/threads` 拉取为全局（不按 APP 过滤），PH 线程将进入 `sessionIndex`；[slash-commands.js](../../../public/src/modules/slash-commands.js) 的手动命令谓词现状「线程宿主会话一律隐藏」（coder 口径），对 PH 会误伤——必须按 ADR-0032 决策 2 调整为「自动接续 APP 隐藏；手动接续 APP 保留」。
- 缺口：`movePhSessions` / `rebindPhProject` 的 busy 探测只看「存活 runtime」（callActive / queued inputs），线程域活跃态在 runtime 缺席时探不到——接续窗口（rotating：旧 head 已退役、successor 未 READY）与 Inbox 待投递（pending-commands）。此时放行会与 succession 事务竞态（归属落盘与 head 推进交错）。修复：注入 `findThreadBySession`（生产装配层），`synthesizeThreadLifeState`（boardState 传 null——board 级执行中必然伴随存活 runtime，由既有 probe 拦截，此处只补线程域独有信号）判定 executing / pending-commands 拒绝；未注入（既有测试装配）跳过，不引入线程控制面初始化副作用。

## 实施

1. PH metadata 加 `threadHost: true`（位置对齐 coder 声明形态）。不声明 `maxLiveThreads`、不声明接续策略（ADR-0032 决策 6 与决策 2）。
2. slash 手动命令谓词：`_isThreadCarriedSession` 增加「手动接续 APP（有会话操作产品面）保留」分支，产品面事实源复用 [ctx-menu-items.js](../../../public/src/modules/ctx-menu-items.js) 的 `ctxSessionOpsAllowed`（`CTX_SESSION_OPS_AGENTS` 白名单同义谓词），不新增平行清单。coder / memo（不在白名单，自动接续）行为零变化；agent-studio（白名单内但无线程）行为零变化。
3. `movePhSessions` 与 `rebindPhProject` 在会话域 busy 探测前加线程域判定（同一 helper），拒绝错误沿用各自 busy 错误码（`ph_sessions_busy` / `ph_project_busy`），reason 标注 `thread_executing` / `thread_pending_commands` / `thread_probe_failed`（fail-closed）。
4. [server.js](../../../server.js) 装配层注入 `findThreadBySession`（箭头包装每次调用解析 integration，规避装配期初始化时序）。

## 验收

- 新建对话（目录 / 项目各一）建线且 `projectId` 继承正确（隔离数据目录冒烟：创建响应带 `threadId`，threads 列表含该线程，索引记录归属不变）。
- head 会话删除走 T005 线程域语义：重定向为整线程删除事务（`session_delete_redirect` → `thread_deleted`，级联清理 sessions / handoffs / runtimes / board / archive 全部 complete）；`assertSessionDeletable` 是重定向后的兜底守卫。
- 会话移动 / 项目改绑在线程域拒绝执行中线程（rotating / pending-commands → 409；idle / 无线程 / closed 放行）。
- slash 谓词：PH 线程会话显示 `/trim` `/summary`；coder / memo 线程会话隐藏（既有行为不变）。
- **补丁（2026-10-24，用户反馈）**：PH 声明后侧栏运行中会话的右键菜单被替换为 4 项线程菜单（该分支为 coder 设计，`ctx-menu-items.js` 对带 threadId 的 runtime 叶子整表替换），既有会话操作面（重命名 / AI 标题 / 精简 / 摘要 / 分支 / 待办 / 归档 / 重启 / 关闭 / 删除）全部丢失。修复：手动接续 APP（口径复用 `ctxSessionOpsAllowed` 白名单）的线程会话不替换菜单，落回完整会话菜单并追加线程专属项（复制 Thread ID / 中断线程 / 归档线程）；不另设「删除线程」项——「删除会话」在 head 上的实际行为已是整线程删除（服务端重定向）。coder / memo 维持线程菜单不变。定向用例补入 `test/frontend-thread-ctx-menu.test.js`（PH 菜单完整性含 submenu 子项 / executing 中断可用 / 存量会话无线程项），破坏验证通过。
- 全量 `test:core` 回归通过；外围入口（ACP / CLI / 桌面右键 / 调度 / 群聊）行为无回归——ACP 与调度面向 coder 不受影响；桌面右键与 IM 线路经创建端点与 input-gateway，前者建线、后者对存量会话 direct 直投，均为预期行为。

## 交付边界

本票只做声明与服务端接线验证；精简页提交行为改造、接续等待表面、输入线程寻址的前端改造归 049；列表对话聚合与整链移动 UI 归 050（本票的 move 线程域判定是 050 整链移动的服务端前置，不改变移动语义本身——仍按会话粒度落盘）。真实用户数据不触碰；测试用隔离数据目录。不改 coder / memo 行为，不自行提交或 push。
