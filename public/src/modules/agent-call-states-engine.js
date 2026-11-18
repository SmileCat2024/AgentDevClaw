/**
 * agent-call-states-engine.js — call 状态对账引擎（唯一实例）
 *
 * P4 T2 收尾批次：原 `app-main.js` 顶层 IIFE `bootstrapAgentCallStates` 逐字搬出。
 * 搬出是 B1 的解：IIFE 在 classic 解析相调用 `createAgentCallStatesHost()`（定义于
 * sidebar-render，本批迁入模块相）并在装载期读 `_agentSuspended`（runtime-status，
 * 同上），模块未求值 → ReferenceError 让 app-main 余下语句（visibilitychange 与
 * `await __clawAuthReady → startApplication()`）全部不执行，整页不启动。
 *
 * 现在的相位：本模块由 p4-entry.js 静态 import，在模块相求值（宿主工厂
 * createAgentCallStatesHost 由 sidebar-render 具名导出）。它建立的两个桥键
 * （`agent-call-states` 域）与
 * `window.ClawFW.CallStates` 协议面与搬出前**完全一致**——classic 消费方
 * （app-main 的 visibilitychange 全量对账、sidebar-render 的 pruneCallStates /
 * refreshCalls 适配面）语义不变。
 *
 * 引擎体逐字保留（只把 app-main 词法内的 `createAgentCallStatesHost()` 改为
 * 具名 import）：容器引用（calling / suspended / interrupting / finished）来自
 * sidebar-render 的宿主工厂，宿主能力面同前。
 */

import { createAgentCallStatesHost } from './sidebar-render.js';

// Sidebar call-state reconciliation. SSE-owned locals are not absent/idle;
// online remote runtimes still require polling. Maps are shared with classic UI.
function createAgentCallStates(host) {
  let inProgress = false;
  const { calling, suspended, interrupting, finished } = host;

  function collectActiveCallRuntimeIds(agents) {
    const ids = (Array.isArray(agents) ? agents : []).filter((agent) => agent?.connected)
      .map((agent) => host.runtimeId(agent)).filter(Boolean);
    for (const entry of host.remoteEntries()) {
      if (entry.status === 'connected' && entry.runtimeId) ids.push(entry.runtimeId);
    }
    return Array.from(new Set(ids));
  }

  function applyAgentCallStateFromNotification(runtimeId, data) {
    const payload = data && typeof data === 'object' ? data : null;
    const backendCalling = host.resolveCalling(payload) === true;
    const prevCalling = calling.get(runtimeId) === true;
    const prevSuspended = suspended.get(runtimeId) === true;
    const effectiveCalling = backendCalling && !host.isInterruptSuppressed(runtimeId, host.callStartedAt(payload));
    let nextSuspended = prevSuspended;
    if (effectiveCalling) {
      host.markStarted(runtimeId);
      calling.set(runtimeId, true);
      suspended.delete(runtimeId);
      nextSuspended = false;
    } else {
      calling.delete(runtimeId);
      nextSuspended = host.isSuspended(payload);
      if (nextSuspended) suspended.set(runtimeId, true);
      else suspended.delete(runtimeId);
    }
    if (!backendCalling) host.clearInterrupt(runtimeId);
    if (prevCalling && !effectiveCalling && host.normalize(runtimeId) !== host.normalize(host.currentRuntimeId())) {
      finished.add(runtimeId);
    }
    if (prevCalling !== effectiveCalling && host.normalize(runtimeId) === host.normalize(host.currentRuntimeId())) {
      host.syncActionButton();
    }
    return prevCalling !== effectiveCalling || prevSuspended !== nextSuspended;
  }

  function applyCallStateToAgentRecords(runtimeId, active, agents = host.agents()) {
    let changed = false;
    for (const agent of Array.isArray(agents) ? agents : []) {
      if (agent?.source === 'prebuilt' || host.runtimeId(agent) !== runtimeId) continue;
      const next = active === true;
      if (agent.callActive !== next) { agent.callActive = next; changed = true; }
    }
    return changed;
  }

  function cleanupOrphanCallStates(activeIds) {
    let changed = false;
    for (const key of Array.from(calling.keys())) {
      if (!activeIds.has(key)) {
        calling.delete(key); interrupting.delete(key); finished.delete(key); suspended.delete(key);
        changed = true;
      }
    }
    for (const key of Array.from(suspended.keys())) {
      if (!activeIds.has(key)) { suspended.delete(key); changed = true; }
    }
    return changed;
  }

  function cleanPrebuiltHostRows(agents) {
    let changed = false;
    for (const agent of Array.isArray(agents) ? agents : []) {
      if (agent?.source === 'prebuilt' && agent.callActive) { agent.callActive = false; changed = true; }
    }
    return changed;
  }

  async function refreshAgentCallStates(agents = host.agents(), options = {}) {
    const { force = false, reuseNotification = null, includeSseLocals = false } = options;
    if (inProgress) return;
    const now = host.now();
    if (!force && now - host.lastRefresh() < 1000) return;
    inProgress = true;
    host.setLastRefresh(now);
    try {
      const ids = collectActiveCallRuntimeIds(agents);
      const skipLocal = host.isSseActive() && !includeSseLocals;
      const polled = skipLocal ? ids.filter((id) => host.isRemote(id)) : ids;
      if (!polled.length) {
        if (skipLocal) {
          let changed = cleanupOrphanCallStates(new Set(ids));
          changed = cleanPrebuiltHostRows(agents) || changed;
          if (changed) host.render();
          return;
        }
        let changed = false;
        for (const key of Array.from(calling.keys())) {
          calling.delete(key); interrupting.delete(key); suspended.delete(key); changed = true;
        }
        for (const key of Array.from(suspended.keys())) { suspended.delete(key); changed = true; }
        if (changed) host.render();
        return;
      }
      const payloads = new Map();
      await Promise.all(polled.map(async (id) => {
        try {
          if (reuseNotification?.payload && host.normalize(reuseNotification.runtimeId) === host.normalize(id)) {
            payloads.set(id, reuseNotification.payload);
            return;
          }
          const response = await host.fetch(`/api/agents/${encodeURIComponent(id)}/notification`);
          if (response.ok) payloads.set(id, await response.json());
        } catch {
          // Existing contract: a failed observation is applied as a null payload.
        }
      }));
      let changed = false;
      for (const id of polled) changed = applyAgentCallStateFromNotification(id, payloads.get(id) || null) || changed;
      changed = cleanupOrphanCallStates(new Set(ids)) || changed;
      const byPolled = new Map();
      for (const id of polled) {
        const payload = payloads.get(id) || null;
        byPolled.set(id, host.resolveCalling(payload) === true
          && !host.isInterruptSuppressed(id, host.callStartedAt(payload)));
      }
      const activeIds = new Set(ids);
      for (const agent of Array.isArray(agents) ? agents : []) {
        if (agent?.source === 'prebuilt') continue;
        const id = host.runtimeId(agent);
        if (!id || (skipLocal && activeIds.has(id) && !host.isRemote(id))) continue;
        changed = applyCallStateToAgentRecords(id, byPolled.get(id) === true, agents) || changed;
      }
      changed = cleanPrebuiltHostRows(agents) || changed;
      if (changed) host.render();
    } finally {
      inProgress = false;
    }
  }

  return { collectActiveCallRuntimeIds, applyAgentCallStateFromNotification,
    applyCallStateToAgentRecords, cleanupOrphanCallStates, cleanPrebuiltHostRows, refreshAgentCallStates };
}

