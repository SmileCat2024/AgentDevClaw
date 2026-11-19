/**
 * topic-reference-picker.js — Topic 看板主题卡片拖拽引用（对标会话引用）
 *
 * 主题引用与输入框会话引用（session-reference-picker.js）同心智模型：一次性
 * 附件语义，挂在输入框上，随下一条 user-turn 以 metadata['topic-management']
 * 发出即消费，发送失败归还。状态只存在于本模块局部作用域，会话切换清空。
 *
 * 与会话引用的两个刻意差异：
 *   - metadata 键是 'topic-management'（feature 注册名）而非字段名——call 内
 *     排队路径的 dispatchTurnMetadata 按「metadata 键 = feature 名」查找消费方，
 *     键与 feature 名不一致时忙时追加的引用会被静默丢弃（warn 日志）。
 *   - 无自引用拦截：主题与目标会话是不同对象，不存在「拖到自己身上」。
 *
 * 拖拽链路（与 SESSION_REF_MIME 并行、互不干扰）：
 *   - 源：Topic 看板 .ph-topic-card（模板 draggable 属性 + 本模块委托 dragstart）
 *   - 目标：当前输入卡（.user-input-card）与左栏会话条目（.agent-runtime-item）
 *     —— 目标判定 / 会话 key / 预览刷新共用 reference-drop-targets（不 import
 *     session-reference-picker：其模块求值有 window.SessionReference 赋值副作用，
 *     会破坏 persistent-input 刻意维持的晚绑定注入面）
 *   - 注入：local-features/topic-management 的 CallStart 钩子承接（指针式：
 *     引用时注入标题/简介/参考文档/相关提交等元信息，成员对话明细走 topic_get）
 */

import { ClawToast } from './toast-notify.js';
import { escapeHtml } from './markdown-utils.js';
import { getCurrentLanguage } from './i18n-environment-state.js';
import {
  activeReferenceKey,
  notifyReferencePreviewChanged,
  composerCardFromEvent,
  sidebarItemFromEvent,
  sidebarItemIdentity,
  sidebarItemTitle,
  clearDropTargetHighlights,
} from './reference-drop-targets.js';

/** 拖拽专用 MIME（与 SESSION_REF_MIME 平行；两类引用可同时挂载、互不覆盖）。 */
export const TOPIC_REF_MIME = 'application/x-claw-topic-ref';

/**
 * turn metadata 键 = topic-management feature 注册名（CallStart 钩子与
 * dispatchTurnMetadata 派发共同约定的契约键，见模块头注）。
 */
export const TOPIC_REF_METADATA_KEY = 'topic-management';

// ── 引用状态（模块局部；桶 key 复用 session-reference-picker 的 activeKey，
//    三个时刻（挂载/提交/渲染）读出同一值的纪律同源） ─────────────────

const _topicReferences = new Map(); // key → [{ agentId, topicId, title }]

function _refs() {
  const key = activeReferenceKey();
  let refs = _topicReferences.get(key);
  if (!Array.isArray(refs)) {
    refs = [];
    _topicReferences.set(key, refs);
  }
  return refs;
}

function _refKey(ref) {
  return `${ref.agentId}/${ref.topicId}`;
}

/** 幂等追加到指定 key 的引用桶；返回是否新增。 */
function _appendRefToKey(key, ref) {
  let refs = _topicReferences.get(key);
  if (!Array.isArray(refs)) {
    refs = [];
    _topicReferences.set(key, refs);
  }
  if (refs.some(r => _refKey(r) === _refKey(ref))) return false;
  refs.push(ref);
  return true;
}

/** 归一化拖拽条目：topicId 必填；agentId 缺省 programming-helper（Topic 看板归属）。 */
function _normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const topicId = String(entry.topicId || '').trim();
  if (!topicId) return null;
  return {
    agentId: String(entry.agentId || '').trim() || 'programming-helper',
    topicId,
    title: String(entry.title || '').trim(),
  };
}

export function addTopicReference(entry) {
  const ref = _normalizeEntry(entry);
  if (!ref) return false;
  if (_appendRefToKey(activeReferenceKey(), ref)) notifyReferencePreviewChanged();
  return true;
}

/**
 * 「主题拖到会话」的投放入口：把主题引用挂到「目标会话」的输入框（key 与
 * activeReferenceKey 的组合格式一致），切换过去后 pill 自然显示。
 */
export function addTopicReferenceToTarget(entry, target) {
  const ref = _normalizeEntry(entry);
  if (!ref) return false;
  const runtimeId = String(target?.runtimeId || '').trim();
  const targetSessionId = String(target?.sessionId || '').trim();
  if (!runtimeId || !targetSessionId) return false;
  if (_appendRefToKey(`${runtimeId}::${targetSessionId}`, ref)) {
    notifyReferencePreviewChanged(); // 目标恰为活跃会话时 pill 立即出现
    const zh = getCurrentLanguage() === 'zh';
    const label = String(target?.title || '').trim() || targetSessionId;
    if (ClawToast?.show) {
      ClawToast.show({
        id: 'topic-ref-drop',
        status: 'success',
        title: zh ? `已把主题引用挂到「${label}」的输入框` : `Topic reference attached to "${label}"`,
        autoDismiss: 3200,
      });
    }
  }
  return true;
}

