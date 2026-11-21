/**
 * input-actions.js — 输入面动作提交与回退/压缩动作可用性（ESM 域 `input-actions`）。
 *
 * 来源与边界（P2 输入面收尾批次）：本模块承载 input-helpers.js 中**无首屏同步
 * 触达**的实现——动作提交、动作可用性查询、回退按钮可见性、幂等键生成与文本域
 * 自适应。原文件按 R1 只保留唯一 classic 实现 `updateChatProcessToggle`
 * （见 input-helpers.js 头注）。搬移不改行为：函数体逐行保留，只把跨文件引用
 * 显式化（已迁 ESM 的 import，仍 classic 的显式 window 晚绑定）。
 *
 * 时序审计（R1/R2/R4，真实可达链）：
 *   - 首屏同步链 app-main 顶层 `applyTheme → applyLanguage → renderCurrentMainView`
 *     → app-ui 三个分支都在 `typeof updateChatProcessToggle === 'function'` 后调用
 *     它——只有 updateChatProcessToggle 触线，留 classic。
 *   - 本文件其余键的首个触达点全部在 DOMContentLoaded 之后：chat-renderer 的
 *     消息上屏（render / appendNewMessages / updateLastMessage）、poll 提交后的
 *     `updateRollback` 适配、输入框 oninput 的 autoResize、choice / rollback 动作
 *     交互。deferred 模块在 DOMContentLoaded 之前求值，注册相位 = ESM 执行相成立。
 *   - 因此本文件不改变启动等待：没有 ready 队列，也不延迟任何首屏调用。
 *
 * 桥键（domain `input-actions`，classic 消费方尚未迁移，经 window 访问器读写）：
 *   - `updateRollbackActionVisibility` ← chat-renderer.js（render / appendNewMessages
 *     / updateLastMessage 落位后）、app-main.js（createMetadataCommitHost 的
 *     updateRollback 适配）、agent-data-loader.js（同一适配）
 *   - `canRollbackMessage`            ← chat-renderer.js（消息行编辑按钮判定）
 *   - `autoResize`                    ← input-composer.js / input-render.js /
 *     persistent-input.js / voice-input.js（textarea 自适应）、slash-menu.js
 *     （`window.autoResize`）、app-chat-input.js（`window.autoResize` 可选调用）
 *   注销条件：上述 classic 消费方迁 ESM 并改为 import。
 *   未上桥的键：`submitInputAction` / `getPrimaryInputRequest` /
 *   `requestSupportsAction` / `getRollbackInputRequest` 的唯一跨文件消费方是
 *   rollback-dialog-runtime（本批已 ESM，直接 import）；`getAvailableCallIndices`
 *   / `syncRollbackActionButtons` / `_notifyActionSubmitFailed` 为模块私有。
 *   `newIdempotencyKey` **刻意不上桥**：window 上同名属性是 classic 顶层
 *   函数声明挂成的不可配置属性（现存提供者 wg-threads-panel.js，已改按需
 *   装载、非稳定供给），再 defineKey 会直接抛错，且消费方只需函数值、
 *   直接 import 即可。
 *
 * 依赖形态：
 *   - 已迁 ESM 直接 import：会话视图存储（currentInputRequests / currentMessages）、
 *     会话提交策略（isSessionViewTokenCurrent / commitSessionViewPatch）、
 *     中断抑制（clearInterruptSuppression）、call 活动容器（callActivity，
 *     与 classic 同一 Map 引用）、DOM 引用（domRefs，container 只读）、语言
 *     （getCurrentLanguage）、编排状态（currentRuntimeAgentId）、通知
 *     （ClawToast，toast-notify）、轮询入口（poll，poll-coordinator-host）。
 *   - 仍 classic 的显式 window 晚绑定（行尾注明定义域；原实现同为运行期调用，
 *     `typeof` 守卫按原样保留或按原样直调）：
 *     `captureSessionViewToken` / `applySessionViewPatch`（session-view-state）、
 *     `beginFollowLatestEntryWindow` / `requestFollowLatest`（chat-viewport）、
 *     `_markAgentCallStartedForNotify`（desktop-notify）、
 *     `_syncPersistentActionButton`（persistent-input）、
 *     `renderAgentList`（sidebar-render）、
 *     `getMessageRollbackEditActionHtml`（chat-renderer）。
 */