// interrupt 的四个访问器由 app-core 尾部的同步引擎先注册（同一页内更早的 classic
// 脚本）；缺任何一个都在装载期响亮失败，不静默跑半套。（槽位仍是 app-core 的
// call-interrupt domain 桥键；ESM 侧经 call-interrupt-host 的晚绑定适配面取用。）
const callStartedAt = window.getNotificationCallStartedAt;
const isInterruptSuppressed = window.isInterruptSuppressed;
const clearInterrupt = window.clearInterruptSuppression;
if (typeof callStartedAt !== 'function' || typeof isInterruptSuppressed !== 'function'
  || typeof clearInterrupt !== 'function') {
  throw new Error('[P2] call-interrupt classic sync owner missing');
}
const states = createAgentCallStates({
  ...createAgentCallStatesHost(),
  callStartedAt,
  isInterruptSuppressed,
  clearInterrupt,
});

export const {
  collectActiveCallRuntimeIds,
  applyAgentCallStateFromNotification,
  applyCallStateToAgentRecords,
  refreshAgentCallStates,
} = states;

window.KernelState.defineKey('agent-call-states', 'collectActiveCallRuntimeIds', states.collectActiveCallRuntimeIds);
window.KernelState.defineKey('agent-call-states', 'refreshAgentCallStates', states.refreshAgentCallStates);
window.ClawFW = window.ClawFW || {};
window.ClawFW.CallStates = Object.freeze({
  collectActiveCallRuntimeIds: states.collectActiveCallRuntimeIds,
  applyAgentCallStateFromNotification: states.applyAgentCallStateFromNotification,
  applyCallStateToAgentRecords: states.applyCallStateToAgentRecords,
  refreshAgentCallStates: states.refreshAgentCallStates,
});
