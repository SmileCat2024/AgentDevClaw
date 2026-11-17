/**
 * rollback-dialog-runtime.js — 回退/部分压缩动作对话框与运行期回退编排（ESM）。
 *
 * 来源与边界（P2 输入面收尾批次）：本模块从 rollback-dialog.js 原位迁出对话框
 * 装配、运行期回退编排（打断 → 等终态 → 提交）与 toast 文案。原文件按首屏时序
 * 保留**同步注册薄壳**（五个状态键的 classic 相 defineKey，见该文件头注），本模块
 * 不重复注册它们、不改变其注册相位。
 *
 * 时序审计（R1/R2/R4）：
 *   - 首屏同步链 `app-main` 顶层 applyLanguage → renderCurrentMainView →
 *     notifyInputSurfaceChanged → input-render 的渲染入口只**读**那五个状态键
 *     （冻结判定 / compacting 判定 / 计时器清理），不调用本文件的任何函数；
 *     因此本模块在 ESM 执行相求值即可。
 *   - `requestRollbackEdit` 的唯一调用方是 chat-renderer 的 `chat.rollbackEdit`
 *     分发动作（用户点击「编辑此轮」），必然晚于模块执行相；显式 `window.`
 *     调用不等于永久外部协议，按配方统一经 defineKey 注册（setter 原样转发）。
 *   - 等待链时序是模块私有常量（400ms 轮询 / 30s 上限，与原 classic 实现的
 *     模块私有顶层 let 同值）：不导出、不提供测试注入面；确定性测试用
 *     mock.timers 推进时钟。
 *
 * 状态 owner：五个状态键（_partialCompactInFlight / _partialCompactRuntimeId /
 * _partialCompactContextKey / _compactTimerInterval / _rollbackDialogOpen）的
 * 唯一 owner 是 p2-w2-3b-rollback-domain.js；本模块经它的 setter / 活绑定读写，
 * 不经 window 访问器（避免自读自写桥）。
 *
 * 依赖形态：
 *   - 已迁 ESM 直接 import：escapeHtml（markdown-utils）、getCurrentLanguage
 *     （i18n-environment-state）、currentMessages（session-view-storage）、
 *     currentRuntimeAgentId（orchestration-state）、isSessionViewTokenCurrent
 *     （session-view-commit-host）、isInterruptSuppressed（call-interrupt-host）、
 *     动作查询与提交（input-actions）、部分压缩记账与状态 setter
 *     （p2-w2-3b-rollback-domain）。
 *   - 仍 classic 的显式 window 晚绑定（原实现同为运行期调用，`typeof` 守卫与
 *     直调形态按原样保留）：`captureSessionViewToken` / `applySessionViewPatch`
 *     （session-view-state）、`_getSessionInputCacheKey`（app-main）、
 *     `isRuntimeCalling`（runtime-status）、`interruptAgent`（persistent-input）、
 *     `notifyInputSurfaceChanged`（input-render）、`detachTransientInputContent` /
 *     `hidePersistentComposerCard`（input-composer）、
 *     `runWithSuppressedChatViewportObservers`（app-ui）。
 *   - ClawToast 已是 ESM 模块（toast-notify）并直接 import。
 */
import { escapeHtml } from './markdown-utils.js';
import { ClawToast } from './toast-notify.js';
import { getCurrentLanguage } from './i18n-environment-state.js';
import { currentMessages } from './session-view-storage.js';
import { currentRuntimeAgentId } from './orchestration-state.js';
import { isSessionViewTokenCurrent } from './session-view-commit-host.js';
import { isInterruptSuppressed } from './call-interrupt-host.js';
import {
  getPrimaryInputRequest,
  getRollbackInputRequest,
  requestSupportsAction,
  submitInputAction,
} from './input-actions.js';
import {
  writePartialCompactStartedAt,
  setRollbackDialogOpen,
  setPartialCompactInFlight,
  setPartialCompactRuntimeId,
  setPartialCompactContextKey,
} from './p2-w2-3b-rollback-domain.js';

// ── 运行期回退（轮次执行中的回退编排）──────────────────────────
// 回退能力由输入 lease 驱动：轮次执行期间（模型思考中 / 报错重试中 / 工具
// 运行中）lease 已被本轮消费，历史上按钮点击静默失效。运行期路径：确认
// 操作后自动打断当前轮次，等待输入循环空闲重发 lease，再提交所选动作。