export function removeTopicReference(index) {
  const refs = _refs();
  const idx = Number(index);
  if (!Number.isInteger(idx) || idx < 0 || idx >= refs.length) return;
  refs.splice(idx, 1);
  notifyReferencePreviewChanged();
}

/** 发送时消费：取走当前会话的全部主题引用（数组浅拷贝）并清空 pill。 */
export function consumeTopicReferences() {
  const refs = _refs().slice();
  _topicReferences.set(activeReferenceKey(), []);
  notifyReferencePreviewChanged();
  return refs;
}

/** 发送失败归还（consume 取走的引用原样放回），不覆盖期间新挂的引用。 */
export function restoreTopicReferences(refs) {
  if (!Array.isArray(refs) || refs.length === 0) return;
  const current = _refs();
  for (const ref of refs) {
    const normalized = _normalizeEntry(ref);
    if (normalized && !current.some(r => _refKey(r) === _refKey(normalized))) {
      current.push(normalized);
    }
  }
  notifyReferencePreviewChanged();
}

/** 乐观气泡快照（不消费）。 */
export function peekTopicReferences() {
  return _refs().slice();
}

/** 引用 pill HTML（与图片缩略图、会话引用 pill 同在附件预览区渲染）。 */
export function topicReferenceChipsHtml() {
  const refs = _refs();
  if (refs.length === 0) return '';
  return refs.map((ref, idx) => {
    const label = ref.title || ref.topicId;
    return '<div class="session-ref-chip topic-ref-chip" title="' + escapeHtml(`topic · ${ref.agentId} · ${ref.topicId}`) + '">'
      + '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path><line x1="7" y1="7" x2="7.01" y2="7"></line></svg>'
      + '<span class="session-ref-chip-label">' + escapeHtml(label) + '</span>'
      + '<button class="session-ref-chip-remove" type="button" data-action="topicRef.removeChip" data-args="[' + idx + ']" title="'
      + escapeHtml(getCurrentLanguage() === 'zh' ? '移除' : 'Remove')
      + '">×</button>'
      + '</div>';
  }).join('');
}

// ── 拖拽源（Topic 看板卡片，委托 dragstart）与投放目标绑定 ───────────

function _bindTopicReferenceDrag() {
  // 源：Topic 看板卡片（模板带 draggable="true"，payload 从 DOM 读出——
  // 卡片标题元素与会话条目一样是渲染产物，避免在模板里拼内联 handler）。
  document.addEventListener('dragstart', (event) => {
    const target = event.target;
    if (!(target instanceof Node) || !target.closest) return;
    const card = target.closest('.ph-topic-card');
    if (!card || !event.dataTransfer) return;
    const panel = card.closest('.ph-topic-panel');
    const topicId = String(card.dataset?.topicId || '').trim();
    if (!topicId) return;
    const title = String(card.querySelector('.ph-topic-card-title')?.textContent || '').trim();
    const payload = {
      agentId: String(panel?.dataset?.topicAgentId || '').trim() || 'programming-helper',
      topicId,
      title,
    };
    event.dataTransfer.setData(TOPIC_REF_MIME, JSON.stringify(payload));
    event.dataTransfer.effectAllowed = 'copy';
  });

  document.addEventListener('dragover', (event) => {
    if (!event.dataTransfer || !Array.from(event.dataTransfer.types || []).includes(TOPIC_REF_MIME)) return;
    const card = composerCardFromEvent(event);
    if (card) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      card.classList.add('session-ref-drop-target');
      return;
    }
    const item = sidebarItemFromEvent(event);
    if (!item) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    item.classList.add('session-ref-drop-target');
  });

  document.addEventListener('dragleave', (event) => {
    const card = composerCardFromEvent(event);
    if (card) card.classList.remove('session-ref-drop-target');
    const item = sidebarItemFromEvent(event);
    if (item) item.classList.remove('session-ref-drop-target');
  });

  document.addEventListener('drop', (event) => {
    const card = composerCardFromEvent(event);
    const item = sidebarItemFromEvent(event);
    clearDropTargetHighlights();
    if (!event.dataTransfer) return;
    const raw = event.dataTransfer.getData(TOPIC_REF_MIME);
    if (!raw) return;
    event.preventDefault();
    let entry;
    try { entry = JSON.parse(raw); } catch { return; }
    if (card) {
      if (addTopicReference(entry)) {
        const textarea = card.querySelector('.user-input-textarea');
        if (textarea) textarea.focus();
      }
      return;
    }
    if (item) {
      addTopicReferenceToTarget(entry, {
        ...sidebarItemIdentity(item),
        title: sidebarItemTitle(item),
      });
    }
  });
}

_bindTopicReferenceDrag();

// ── 分发器动作（pill 移除；与会话引用的 sessionRef.removeChip 同模式）──
window.ClawFW.actions.registerMany({
  'topicRef.removeChip': (el, event, idx) => removeTopicReference(Number(idx)),
});
