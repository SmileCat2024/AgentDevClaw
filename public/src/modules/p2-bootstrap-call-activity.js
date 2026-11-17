/**
 * P2 bootstrap 消费接口适配 —— call 活动状态。
 *
 * classic 唯一实现：public/src/app-core.js 的 createP2BootstrapCallActivityHost()。
 * 运行中 / 刚完成 / 已提醒 / 自动标题已触发的容器是 classic 顶层 const Map/Set，
 * 按引用交出：消费方继续用既有 .get/.set/.delete/.add/.clear 语义，引用身份与
 * 清理循环共享（sidebar-render 的 pruneCallStates 读同一容器）。
 * _lastInterruptUserActionAt 成对提供 get/set。_lastChoiceAlertCheckAt 有意
 * 不在本域：它已由 createPollCycleHost 转发给 ESM 轮询，同一键不设第二个兼容面。
 *
 * 消费方（P2 转换后 import）：runtime-status / persistent-input / sidebar-render /
 * app-main / input-helpers / voice-input / generative-ui-panel /
 * remote-connections / sse-client / auto-title / desktop-notify / todo-plan /
 * app-ui。
 *
 * 注：_agentCallActive / _recentlyFinishedRuntimes 另经
 * createAgentCallStatesHost（sidebar-render）供 agent-call-states ESM 使用；
 * 同一容器，不构成双存储。
 *
 * 撤除（P3）：以上消费方全部迁移、call 状态 owner 迁入 ESM 后，删除本模块与
 * classic 工厂。
 */
export const callActivity = window.createP2BootstrapCallActivityHost();