/**
 * 等待链时间参数：模块私有，与原 classic 实现的顶层 let 同值、同为生产不可达
 * （400ms 轮询 / 30s 上限）。不导出，也不提供测试注入面——确定性测试用
 * mock.timers 推进时钟。
 */
let _rollbackLeasePollIntervalMs = 400;
let _rollbackLeaseWaitTimeoutMs = 30000;

let _rollbackAwaitInFlight = false;

function _rollbackToast(status, title, description) {
  ClawToast.show({
    id: `rollback-runtime-${status}-${Date.now()}`,
    status,
    title,
    ...(description ? { description } : {}),
    autoDismiss: 6000,
  });
}

function _notifyRollbackNoLease() {
  const isZh = getCurrentLanguage() === 'zh';
  _rollbackToast('error',
    isZh ? '当前没有可用的回退输入' : 'No rollback-capable input available',
    isZh ? '会话尚未就绪或不在等待输入' : 'The session is not ready or not waiting for input');
}

function _notifyRollbackInterrupting() {
  const isZh = getCurrentLanguage() === 'zh';
  _rollbackToast('info',
    isZh ? '正在打断当前轮次…' : 'Interrupting the current turn…',
    isZh ? '轮次结束后将自动执行所选操作' : 'The chosen action will run once the turn finishes');
}

function _notifyRollbackAwaitTimeout() {
  const isZh = getCurrentLanguage() === 'zh';
  _rollbackToast('error',
    isZh ? '等待轮次结束超时' : 'Timed out waiting for the turn to finish',
    isZh ? '请稍后重试回退' : 'Please retry the rollback later');
}

function _notifyRollbackAwaitBusy() {
  const isZh = getCurrentLanguage() === 'zh';
  _rollbackToast('info',
    isZh ? '正在等待轮次结束以执行回退' : 'Waiting for the turn to finish before rolling back');
}

function _notifyRollbackNoTargets() {
  const isZh = getCurrentLanguage() === 'zh';
  _rollbackToast('error',
    isZh ? '轮次结束后没有可回退的点' : 'No rollback targets after the turn finished');
}

/**
 * 运行期回退编排：打断当前轮次并等待输入循环空闲后重发的 lease。
 * 返回携带 rollback/compact 动作的 lease；失败（打断请求失败 / 等待超时 /
 * lease 无回退动作 / 会话已切走）返回 null。等待期间会话切走时立即放弃，
 * 绝不把旧会话的回退提交到新会话。
 */
async function _ensureRollbackLeaseAfterInterrupt(boundRuntimeId, viewToken) {
  const runtimeId = String(boundRuntimeId || '').trim();
  if (!runtimeId) return null;
  if (_rollbackAwaitInFlight) {
    _notifyRollbackAwaitBusy();
    return null;
  }
  _rollbackAwaitInFlight = true;
  try {
    // interrupting 中的轮次（suppression 粘性态）不再重复打断，直接等终态。
    // 桥接期：isRuntimeCalling 定义于 runtime-status（运行时状态域收敛时改 import）。
    if (window.isRuntimeCalling(runtimeId) && !isInterruptSuppressed(runtimeId)) {
      _notifyRollbackInterrupting();
      // 桥接期：interruptAgent 定义于 persistent-input（输入面域收敛时改 import）。
      const result = await window.interruptAgent();
      if (result && result.ok === false && result.reason === 'request-failed') {
        // 打断请求本身失败：轮次不会终止，等待必超时；interruptAgent 已
        // toast 失败原因，这里直接放弃。
        return null;
      }
    }
    const deadline = Date.now() + _rollbackLeaseWaitTimeoutMs;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, _rollbackLeasePollIntervalMs));
      const viewStillCurrent = isSessionViewTokenCurrent(viewToken);
      if (!viewStillCurrent) return null;
      const lease = getPrimaryInputRequest();
      if (lease) {
        if (requestSupportsAction(lease, 'rollback_to_call')
          || requestSupportsAction(lease, 'compact_from_call')) {
          return lease;
        }
        // lease 已重发但没有可回退点：继续等待无意义。
        _notifyRollbackNoTargets();
        return null;
      }
    }
    _notifyRollbackAwaitTimeout();
    return null;
  } finally {
    _rollbackAwaitInFlight = false;
  }
}

