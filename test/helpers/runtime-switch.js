import fs from 'node:fs';
import vm from 'node:vm';
import { createRuntimeSwitch } from '../../public/src/modules/runtime-switch.js';

const source = fs.readFileSync(new URL('../../public/src/app-main.js', import.meta.url), 'utf8');
const start = source.indexOf('function createRuntimeSwitchHost()');
const end = source.indexOf('// ── Context menu action handlers', start);
if (start < 0 || end < 0) throw new Error('Runtime switch classic host is missing');
export const runtimeSwitchHostSource = source.slice(start, end);

/**
 * 编排域迁 ESM（P4 T3 收尾）后，`createRuntimeSwitchHost` 的依赖面从「classic 裸
 * 标识符 = 沙箱全局」变成模块级绑定（状态 owner 具名 import + 适配面）。本夹具的
 * createFrontendSandbox 只有 classic 相、装不了 ESM 域，因此按原词法语义把这些
 * 名字重建到沙箱全局：
 *
 *   - 状态槽是可写变量，写入函数转发同一槽位（测试自己 `ctx.run('let ...')` 预置
 *     pendingSwitchTarget / _switchEpoch）；
 *   - 其余能力优先取沙箱里已装载的真实实现（桥键 / 夹具注入），缺席时给最小替身
 *     ——这条路线只用来驱动 runtime-switch 的切换事务，不重测那些实现。
 *
 * 不复制 `createRuntimeSwitchHost` 的函数体：切片的实现仍是生产源码。
 */
const MODULE_SCOPE_SHIM = `
  var setPendingSwitchTarget = (v) => { pendingSwitchTarget = v; };
  var setPendingSwitchSerial = (v) => { pendingSwitchSerial = v; };
  var setSwitchEpoch = (v) => { _switchEpoch = v; };
  var setFocusedAgentId = (v) => { focusedAgentId = v; };
  var setCurrentRuntimeAgentId = (v) => { currentRuntimeAgentId = v; };
  var setReadOnlyMode = (v) => { readOnlyMode = v; };
  var setLastRenderedWorkspaceHtml = (v) => { lastRenderedWorkspaceHtml = v; };
  var setRestoredScrollTop = (v) => { _restoredScrollTop = v; };
  var setCurrentWorkspaceArtifactDetail = (v) => { currentWorkspaceArtifactDetail = v; };
  var setCurrentWorkspaceDocsetDetail = (v) => { currentWorkspaceDocsetDetail = v; };
  var setCurrentProjectDocsetOpen = (v) => { currentProjectDocsetOpen = v; };
  var setCurrentProjectRequirementEdit = (v) => { currentProjectRequirementEdit = v; };
  var setCurrentProjectDocsetPage = (v) => { currentProjectDocsetPage = v; };
  var setCurrentWorkspaceTab = (v) => { currentWorkspaceTab = v; };
  var setLastRenderedChatSig = (v) => { _lastRenderedChatSig = v; };
  var chatSurface = {
    get followLatestEnabled() { return typeof followLatestEnabled !== 'undefined' ? followLatestEnabled : true; },
    get showChatProcess() { return typeof showChatProcess !== 'undefined' ? showChatProcess : false; },
    set showChatProcess(v) { showChatProcess = v; },
  };
  var callActivity = {
    _recentlyFinishedRuntimes: (typeof _recentlyFinishedRuntimes !== 'undefined' ? _recentlyFinishedRuntimes : new Set()),
    _agentCallActive: (typeof _agentCallActive !== 'undefined' ? _agentCallActive : new Map()),
  };
  var _deriveRuntimeSessionIdFromAgents = window._deriveRuntimeSessionIdFromAgents || (() => '');
  var setViewerSessionBinding = window.setViewerSessionBinding || (() => {});
  var getLogicalAgentId = window.getLogicalAgentId || ((agent) => (agent && agent.id) || null);
  var normalizeAgentIdentity = window.normalizeAgentIdentity || ((value) => String(value || '').trim());
  var getRuntimeContextKey = window.getRuntimeContextKey || (() => '');
  var applySessionViewPatch = window.applySessionViewPatch || (() => {});
  var getEmptyOverviewSnapshot = window.getEmptyOverviewSnapshot || (() => ({}));
  var getEmptyTodoPlan = window.getEmptyTodoPlan || (() => ({ tasks: [] }));
`;

// Exercise the real module with the real classic adapter and live VM state.
export function installRuntimeSwitch(context) {
  vm.runInContext(MODULE_SCOPE_SHIM, context);
  vm.runInContext(runtimeSwitchHostSource, context);
  Object.assign(context.window || context, createRuntimeSwitch(vm.runInContext('createRuntimeSwitchHost()', context)));
}
