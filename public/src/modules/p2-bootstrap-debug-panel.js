/**
 * P2 bootstrap 消费接口适配 —— 右栏 debug 面板状态。
 *
 * classic 唯一实现：public/src/app-core.js 的
 * createP2BootstrapDebugPanelHost()。日志快照/签名/截断信息、MCP 信息、
 * overview 生命周期与 feature/仓库检索选择成对提供 get/set；logFilters 是只读
 * 引用（classic 侧按字段就地赋值，见 app-ui 的 updateLogFilter）。
 *
 * 消费方（P2 转换后 import）：debug-logs / overview-data / debug-mcp /
 * debug-overview / debug-features-hooks / workspace-blocks /
 * debug-summary-upload。
 *
 * 撤除（P3）：以上消费方全部迁移、debug 面板状态 owner 迁入 ESM 后，删除本
 * 模块与 classic 工厂。
 */
export const debugPanel = window.createP2BootstrapDebugPanelHost();