// ── 入口 ────────────────────────────────────────────────────────────────

export async function requestRollbackEdit(messageIndex) {
  const msg = currentMessages[messageIndex];
  if (!msg || msg.role !== 'user') {
    return;
  }

  const fallbackCallIndex = currentMessages
    .slice(0, messageIndex + 1)
    .filter(entry => entry.role === 'user')
    .length - 1;
  const callIndex = typeof msg.turn === 'number' ? msg.turn : fallbackCallIndex;

  const request = getRollbackInputRequest();
  if (request) {
    showRollbackActionDialog(request, callIndex, msg);
    return;
  }

  // 无 lease 且轮次执行中（含打断进行中）：lease 已被本轮消费，历史行为是
  // 静默返回（表现为「点击无反应」）。改为进入运行期模式：确认操作后
  // 自动打断当前轮次并等待终态执行。
  const runtimeId = currentRuntimeAgentId;
  // 桥接期：isRuntimeCalling 定义于 runtime-status（运行时状态域收敛时改 import）。
  if (runtimeId && (window.isRuntimeCalling(runtimeId) || isInterruptSuppressed(runtimeId))) {
    showRollbackActionDialog(null, callIndex, msg);
    return;
  }
  // 既无 lease 也无运行轮次：没有可回退的输入面，给出明确反馈。
  _notifyRollbackNoLease();
}