import { currentInputRequests, currentMessages } from './session-view-storage.js';
import { isSessionViewTokenCurrent, commitSessionViewPatch } from './session-view-commit-host.js';
import { currentRuntimeAgentId } from './orchestration-state.js';
import { clearInterruptSuppression } from './call-interrupt-host.js';
import { callActivity } from './p2-bootstrap-call-activity.js';
import { domRefs } from './p2-bootstrap-dom.js';
import { getCurrentLanguage } from './i18n-environment-state.js';
import { ClawToast } from './toast-notify.js';
import { poll } from './poll-coordinator-host.js';

// ── view token 适配（session-view 同步读取仍 classic，异步提交已 ESM）────────

function captureInputViewToken(runtimeId) {
  return typeof window.captureSessionViewToken === 'function'
    ? window.captureSessionViewToken(runtimeId)
    : null;
}

function isInputViewTokenCurrent(token, runtimeId) {
  if (!token) return currentRuntimeAgentId === runtimeId;
  return isSessionViewTokenCurrent(token);
}

function commitInputViewPatch(token, patch, runtimeId) {
  if (token) return commitSessionViewPatch(token, patch);
  if (currentRuntimeAgentId !== runtimeId) return false;
  // 桥接期：applySessionViewPatch 的同步 patch 门仍定义于 session-view-state
  // （会话视图同步读取域收敛时改 import）。
  window.applySessionViewPatch(patch);
  return true;
}

// ── 幂等键与文本域自适应 ────────────────────────────────────────────────
// 同名函数在 app-main.js 也有一个顶层声明（classic 全局赢家）。本模块的实现只
// 服务本文件与 choice-input 的 import，不注册桥键（见头注）。

