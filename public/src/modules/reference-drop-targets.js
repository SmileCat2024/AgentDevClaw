/**
 * reference-drop-targets.js — 会话/主题两类引用共用的投放目标判定与共享状态源
 *
 * 为什么是独立模块（而不是 topic-reference-picker 直接 import
 * session-reference-picker）：persistent-input 对 SessionReference 命名空间
 * 刻意保持晚绑定（`window.SessionReference?.`），测试夹具经 globals 注入
 * 替身；session-reference-picker 模块求值有顶层 `window.SessionReference = …`
 * 副作用，任何静态 import 都会把副作用拉进导入方静态图，覆盖注入的替身。
 * 共享逻辑下沉到本无副作用模块，两个 picker 各自 import，单一实现不复制。
 *
 * 导出（全部纯函数 / 无 window 赋值）：
 *   composerCardFromEvent / sidebarItemFromEvent / sidebarItemIdentity /
 *   sidebarItemTitle / clearDropTargetHighlights — 投放目标定位（同 selectors、
 *   同禁用/远程排除，两类引用的 drop 行为保持一致）
 *   activeReferenceKey — 附件类会话态的组合 key 权威实现（共享 lastKnown）
 *   notifyReferencePreviewChanged — 附件预览重渲染通知（晚绑定）
 */

import { currentRuntimeAgentId } from './orchestration-state.js';
import { getRuntimeWorkspaceSessionId } from './identity.js';

// ── 会话 key（原实现迁移自 session-reference-picker，语义与注释原样保留）──
// key 必须在挂载/提交/渲染三个时刻读出同一值：
//   - currentRuntimeAgentId：同步全局，switchAgent / loadAgentData 同步写入；
//   - getRuntimeWorkspaceSessionId(runtimeId)：读 viewer 绑定（switchAgent /
//     open_session 时同步冻结），共享 runtime 下切会话时 sessionId 变化。
// 禁用 dataset.sessionKey 与 getRuntimeContextKey 作 key：前者被轮询渲染的
// syncPersistentComposerSessionCard 周期性重写，后者派生自异步 allAgents，
// 两者都会在三个时刻之间漂移，导致 consume 读空桶（metadata 丢失）而
// chipsHtml 渲染又漂回有引用的桶（pill 残留）。
let _lastKnownRefKey = null;

export function activeReferenceKey() {
  const runtimeId = String(currentRuntimeAgentId || '').trim();
  // 会话身份来自 identity 域（P4 T1 起具名 import）。
  const sessionId = runtimeId && typeof getRuntimeWorkspaceSessionId === 'function'
    ? String(getRuntimeWorkspaceSessionId(runtimeId) || '').trim()
    : '';
  if (runtimeId && sessionId) {
    _lastKnownRefKey = `${runtimeId}::${sessionId}`;
    return _lastKnownRefKey;
  }
  if (runtimeId) {
    // sessionId 尚未冻结（会话加载窗口期）：暂以 runtime 归档，绑定就位后
    // 首次读取自然迁移到组合 key。
    _lastKnownRefKey = runtimeId;
    return runtimeId;
  }
  return _lastKnownRefKey || 'default';
}

export function composerCardFromEvent(event) {
  const target = event.target;
  if (!(target instanceof Node)) return null;
  return target.closest && target.closest('.user-input-card');
}

/**
 * 侧栏运行中会话条目（投放目标）。远程条目（ctx-variant=remote）与
 * 禁用/过渡态条目（data-agent-disabled=true，含正在关闭、交接、删除）
 * 不接收投放。
 */
export function sidebarItemFromEvent(event) {
  const target = event.target;
  if (!(target instanceof Node) || !target.closest) return null;
  const item = target.closest('.agent-runtime-item');
  if (!item) return null;
  if (item.dataset.ctxVariant === 'remote') return null;
  if (item.dataset.agentDisabled === 'true') return null;
  return item;
}

/** 侧栏条目的会话身份（条目 data-agent-id 是 runtimeId，寻址用二元组）。 */
export function sidebarItemIdentity(item) {
  return {
    runtimeId: String(item?.dataset?.agentId || '').trim(),
    agentId: String(item?.dataset?.ctxNs || '').trim(),
    sessionId: String(item?.dataset?.ctxSessionId || '').trim(),
  };
}

/** 侧栏条目标题（首文本节点，避开「正在关闭」等过渡标签），与 dragstart 读法一致。 */
export function sidebarItemTitle(item) {
  const nameEl = item?.querySelector?.('.agent-name');
  return (nameEl?.childNodes?.[0]?.textContent || '').trim();
}

export function clearDropTargetHighlights() {
  document.querySelectorAll('.session-ref-drop-target').forEach(el => el.classList.remove('session-ref-drop-target'));
}

export function notifyReferencePreviewChanged() {
  // 引用 key 随会话切换（input-composer 的 syncPersistentComposerSessionCard
  // 更新 dataset.sessionKey）后，附件预览必须按新 key 重渲染，否则旧会话的
  // pill 残留显示（DOM 不刷新）。_renderAttachmentPreview 定义于
  // persistent-input.js（仍 classic，window 属性可达），收敛批次改为 import。
  if (typeof window._renderAttachmentPreview === 'function') window._renderAttachmentPreview();
}
