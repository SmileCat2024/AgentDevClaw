// ESM 装载入口：P2 第二波批次 3b「输入面消费方」。
//
// 静态 import 的求值顺序（深度优先、按声明顺序）就是本批的执行顺序：
//   1. p2-w2-3b-rollback-domain —— 部分压缩 / 回退对话框域 owner：claim 吸收
//      classic rollback-dialog.js 在 classic 相注册的五个状态键真初值，并注册
//      compact 记账的行为桥键（readPartialCompactStartedAt /
//      writePartialCompactStartedAt / clearPartialCompactState）。
//   2. input-actions —— 输入面动作提交与回退/压缩动作可用性（原 input-helpers.js
//      的非首屏实现）：注册 updateRollbackActionVisibility / canRollbackMessage /
//      autoResize 三个 classic 兼容键。
//   3. chat-process-visibility —— 过程显隐：注册 applyConversationProcessState /
//      toggleChatProcessVisibility 两个 classic 消费方桥键（函数值原样转发）。
//   4. rollback-dialog-runtime —— 回退/压缩对话框与运行期回退编排（原
//      rollback-dialog.js 的对话框与运行时部分）：rollbackLeaseTiming 为模块
//      私有（400ms / 30s），requestRollbackEdit 经桥键服务 chat-renderer。
//   5. choice-input —— Choice Input 卡片整域（谓词 + 交互 + 提交）：三个跨文件
//      函数与 isChoiceInputConsumed 都有命名导出，四个键经桥服务 classic 消费方；
//      选择卡草稿状态是模块私有（app-core 不再持有 / 不再有 bootstrap 宿主）。
//   6. app-chat-input —— APP 首页快记输入框整域转为 ESM（自身状态模块私有），
//      依赖 3a 的 composer / voice 状态 owner 与 toast / loadAgents 的 ESM 导出，
//      装载时经 import 链一并 claim。
//
// 接线（index.html 属主助手权限）：本批新增的 ESM 文件不再有 classic 标签；
// choice-input.js 由 classic 标签转为 ESM（须删除该 classic 标签，改由本入口
// import 带入）。input-helpers.js 与 rollback-dialog.js 仍是 classic 文件
// （各留唯一首屏同步实现 / 同步注册壳），标签保留。
//
// ── 仍留在 classic 的输入面实现（下一批联合迁移，勿据本入口判定输入面已迁完）──
//   - input-render.js：整个渲染入口（`renderInputRequests` / `notifyInputSurfaceChanged`
//     / `getInputRenderSignature` / lease 伴生反馈）。**真实 R1**：`app-main.js` 顶层
//     `applyLanguage()` → `renderCurrentMainView()` → `app-ui.js` 里
//     `notifyInputSurfaceChanged(viewState.inputRequests)` 是**无条件**同步调用
//     （agent 记录为空、消息为空时同样执行），不能在 deferred 相之前失去实现。
//   - input-helpers.js：`updateChatProcessToggle` 属**真实 R1**——同一
//     `renderCurrentMainView` 的三个分支（workspace surface / 空消息 / 正文）都在
//     `typeof` 守卫后执行它。
//   - input-model-switcher.js：两个切换器全链路，无首屏触达，具备迁移条件。
import './p2-w2-3b-rollback-domain.js';
import './input-actions.js';
import './chat-process-visibility.js';
import './rollback-dialog-runtime.js';
import './choice-input.js';
import './app-chat-input.js';
