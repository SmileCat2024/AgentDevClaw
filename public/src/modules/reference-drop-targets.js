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
 * 导出（模块求值无副作用、无 window 赋值；运行期 DOM 操作仅在显式调用时发生）：
 *   composerCardFromEvent / sidebarItemFromEvent / sidebarItemIdentity /
 *   sidebarItemTitle / clearDropTargetHighlights — 投放目标定位（同 selectors、
 *   同禁用/远程排除，两类引用的 drop 行为保持一致）
 *   activeReferenceKey — 附件类会话态的组合 key 权威实现（共享 lastKnown）
 *   notifyReferencePreviewChanged — 附件预览重渲染通知（晚绑定）
 *   setReferenceDragImage — 拖拽影像换成离屏引用 pill（三类 dragstart 源共用：
 *     Topic 看板卡片 / PH 会话记录条目 / 侧栏运行中会话条目）
 */

import { currentRuntimeAgentId } from './orchestration-state.js';
import { getRuntimeWorkspaceSessionId } from './identity.js';
import { escapeHtml } from './markdown-utils.js';
import { getCurrentLanguage } from './i18n-environment-state.js';

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

// ── 拖拽影像（drag ghost）：引用 pill 形态，替代浏览器默认的整卡快照 ──
// 不调 setDragImage 时，浏览器把拖拽源元素渲染成半透明快照跟随鼠标——
// 主题卡片 / 会话条目内容多，整卡虚影既重又遮挡投放目标。这里换成离屏
// 小 pill，几何与配色复用附件区 .session-ref-chip 配方（拖拽落地后的产物
// 正是同形态 pill，视觉语义一致）。kind 决定配色与图标：topic 青绿 + tag
// 图标（.topic-ref-chip），session 蓝色 + 对话气泡（与两个 picker 的
// chipsHtml 模板同源）。

const REFERENCE_DRAG_ICONS = {
  session: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>',
  topic: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path><line x1="7" y1="7" x2="7.01" y2="7"></line></svg>',
};

let _referenceDragGhostEl = null;
let _referenceDragEndCleanupBound = false;

function _removeReferenceDragGhost() {
  _referenceDragGhostEl?.remove?.();
  _referenceDragGhostEl = null;
}

/**
 * 把引用拖拽的 drag image 换成离屏小 pill（三类 dragstart 源共用）。
 * dataTransfer 不支持 setDragImage 的环境（合成事件桩等）静默跳过，
 * 拖拽链路的其余行为不受影响。
 *
 * 结构是「透明 frame + 内层 pill」：Chromium/Windows 对 drag image 位图
 * 边缘做 alpha 渐隐后处理（影像越小渐隐占比越大，小 pill 会被整体泡在
 * 渐隐里，无论底色怎么调都呈「中央实四周虚」）。frame 的透明 padding
 * 把渐隐消耗在缓冲区上，pill 本体离位图边缘足够远，受渐隐影响最小。
 */
export function setReferenceDragImage(event, { kind, title } = {}) {
  const dataTransfer = event?.dataTransfer;
  if (!dataTransfer || typeof dataTransfer.setDragImage !== 'function') return;
  // 上次拖拽异常残留（源元素中途被重渲染、dragend 未冒泡）时先清理；
  // ghost 单例复用，极端泄漏上限一个离屏节点，无累积。
  _removeReferenceDragGhost();
  const icon = REFERENCE_DRAG_ICONS[kind] || REFERENCE_DRAG_ICONS.session;
  const zh = getCurrentLanguage() === 'zh';
  const label = String(title || '').trim()
    || (kind === 'topic' ? (zh ? '主题引用' : 'Topic') : (zh ? '会话引用' : 'Session'));
  const frame = document.createElement('div');
  frame.className = 'reference-drag-ghost';
  frame.innerHTML = '<div class="session-ref-chip reference-drag-ghost-chip' + (kind === 'topic' ? ' topic-ref-chip' : '') + '">'
    + icon + '<span class="session-ref-chip-label">' + escapeHtml(label) + '</span></div>';
  // frame 必须在文档中且已渲染（display:none 会让截取退回默认整卡快照），
  // 离屏定位与透明缓冲见 CSS（.reference-drag-ghost / -chip）。
  document.body.appendChild(frame);
  // 指针落在 pill 中心（对称 padding 下即 frame 中心）；offsetWidth 在
  // dragstart 同步读取会强制布局，真实浏览器必然有值。
  dataTransfer.setDragImage(frame, Math.round((frame.offsetWidth || 0) / 2), Math.round((frame.offsetHeight || 0) / 2));
  _referenceDragGhostEl = frame;
  if (!_referenceDragEndCleanupBound) {
    _referenceDragEndCleanupBound = true;
    // dragend 在源元素触发并冒泡到 document，三类源都收口到这一次清理；
    // 监听器常驻（每次拖拽都会用），不随 dragend 摘除。
    document.addEventListener('dragend', _removeReferenceDragGhost);
  }
}