export function newIdempotencyKey() {
  const cryptoObj = (typeof crypto !== 'undefined') ? crypto : null;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  return `key-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function autoResize(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
}

// ── 回退按钮显隐 ────────────────────────────────────────────────────────

function syncRollbackActionButtons() {
  const allowRollback = !!getRollbackInputRequest();
  const rows = domRefs.container.querySelectorAll('.message-row');

  rows.forEach((row) => {
    const msgId = row.querySelector('.message-content')?.id || '';
    const match = /^msg-(\d+)$/.exec(msgId);
    const index = match ? Number(match[1]) : -1;
    const msg = currentMessages[index];
    const meta = row.querySelector('.message-meta');
    if (!meta) return;

    const existingButton = meta.querySelector('.message-action');
    const shouldShow = allowRollback && canRollbackMessage(msg);

    if (!shouldShow) {
      if (existingButton) {
        existingButton.remove();
      }
      return;
    }

    if (existingButton) {
      // 动作指向随当前消息下标重写（原内联事件 setAttribute 注入形态收编；
      // 按钮本体由 chat-renderer 渲染时即带 data-action）
      existingButton.dataset.action = 'chat.rollbackEdit';
      existingButton.dataset.args = JSON.stringify([index]);
      existingButton.style.display = '';
      return;
    }

    // 图标按钮 HTML 由 chat-renderer.js 统一提供，与渲染路径保持同一形态
    // 桥接期：定义域 chat-renderer（聊天渲染域收敛时改 import）。
    meta.insertAdjacentHTML('beforeend', window.getMessageRollbackEditActionHtml(index));
  });
}

export function updateRollbackActionVisibility() {
  syncRollbackActionButtons();
}

// ── 输入请求查询（纯函数，读会话视图存储）────────────────────────────────

export function getPrimaryInputRequest() {
  return Array.isArray(currentInputRequests) && currentInputRequests.length > 0
    ? currentInputRequests[0]
    : null;
}

export function requestSupportsAction(request, actionId) {
  return Array.isArray(request?.actions)
    && request.actions.some((action) => action && action.id === actionId);
}

export function getRollbackInputRequest() {
  if (!Array.isArray(currentInputRequests)) {
    return null;
  }
  return currentInputRequests.find((request) =>
    requestSupportsAction(request, 'rollback_to_call')
    || requestSupportsAction(request, 'compact_from_call')
  ) || null;
}

function getAvailableCallIndices() {
  const request = getRollbackInputRequest();
  if (!request) return null;
  // Find the action that carries availableCallIndices
  for (const action of (request.actions || [])) {
    if (Array.isArray(action?.data?.availableCallIndices)) {
      return action.data.availableCallIndices;
    }
  }
  // Fallback: if no data is provided (older runtime), return null to signal
  // "unknown" — in that case we allow all user messages to be rollbackable
  // to preserve backward compatibility.
  return null;
}

export function canRollbackMessage(msg) {
  if (!getRollbackInputRequest() || !msg || msg.role !== 'user') return false;
  // Seed messages from handoff are never rollbackable
  if (msg.source === 'handoff-seed') return false;
  const available = getAvailableCallIndices();
  // If runtime didn't send availableCallIndices, fall back to allowing all
  if (available === null) return true;
  if (available.includes(msg.turn)) return true;
  // 防御（低概率竞态）：lease 广播的 availableCallIndices 偶发缺最新轮的
  // checkpoint（广播早于 checkpoint 提交）。最新一条用户消息正是「回退到
  // 刚说的话」的目标：宁可放行（执行时 runtime 按实际 checkpoints 校验，
  // 真不存在会明确失败并 toast），也不静默禁用按钮。
  for (let i = currentMessages.length - 1; i >= 0; i--) {
    if (currentMessages[i]?.role !== 'user') continue;
    return currentMessages[i] === msg;
  }
  return false;
}

// ── 动作提交 ────────────────────────────────────────────────────────────

/**
 * 输入动作提交失败的用户可见反馈：输入卡未被乐观清空（清空只在
 * res.ok 后发生），toast 告知后用户可直接重试。
 */
function _notifyActionSubmitFailed(actionId) {
  const isZh = getCurrentLanguage() === 'zh';
  const actionLabel = actionId === 'rollback_to_call'
    ? (isZh ? '回退' : 'rollback')
    : actionId === 'compact_from_call'
      ? (isZh ? '精简' : 'compact')
      : (isZh ? '操作' : 'action');
  ClawToast.show({
    id: `input-action-failed-${actionId}-${Date.now()}`,
    title: isZh
      ? `${actionLabel}请求提交失败，请重试`
      : `Failed to submit ${actionLabel} request, please retry`,
    status: 'error',
    autoDismiss: 5000,
  });
}

export async function submitInputAction(requestId, actionId, payload = {}, boundRuntimeId = currentRuntimeAgentId, boundViewToken = null) {
  try {
    const targetRuntimeId = String(boundRuntimeId || '').trim();
    if (!targetRuntimeId) return;
    const viewToken = boundViewToken || captureInputViewToken(targetRuntimeId);
    const res = await fetch(`/api/agents/${encodeURIComponent(targetRuntimeId)}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-idempotency-key': newIdempotencyKey() },
      body: JSON.stringify({
        requestId,
        input: '',
        response: {
          kind: 'action',
          actionId,
          payload,
        },
      }),
    });
    if (res.ok) {
      if (isInputViewTokenCurrent(viewToken, targetRuntimeId)) {
        // 桥接期：视口跟随入口仍定义于 chat-viewport（视口域收敛时改 import）。
        window.beginFollowLatestEntryWindow();
        window.requestFollowLatest({ forceEnable: true, behavior: 'auto' });
        // 乐观清空即声明（工单 037）：渲染由 patch hook 同步触发，不等 poll。
        commitInputViewPatch(viewToken, { inputRequests: [] }, targetRuntimeId);
        clearInterruptSuppression(targetRuntimeId);
        // rollback_to_call 只做本地回退 + 草稿回填 + 重弹输入框，不触发模型
        // 调用；乐观 calling 会造成最长一个 poll 周期的假"处理中"。compact_
        // from_call 走摘要 LLM，仍按调用处理。
        if (actionId !== 'rollback_to_call') {
          // 桥接期：定义域 desktop-notify（通知域收敛时改 import）；容器与 classic 同一 Map。
          window._markAgentCallStartedForNotify(targetRuntimeId);
          callActivity._agentCallActive.set(targetRuntimeId, true);
        }
        // 桥接期：定义域 persistent-input / sidebar-render（输入面与侧栏收敛时改 import）。
        window._syncPersistentActionButton();
        window.renderAgentList();
      }
      poll();
    } else {
      _notifyActionSubmitFailed(actionId);
    }
  } catch (e) {
    console.error('提交动作失败:', e);
    _notifyActionSubmitFailed(actionId);
  }
}

// ── 桥（classic 消费方：函数键原样转发，可被晚绑定替换）────────────────────

const bridgeValues = { updateRollbackActionVisibility, canRollbackMessage, autoResize };

window.KernelState.defineKey('input-actions', 'updateRollbackActionVisibility', updateRollbackActionVisibility);
window.KernelState.defineKey('input-actions', 'canRollbackMessage', canRollbackMessage);
window.KernelState.defineKey('input-actions', 'autoResize', autoResize);
window.KernelState.claim('input-actions', {
  get(key) {
    return bridgeValues[key];
  },
  set(key, value) {
    bridgeValues[key] = value;
  },
});