function showRollbackActionDialog(request, callIndex, msg) {
  const inputContainer = document.getElementById('user-input-container');
  const choiceContainer = document.getElementById('choice-input-container');
  if (!inputContainer || !choiceContainer) return;
  // request 为 null：轮次运行中（无 lease），确认操作后打断 + 等终态 + 提交。
  const runningTurn = !request;
  const boundRuntimeId = currentRuntimeAgentId;
  // 桥接期：captureSessionViewToken 的同步 token 捕获仍定义于 session-view-state
  // （会话视图同步读取域收敛时改 import）。
  const viewToken = window.captureSessionViewToken(boundRuntimeId);
  // 桥接期：_getSessionInputCacheKey 定义于 app-main（编排域收敛时改 import）。
  const boundContextKey = window._getSessionInputCacheKey();

  setRollbackDialogOpen(true);

  const msgPreview = (typeof msg.content === 'string' ? msg.content : '').slice(0, 120);
  const isZh = getCurrentLanguage() === 'zh';

  const card = document.createElement('div');
  card.className = 'user-input-card user-choice-card';
  card.innerHTML = `
    <div class="user-choice-topline">
      <div class="user-choice-title">${isZh ? '选择操作' : 'Choose Action'}</div>
      <button class="user-choice-close" type="button" data-mode="cancel">×</button>
    </div>
    ${runningTurn ? `
    <div class="user-choice-running-hint">
      ${isZh ? '当前轮次仍在运行，选择操作后将自动打断它' : 'The current turn is still running; choosing an action will interrupt it'}
    </div>` : ''}
    <div class="user-choice-question">${escapeHtml(msgPreview)}</div>
    <div class="user-choice-options">
      <button class="user-choice-option" type="button" data-mode="rollback">
        <span class="user-choice-key">1</span>
        <span>
          <span class="user-choice-label">${isZh ? '回退到此轮' : 'Rewind to Here'}</span>
          <span class="user-choice-description">${isZh ? '丢弃此轮之后的所有消息，回到此轮重新编辑' : 'Discard everything after this turn and edit again'}</span>
        </span>
      </button>
      <button class="user-choice-option" type="button" data-mode="compact">
        <span class="user-choice-key">2</span>
        <span>
          <span class="user-choice-label">${isZh ? '从此处压缩' : 'Summarize from Here'}</span>
          <span class="user-choice-description">${isZh ? '保留此轮之前的消息，将此轮及之后的内容压缩为摘要' : 'Keep earlier messages, summarize from this turn onward'}</span>
        </span>
      </button>
    </div>
    <div class="user-choice-footer">
      <span>${isZh ? '点击选择操作' : 'Click to choose an action'}</span>
    </div>
  `;

  // 交互弹窗与常驻输入框解耦：对话框渲染到 #choice-input-container（与
  // Ask User 选择卡同一交互面），输入槽只做 transient 清理 + composer 隐藏，
  // 节点保留（焦点/草稿/IME 不因弹窗销毁重建）。
  // 桥接期：以下三个调用点分别定义于 app-ui（视口观察抑制）与 input-composer
  // （临时内容清理 / composer 隐藏），随输入面与视口域收敛改 import。
  window.runWithSuppressedChatViewportObservers(() => {
    window.detachTransientInputContent(inputContainer);
    window.hidePersistentComposerCard();
    for (const child of Array.from(choiceContainer.children)) child.remove();
    choiceContainer.appendChild(card);
  });

  setTimeout(() => card.focus(), 30);

  const close = () => {
    if (!isSessionViewTokenCurrent(viewToken)) return;
    setRollbackDialogOpen(false);
    // 工单 037：接管标志写入即声明——签名在冻结期间已被记录为 frozen，
    // 关闭后的声明因模式差异自然恢复输入面（交互面容器随之清空、composer
    // 恢复显示）。
    // 桥接期：定义域 input-render（输入面渲染域收敛时改 import）。
    window.notifyInputSurfaceChanged();
  };

  card.querySelector('[data-mode="cancel"]').addEventListener('click', close);

  // 点击交互面空白处关闭；onclick 属性与 choice 卡同款，恢复渲染时由
  // renderInputRequests 统一置空。
  choiceContainer.onclick = function(event) {
    if (event.target === choiceContainer) close();
  };

  // 打开即声明一次：让渲染器把 frozen 签名记录在案。若跳过这步且冻结期间
  // 无任何状态变化，close 的声明会因签名相同被去重跳过，composer 将停留
  // 在隐藏态（原实现表现为关闭后输入区空置，同一疏漏）。
  window.notifyInputSurfaceChanged();

  card.querySelector('[data-mode="rollback"]').addEventListener('click', async () => {
    close();
    const lease = runningTurn
      ? await _ensureRollbackLeaseAfterInterrupt(boundRuntimeId, viewToken)
      : request;
    if (!lease) return;
    if (!isSessionViewTokenCurrent(viewToken)) return;
    await submitInputAction(lease.requestId, 'rollback_to_call', {
      callIndex,
      draftInput: msg.content,
    }, boundRuntimeId, viewToken);
  });

  card.querySelector('[data-mode="compact"]').addEventListener('click', async () => {
    close();
    if (!isSessionViewTokenCurrent(viewToken)) return;
    const lease = runningTurn
      ? await _ensureRollbackLeaseAfterInterrupt(boundRuntimeId, viewToken)
      : request;
    if (!lease) return;
    if (!isSessionViewTokenCurrent(viewToken)) return;
    setPartialCompactInFlight(true);
    setPartialCompactRuntimeId(boundRuntimeId);
    setPartialCompactContextKey(boundContextKey);
    writePartialCompactStartedAt(Date.now(), boundContextKey);
    // 压缩标志先置、patch 写入即声明（工单 037）：渲染读取到 compacting 模式。
    // 桥接期：applySessionViewPatch 的同步 patch 门仍定义于 session-view-state。
    window.applySessionViewPatch({ inputRequests: [] });
    await submitInputAction(lease.requestId, 'compact_from_call', {
      callIndex,
    }, boundRuntimeId, viewToken);
  });
}

// ── 桥（classic 消费方：chat-renderer 的 `chat.rollbackEdit` 分发动作）────────
// 函数键按值转发：classic 侧若整体替换该全局（诊断 / 测试接管），后续调用命中
// 替换后的实现。显式的 `window.requestRollbackEdit()` 调用不构成永久外部协议。

const bridgeValues = { requestRollbackEdit };

window.KernelState.defineKey('rollback-dialog-runtime', 'requestRollbackEdit', requestRollbackEdit);
window.KernelState.claim('rollback-dialog-runtime', {
  get(key) {
    return bridgeValues[key];
  },
  set(key, value) {
    bridgeValues[key] = value;
  },
});
