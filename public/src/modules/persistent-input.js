/**
 * persistent-input.js — Phase B-4
 * 持久输入框 / 队列系统（classic → ESM，P4 T2 输入面批次）
 *
 * 包含（P2 W2-3a 之后仍在现在这个文件里的部分）：
 * - 常驻输入框渲染与交互（renderPersistentInput, onPersistentBtnClick, handlePersistentInputKey）
 * - 提交路径（submitQueuedInput、发送反馈窗口、动作按钮状态机）
 * - 排队气泡投影的会话重绑（rebindQueueProjectionForRuntime）
 * - 中断操作（interruptAgent）
 * - 图片附件（按会话隔离的待发送桶与转存）
 * - 上次对话结束时间显示（_renderLastCallElapsed + setInterval）
 *
 * 已迁 ESM：队列气泡渲染与后端/SSE 队列快照同步 →
 * p2-w2-3a-queue-projection.js；排队投影与结束时间状态 owner →
 * p2-w2-3a-input-queue-state.js / p2-w2-3a-call-elapsed-state.js
 * （本文件 import 其活绑定与 setter，直读直写，不再经 window 访问器）。
 *
 * 状态归属（P4 本批起）：
 *   - 排队投影五键（域 input-queue）、结束时间一键（域 input-call-elapsed）的
 *     owner 在各自 p2-w2-3a-* 模块；本文件原声明位置的 defineKey 保留为
 *     **注册行**（未迁移消费方经访问器读写同一份状态），注册随本模块在模块相
 *     执行，走 kernel-state 的「认领后补注册」路径，初值直接落进 owner 状态。
 *   - 跨文件语音状态（域 voice-input）owner 是 p2-w2-3a-voice-state.js，import。
 *   - 其余全部模块私有：发送重入 / 反馈窗口计时、图片桶、胶囊计时、附件预览、
 *     动作按钮状态机、_callFinishTimerInterval。
 *
 * 命名导出：桥键同源函数（见文件末尾注册块）+ `onPersistentBtnClick` /
 * `handlePersistentInputKey` / `handleInputPaste` / `onImageFilesSelected`
 * （唯一生产消费方 input-composer，本批同批转换，直接 import）+
 * `_resolvePendingImagesForTarget` / `clearPendingInputImages`（内部件，导出供
 * 真实 import 测试；生产跨文件消费方为零）+ `__testInputState`（私有状态读写缝）。
 *
 * 外来键三选一结论（配方步 3）：
 *   - import：状态 owner 与轻量宿主域（orchestration-state / session-view-storage /
 *     composer-state / input-queue-state / call-elapsed-state / voice-state /
 *     call-interrupt-host / session-view-commit-host / p2-bootstrap-call-activity /
 *     i18n-environment-state / input-actions）+ 本批兄弟 input-composer。
 *   - import 的 runtime-status 域状态：lastRenderedNotificationRuntime /
 *     lastNotificationStatusPayload 及其 setter（owner p2-w2-2-runtime-status-owner）。
 *   - `window.` 晚绑定（目标仍是 classic 或仍以桥键服务其他消费方；行尾注释标
 *     定义域与收敛条件）：isRuntimeCalling / updateNotificationStatus（runtime-status）、
 *     isChatSurfaceActive
 *     （app-ui）、renderAgentList（sidebar-render）、normalizeAgentIdentity /
 *     _getSessionInputCacheKey（app-main / app-core）、captureSessionViewToken
 *     （session-view-state）、_markAgentCallStartedForNotify / _requestNotifyPermission
 *     （desktop-notify）、escapeHtml（markdown-utils）、refreshThreads /
 *     getActiveThreadInputTarget / submitThreadInput（thread-store）、
 *     _renderQueueBubbles / updateQueueIndicator / _syncPersistentInputUi
 *     （input-queue 域桥）、notifyInputSurfaceChanged（input-render 桥）、
 *     _clearRecapForNewMessage（recap-hint 桥）、updateInputModelSwitcher /
 *     updateThinkingEffortSwitcher（input-model-switcher 桥）、
 *     beginFollowLatestEntryWindow / requestFollowLatest（chat-viewport 桥）、
 *     stopVoiceRecording（voice-input-api 桥）。
 *     `window.SessionReference` / `ClawSlash` / `ClawToast` / `ClawFW.*` 是既有
 *     公开命名空间协议。
 *   - 无触线项：本文件不引用任何仍 classic 的顶层 let/const/class 词法绑定。
 *
 * 时相审计（R1/R2/R4）：
 *   - classic 相零触达：本文件全部键的读写都在函数体内（首屏链的
 *     readInputSurfaceModeState / rebindQueueProjectionForRuntime 由 boot.js 在
 *     模块相触发，晚于本模块求值）。
 *   - 顶层语句四条，从「classic 加载序」移到「模块求值相」等价：①桥键 / 状态
 *     注册（同上，模块相即可）；②`window.migratePendingInputImages` 由散装赋值
 *     改为 defineKey 桥键（消费方 thread-store 在接续换头时调用，属运行期）；
 *     ③1s 胶囊 tick 的 `setInterval`（首帧渲染本身也由 renderInputRequests 驱动，
 *     tick 起点差在毫秒级）；④`window.ClawFW.actions.registerMany`（分发器是
 *     classic head 脚本，先于一切模块；动作目标元素只由本模块的 composer 渲染
 *     产生，一定晚于注册）。
 *   - sloppy → strict：原文件无 `'use strict'`，逐条核对无隐式全局赋值（跨文件
 *     写点全部是 defineKey 桥键或 import 的 setter）、无 `with`、无顶层 `this`。
 *
 * 与 input-composer.js 的静态循环：两侧只在函数体互相调用（function 声明在模块
 * 实例化阶段即初始化），求值期零解引用；装载顺序不影响语义。
 */

// 渲染常驻输入框（agent 运行期间始终可见）
//
// 排队气泡投影的归属（会话隔离）：_queuedTexts / _pendingQueuedCount /
// _localQueuedInputPending 始终属于一个 runtime，与图片桶、草稿同属输入面
// 会话态家族。会话切换经 rebindQueueProjectionForRuntime（本文件）重绑，写入
// 路径（p2-w2-3a-queue-projection 的 applyQueuedInputsTexts / submitQueuedInput
// 乐观态）一律带归属校验，旧会话的排队气泡不进入新会话的输入面。
//
// 注册行（保持原声明位置）：owner 已由 p2-w2-3a-* 模块 claim，故这里的注册按
// 「认领后补注册」把初值推入 owner 状态；尚未迁移的 classic 消费方
// （runtime-status 的 call.finish 归零与结束时间写入）继续经访问器读写同一份
// 状态，无双存储。注销条件：runtime-status 迁 ESM 并改 import 之后。
import { getCurrentLanguage } from './i18n-environment-state.js';
import { currentRuntimeAgentId } from './orchestration-state.js';
import { currentMessages, currentInputRequests } from './session-view-storage.js';
import { sessionInputCache } from './p2-w2-3a-composer-state.js';
import {
  pendingQueuedCount,
  queuedTexts,
  localQueuedInputPending,
  queuedProjectionRuntimeId,
  setPendingQueuedCount,
  setQueuedTexts,
  setLocalQueuedInputPending,
  setLastQueueBubbleSignature,
  setQueuedProjectionRuntimeId,
} from './p2-w2-3a-input-queue-state.js';
import { lastCallFinishTime, clearLastCallFinishTime } from './p2-w2-3a-call-elapsed-state.js';
import {
  lastRenderedNotificationRuntime,
  setLastRenderedNotificationRuntime,
  lastNotificationStatusPayload,
} from './p2-w2-2-runtime-status-owner.js';
import {
  voiceRecording,
  voiceStopping,
  voiceTranscribing,
  voicePendingSend,
  setVoicePendingSend,
} from './p2-w2-3a-voice-state.js';
import {
  getNotificationCallStartedAt,
  markInterruptPending,
  isInterruptSuppressed,
  clearInterruptSuppression,
} from './call-interrupt-host.js';
import { isSessionViewTokenCurrent } from './session-view-commit-host.js';
import { callActivity } from './p2-bootstrap-call-activity.js';
import { autoResize, newIdempotencyKey } from './input-actions.js';
import {
  showPersistentComposerCard,
  applyComposerMode,
  syncPersistentComposerSessionCard,
} from './input-composer.js';

window.KernelState.defineKey('input-queue', '_pendingQueuedCount', 0);
window.KernelState.defineKey('input-queue', '_queuedTexts', []); // 仅用于气泡展示
window.KernelState.defineKey('input-queue', '_localQueuedInputPending', false);
window.KernelState.defineKey('input-queue', '_lastQueueBubbleSignature', '');
window.KernelState.defineKey('input-queue', '_queuedProjectionRuntimeId', null);
window.KernelState.defineKey('input-call-elapsed', '_lastCallFinishTime', 0);
let _submitInFlight = false;       // 发送重入保护：fetch 期间阻止二次提交/中断
let _sendingStartedAt = 0;         // 发送反馈窗口起点（最短可见时长的计时基准）
let _sendingHoldTimer = null;      // 最短可见保持定时器：hold 期间轮询同步不得清 spinner

// 待发送的图片附件：按会话隔离存储（与 SessionReference 的会话引用同套路）。
// Map<key, entries[]>，key 复用 window.SessionReference.activeKey()——附件类
// 会话态的"哪个会话"只此一份权威判定（runtimeId::sessionId 组合，挂载/消费/
// 渲染三时刻读同一值）。会话 A 挂的图片不出现在会话 B 的输入框，切回 A 恢复；
// 发送只消费发送时刻捕获的桶，await 期间切换会话不误发新会话的图片。
const _pendingImageBuckets = new Map(); // key → [entry]

function _imageBucketKey() {
  return window.SessionReference?.activeKey?.() || 'default';
}

function _imageBucket() {
  const key = _imageBucketKey();
  let bucket = _pendingImageBuckets.get(key);
  if (!Array.isArray(bucket)) {
    bucket = [];
    _pendingImageBuckets.set(key, bucket);
  }
  return bucket;
}

// 接续会替换 Session 身份，但用户仍在同一条 Thread 对话中。将未发送附件
// 随视图身份迁移到 successor；只由 thread-store 在确认同线程换头时调用。
export function migratePendingInputImages(fromKey, toKey) {
  if (typeof fromKey !== 'string' || !fromKey || typeof toKey !== 'string' || !toKey || fromKey === toKey) return;
  const source = _pendingImageBuckets.get(fromKey);
  if (!Array.isArray(source) || source.length === 0) return;
  const destination = _pendingImageBuckets.get(toKey);
  _pendingImageBuckets.set(toKey, Array.isArray(destination) ? destination.concat(source) : source);
  _pendingImageBuckets.delete(fromKey);
  _renderAttachmentPreview();
}

// ── 上次对话结束时间显示 ──────────────────────────────────────────
// _lastCallFinishTime 的 owner 在 p2-w2-3a-call-elapsed-state.js（import 活绑定
// 与语义 clear），注册行见上方状态区块。下面两个起始时间键零跨文件消费面，
// 留在本文件。
let _callFinishTimerInterval = null;
let _runCapsuleStartAt = 0; // 运行期间胶囊使用的本轮 call 起始时间
let _runCapsuleStartConfirmed = false; // 起始时间是否已由运行时快照确认（未确认前允许快照值回拨纠正）

export function resetCallElapsedForSwitch() {
  clearLastCallFinishTime();
  _runCapsuleStartAt = 0;
  _runCapsuleStartConfirmed = false;
  const container = document.getElementById('user-input-container');
  if (!container) return;
  container.querySelector('.call-elapsed-capsule')?.remove();
  _cleanupInputMetaBar(container);
}

const _CAPSULE_CLOCK_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>';

function formatCallElapsed(finishTime) {
  const elapsed = Math.max(0, Date.now() - finishTime);
  const totalSeconds = Math.floor(elapsed / 1000);
  const zh = getCurrentLanguage() === 'zh';
  if (totalSeconds < 600) {
    if (totalSeconds < 60) {
      return zh ? totalSeconds + ' 秒前' : totalSeconds + 's ago';
    }
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return zh ? m + ' 分 ' + s + ' 秒前' : m + 'm ' + s + 's ago';
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return zh ? totalMinutes + ' 分钟前' : totalMinutes + 'm ago';
  }
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (m > 0) {
    return zh ? h + ' 小时 ' + m + ' 分前' : h + 'h ' + m + 'm ago';
  }
  return zh ? h + ' 小时前' : h + 'h ago';
}

// 运行期间的整轮用时："已运行 12 秒" / "已运行 1 分 5 秒" / "已运行 1 小时 5 分"
function formatRunningElapsed(startAt) {
  const totalSeconds = Math.floor(Math.max(0, Date.now() - startAt) / 1000);
  const zh = getCurrentLanguage() === 'zh';
  if (totalSeconds < 60) {
    return zh ? '已运行 ' + totalSeconds + ' 秒' : 'Running ' + totalSeconds + 's';
  }
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  if (m < 60) {
    return zh ? '已运行 ' + m + ' 分 ' + s + ' 秒' : 'Running ' + m + 'm ' + s + 's';
  }
  const h = Math.floor(m / 60);
  const restM = m % 60;
  return zh ? '已运行 ' + h + ' 小时 ' + restM + ' 分' : 'Running ' + h + 'h ' + restM + 'm';
}

export function _ensureInputMetaBar(container) {
  let bar = container.querySelector('.input-meta-bar');
  if (bar) return bar;

  bar = document.createElement('div');
  bar.className = 'input-meta-bar';

  // Insert before the input card or queue bubbles
  const refEl = container.querySelector('.user-input-card, .queue-bubbles-stack');
  if (refEl) {
    container.insertBefore(bar, refEl);
  } else {
    container.appendChild(bar);
  }
  return bar;
}

export function _cleanupInputMetaBar(container) {
  const bar = container.querySelector('.input-meta-bar');
  if (bar && bar.children.length === 0) {
    bar.remove();
  }
}

// 交互面（#choice-input-container：Ask User 选择卡 / 回退压缩对话框）是否
// 正在占用输入区。读交互面容器的 DOM 事实（非空即接管），不依赖类标记——
// 历史 choice-input-active 类写在 user-input-container 上，交互面解耦后
// 已无写入方，类协议随之退役。
export function _interactiveSurfaceOccupiesInput() {
  const surface = document.getElementById('choice-input-container');
  return !!surface && surface.children.length > 0;
}

export function _renderLastCallElapsed() {
  const container = document.getElementById('user-input-container');
  if (!container) return;

  let el = container.querySelector('.call-elapsed-capsule');

  // 交互面（选择卡/回退对话框）占用输入面期间不显示运行时长胶囊（否则悬在
  // 交互卡上方）。本函数由每秒 tick 驱动，必须在这里统一拦截，否则胶囊会被
  // 重新插回。不重置 _runCapsuleStartAt：交互卡结束后回到运行态时计时应继续。
  if (_interactiveSurfaceOccupiesInput()) {
    if (el) {
      el.remove();
      _cleanupInputMetaBar(container);
    }
    return;
  }

  // 桥接期：isRuntimeCalling 定义于 runtime-status（运行时状态域收敛时改 import）
  const calling = window.isRuntimeCalling(currentRuntimeAgentId);

  // 桥接期：isChatSurfaceActive 定义于 app-ui（编排域收敛时改 import）
  if ((!calling && !lastCallFinishTime) || !window.isChatSurfaceActive()) {
    if (el) {
      el.remove();
      _cleanupInputMetaBar(container);
    }
    if (!calling) {
      _runCapsuleStartAt = 0;
      _runCapsuleStartConfirmed = false;
    }
    return;
  }

  const bar = _ensureInputMetaBar(container);

  if (!el) {
    el = document.createElement('div');
    el.className = 'call-elapsed-capsule';
    bar.insertBefore(el, bar.firstChild); // always leftmost
  }

  if (calling) {
    // 运行期间：显示整轮运行时长（已运行 X 分 Y 秒）
    // callStartedAt 优先取运行时快照。快照未到达时（如刚刷新页面）用本地时间
    // 兜底，之后的第一个有效快照值即使更早也直接采纳（服务器侧记录了真实
    // 起始时间，刷新后应回拨纠正）；确认过快照后只接受更新的起始时间，
    // 防止上一轮 call 的旧值把时钟拨回去。
    // 运行时快照来源：runtime-status 域 owner 的活绑定（本模块 import 直读）
    const snapshotStart = Number(lastRenderedNotificationRuntime?.callStartedAt) || 0;
    if (snapshotStart > 0) {
      if (!_runCapsuleStartConfirmed || snapshotStart > _runCapsuleStartAt) {
        _runCapsuleStartAt = snapshotStart;
      }
      _runCapsuleStartConfirmed = true;
    } else if (_runCapsuleStartAt <= 0) {
      _runCapsuleStartAt = Date.now();
    }
    el.classList.add('is-running');
    el.innerHTML = `${_CAPSULE_CLOCK_SVG}<span>${formatRunningElapsed(_runCapsuleStartAt)}</span>`;
    return;
  }

  _runCapsuleStartAt = 0;
  _runCapsuleStartConfirmed = false;
  el.classList.remove('is-running');
  el.innerHTML = `${_CAPSULE_CLOCK_SVG}<span>${formatCallElapsed(lastCallFinishTime)}</span>`;
}

// ── Recap (离开摘要) → modules/recap-hint.js (Phase A-7, 2026-07-03) ──

// ── 图片附件管理 ──────────────────────────────────────────────────

// 图片按宿主机落盘寻址（ADR-0006/0011）：消息里的 path 由 agent 所在机器的
// runtime 读取，附件必须落在发送目标同一台主机上。本地会话 'local'，远程
// 会话按连接维度（remote:<connectionId>）——同一连接内的会话切换无需转存。
function _imageHostKey(agentId) {
  const split = (typeof window.RemoteConnections?.splitNamespaceId === 'function')
    ? window.RemoteConnections.splitNamespaceId(agentId)
    : null;
  return split ? `remote:${split.connectionId}` : 'local';
}

/**
 * Read a File, show preview instantly via local data URL, and kick off a
 * silent background upload to get a server-side path on the host the composer
 * is currently addressing. The user never sees any upload state.
 */
function _addImageFile(file) {
  if (!file || !file.type || !file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = function() {
    const dataUrl = reader.result;

    // Entry with instant local preview; path is filled when upload completes
    const entry = {
      mediaType: file.type,
      source: file.name || '(pasted image)',
      _previewUrl: dataUrl,
      _base64: dataUrl.split(',')[1],
      _uploadPromise: null,
      _hostKey: null,
      path: null,
    };

    entry._uploadPromise = _uploadImageEntryTo(entry, currentRuntimeAgentId);
    // 上传失败在发送前的就绪解析里显式报告；此处兜底记录，避免悬挂拒绝。
    entry._uploadPromise.catch(function(err) {
      console.error('[Image Attach] Background upload failed:', err);
    });

    _imageBucket().push(entry);
    _renderAttachmentPreview();
  };
  reader.readAsDataURL(file);
}

function _uploadImageEntryTo(entry, targetAgentId) {
  // 发送目标身份随请求携带：服务端据此决定落盘本机还是转发远程同名路由
  // （ADR-0011，远程会话的 path 必须在 agent 所在主机可解析）。
  // agentId 只用于寻址，转发时不进入远程请求体。
  entry._hostKey = _imageHostKey(targetAgentId);
  entry.path = null;
  entry._uploadPromise = fetch('/protoclaw/images/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base64: entry._base64,
      mediaType: entry.mediaType,
      source: entry.source,
      agentId: targetAgentId || '',
    }),
  }).then(function(res) {
    if (!res.ok) throw new Error('Upload failed: ' + res.status);
    return res.json();
  }).then(function(data) {
    entry.path = data.path;
    entry.mediaType = data.mediaType || entry.mediaType;
    entry._previewUrl = data.url;
    return entry;
  });
  return entry._uploadPromise;
}

function _getAttachmentPreviewTargets() {
  const targets = Array.from(document.querySelectorAll('[data-attachment-preview]'));
  const legacy = document.getElementById('attachment-preview');
  if (legacy && !targets.includes(legacy)) targets.push(legacy);
  return targets;
}

export function _renderAttachmentPreview() {
  const previews = _getAttachmentPreviewTargets();
  if (previews.length === 0) return;
  const cards = Array.from(document.querySelectorAll('.user-input-card'));
  // 引用 pill（session-reference-picker 模块局部状态）与图片缩略图同区渲染
  const refChipsHtml = (typeof window.SessionReference?.chipsHtml === 'function')
    ? window.SessionReference.chipsHtml()
    : '';
  const pendingImages = _imageBucket();
  if (pendingImages.length === 0 && refChipsHtml === '') {
    previews.forEach(function(preview) {
      preview.style.display = 'none';
      preview.innerHTML = '';
    });
    cards.forEach(function(card) { card.classList.remove('has-attachments'); });
    return;
  }
  const html = pendingImages.map(function(img, idx) {
    return '<div class="attachment-thumb">' +
      '<img src="' + img._previewUrl + '" alt="' + window.escapeHtml(img.source || '') + '">' +
      '<button class="attachment-remove" type="button" data-action="composer.removePendingImage" data-args="[' + idx + ']" title="' +
        (getCurrentLanguage() === 'zh' ? '移除' : 'Remove') + '">×</button>' +
      '</div>';
  }).join('') + refChipsHtml;
  previews.forEach(function(preview) {
    preview.style.display = 'flex';
    preview.innerHTML = html;
  });
  cards.forEach(function(card) { card.classList.add('has-attachments'); });
}

/**
 * 发送前的附件就绪解析：等待后台上传收尾，并把宿主与发送目标不一致（或
 * 上传尚未成功）的附件转存到目标主机（同一连接内会话切换零成本复用）。
 * 返回可直接随消息发送的 images；failedCount > 0 时调用方必须显式中止——
 * 附件绝不静默丢弃。
 */
export async function _resolvePendingImagesForTarget(targetAgentId, bucketKey = _imageBucketKey()) {
  let failedCount = 0;
  const images = [];
  const targetHostKey = _imageHostKey(targetAgentId);
  // 只消费发送时刻捕获的会话桶：await 期间切换会话后，新会话挂载的图片
  // 绝不混入本次发送。桶数组身份不变（remove 用 splice / clear 用 delete），
  // 成员校验对捕获引用始终有效。
  const bucket = _pendingImageBuckets.get(bucketKey) || [];
  // await 期间用户可能移除附件（splice 移动索引）：快照迭代 + push 前
  // 成员校验，已移除者既不发送也不计入失败。
  const snapshot = bucket.slice();
  for (const entry of snapshot) {
    try {
      if (!bucket.includes(entry)) {
        continue; // await 期间被用户移除：不转存、不随消息发送
      }
      // 先收尾挂起的后台上传（失败则按目标重新上传拿结论），再做宿主一致性转存
      if (!entry.path && entry._uploadPromise) {
        await entry._uploadPromise.catch(function() { /* 视为未成功，下方重传 */ });
      }
      if (!bucket.includes(entry)) {
        continue; // await 期间被移除：不发送、不算失败
      }
      if (!entry.path || entry._hostKey !== targetHostKey) {
        await _uploadImageEntryTo(entry, targetAgentId);
      }
      if (!bucket.includes(entry)) {
        continue; // 转存 await 期间被移除：已转存副本留在远端无副作用，但不随消息发送
      }
      images.push({ path: entry.path, mediaType: entry.mediaType, source: entry.source });
    } catch (err) {
      if (!bucket.includes(entry)) {
        continue; // 转存失败与移除同窗口：用户已移除的附件不算失败，剩余附件照常发送
      }
      console.error('[Image Attach] upload for target failed:', err);
      failedCount += 1;
    }
  }
  return { images, failedCount };
}

/**
 * 清空指定会话的图片桶（缺省当前会话）。发送成功后按发送时刻捕获的 key
 * 清空，不误伤其他会话挂着的附件；渲染面读当前会话桶，重渲染幂等。
 */
export function clearPendingInputImages(bucketKey) {
  const key = typeof bucketKey === 'string' ? bucketKey : _imageBucketKey();
  _pendingImageBuckets.delete(key);
  _renderAttachmentPreview();
}

// ── 粘贴 / 文件选择入口（原 window 导出；唯一生产消费方 input-composer 改 import）──

export function handleInputPaste(event) {
  const items = event.clipboardData?.items;
  if (!items) return;
  let hasImage = false;
  for (const item of items) {
    if (item.type && item.type.startsWith('image/')) {
      hasImage = true;
      const file = item.getAsFile();
      if (file) _addImageFile(file);
    }
  }
  if (hasImage) {
    event.preventDefault();
  }
}

export function onImageFilesSelected(input) {
  if (!input.files) return;
  for (const file of input.files) {
    _addImageFile(file);
  }
  input.value = ''; // reset so same file can be re-selected
}

// 已收敛为模块级（全仓无其他消费面；移除动作经 composer.removePendingImage 触发）
const removePendingImage = function(idx) {
  _imageBucket().splice(idx, 1);
  _renderAttachmentPreview();
};

// ── 渲染常驻输入框 ────────────────────────────────────────────────

// Composer 卡常驻 DOM（input-composer.js）：persistent 端点只是模式属性，
// 这里做幂等的"确保挂载 + 属性级更新 + 会话重绑"，不再每次新建元素。
export function renderPersistentInput(container) {
  // 先渲染队列气泡（桥接期：定义于 p2-w2-3a-queue-projection，队列投影域收敛时改 import）
  window._renderQueueBubbles(container);

  const card = showPersistentComposerCard(container);
  applyComposerMode(card);
  syncPersistentComposerSessionCard(container);
  // 桥接期：定义于 p2-w2-3a-queue-projection（队列投影域收敛时改 import）
  window._syncPersistentInputUi();
  // Restore attachment preview if there are pending images (e.g. after re-render)
  _renderAttachmentPreview();
  // Update model switcher button with current preset name
  // 桥接期：定义于 input-model-switcher（模型切换域收敛时改 import）
  window.updateInputModelSwitcher();
  // Update thinking effort switcher button
  window.updateThinkingEffortSwitcher();
}

export function onPersistentBtnClick(submit) {
  const btn = document.getElementById('persistent-action-btn');
  if (!btn) return;
  if (_submitInFlight) return;         // fetch 进行中：阻止连点（防误触暂停）
  if (btn.classList.contains('is-interrupting')) return;
  // 输入框有内容时，按钮的语义是发送，即使 runtime 正在处理上一轮；
  // user-turn 会由 ViewerWorker 排队。仅空输入时才把 stop 状态解释为中断。
  // 这也避免轮询状态滞后把一个已空闲 runtime 永久卡在 stop 按钮上。
  const textarea = btn.closest('.user-input-card')?.querySelector('.user-input-textarea');
  const hasText = !!textarea?.value?.trim();
  const hasImages = _imageBucket().length > 0;
  const hasSessionReferences = (window.SessionReference?.peek?.() || []).length > 0;
  if (btn.classList.contains('is-stop') && !hasText && !hasImages && !hasSessionReferences) {
    interruptAgent();
    return;
  }
  if (voiceTranscribing) return;
  if (voiceRecording) {
    setVoicePendingSend(true);
    // 桥接期：定义于 voice-input（voice-input-api 域，语音域收敛时改 import）
    window.stopVoiceRecording();
    return;
  }
  if (voiceStopping) {
    setVoicePendingSend(true);
    return;
  }
  return typeof submit === 'function' ? submit() : submitQueuedInput();
}

function _setActionBtnStop() {
  if (_submitInFlight || _sendingHoldTimer) return; // 提交/保持窗口内维持 sending 态，轮询同步不得覆盖
  const btn = document.getElementById('persistent-action-btn');
  if (!btn) return;
  btn.classList.remove('is-interrupting', 'is-sending');
  btn.classList.add('is-stop');
  btn.removeAttribute('aria-busy');
  btn.title = getCurrentLanguage() === 'zh' ? '停止当前任务' : 'Stop current task';
  const iconSend = btn.querySelector('.icon-send');
  const iconStop = btn.querySelector('.icon-stop');
  if (iconSend) iconSend.style.display = 'none';
  if (iconStop) iconStop.style.display = '';
}

function _setActionBtnInterrupting() {
  if (_submitInFlight || _sendingHoldTimer) return;
  const btn = document.getElementById('persistent-action-btn');
  if (!btn) return;
  btn.classList.remove('is-sending');
  btn.classList.add('is-stop', 'is-interrupting');
  btn.setAttribute('aria-busy', 'true');
  btn.title = getCurrentLanguage() === 'zh' ? '正在停止当前任务…' : 'Stopping current task…';
  const iconSend = btn.querySelector('.icon-send');
  const iconStop = btn.querySelector('.icon-stop');
  if (iconSend) iconSend.style.display = 'none';
  if (iconStop) iconStop.style.display = '';
}

function _setActionBtnSend() {
  if (_submitInFlight || _sendingHoldTimer) return;
  const btn = document.getElementById('persistent-action-btn');
  if (!btn) return;
  btn.classList.remove('is-stop', 'is-interrupting', 'is-sending');
  btn.removeAttribute('aria-busy');
  btn.title = getCurrentLanguage() === 'zh' ? '发送' : 'Send';
  const iconSend = btn.querySelector('.icon-send');
  const iconStop = btn.querySelector('.icon-stop');
  if (iconSend) iconSend.style.display = '';
  if (iconStop) iconStop.style.display = 'none';
}

// 发送进行中（点击/Enter → 投递落定）：两种 composer 端点共用 spinner，
// 覆盖图片转存 + fetch 的整个提交窗口；恢复后重新读取运行态。
function _setActionBtnSending() {
  const btn = document.getElementById('persistent-action-btn');
  if (!btn) return;
  btn.classList.remove('is-stop', 'is-interrupting');
  btn.classList.add('is-sending');
  btn.setAttribute('aria-busy', 'true');
  btn.title = getCurrentLanguage() === 'zh' ? '发送中…' : 'Sending…';
  const iconSend = btn.querySelector('.icon-send');
  const iconStop = btn.querySelector('.icon-stop');
  if (iconSend) iconSend.style.display = 'none';
  if (iconStop) iconStop.style.display = 'none';
}

// 提交窗口结束后恢复到当前运行态，而非固定恢复发送。
function _restoreActionBtnAfterSubmit() {
  _syncPersistentActionButton();
}

// ── 发送反馈窗口（所有提交路径共用）──────────────────────────────────
//
// 间歇性"点了没转圈、消息直接蹦出去"的根因是渲染时机：spinner 类设置后、
// 浏览器绘制前，本地直投的 fetch 可能已落定并移除类（或点击后主线程被
// 轮询渲染短暂阻塞挤掉了 paint 机会）——spinner 从未被画出来。双保险：
//   1. paint 门槛：设置 spinner 后等双 rAF 再发请求，保证至少绘制一次；
//      此后即使主线程阻塞，transform 旋转由 compositor 驱动继续转动。
//   2. 最短可见保持：fetch 快于阈值时恢复延迟到阈值，反馈不被一闪带过。

const _SENDING_MIN_VISIBLE_MS = 300;

function _nextPaint() {
  return new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

function _beginSubmitFeedbackWindow() {
  if (_sendingHoldTimer) {
    clearTimeout(_sendingHoldTimer);
    _sendingHoldTimer = null;
  }
  _sendingStartedAt = Date.now();
  _setActionBtnSending();
}

function _endSubmitFeedbackWindow() {
  const remain = _SENDING_MIN_VISIBLE_MS - (Date.now() - _sendingStartedAt);
  if (remain > 0) {
    _sendingHoldTimer = setTimeout(() => {
      _sendingHoldTimer = null;
      // hold 到期前新提交已开启新窗口（其 begin 会清掉本 timer），此处
      // 只在窗口确已空闲时恢复
      if (!_submitInFlight) _restoreActionBtnAfterSubmit();
    }, remain);
  } else {
    _restoreActionBtnAfterSubmit();
  }
}

export function _syncPersistentActionButton() {
  if (currentRuntimeAgentId && isInterruptSuppressed(currentRuntimeAgentId)) {
    _setActionBtnInterrupting();
  } else if (currentRuntimeAgentId
    && window.isRuntimeCalling(currentRuntimeAgentId)) { // 桥接期：定义于 runtime-status
    _setActionBtnStop();
  } else {
    _setActionBtnSend();
  }
}

// ── 排队气泡渲染 / 后端队列同步 / SSE 快照消费 →
//     p2-w2-3a-queue-projection.js（P2 W2-3a，esm）────────────────────
// 该域五个入口仍以 input-queue 域的 behavior 桥键服务其他消费方

/**
 * 排队气泡投影的会话重绑（幂等）：runtime 变化时旧投影立即失效。新会话
 * 的队列优先从 SSE 快照缓存恢复（_lastQueuedSnapshots 本就按 runtime
 * 缓存非焦点期间的队列变化）；缓存缺席时置空，由轮询 / SSE 事件在下个
 * 周期补齐。
 *
 * 读写的是 input-queue 域 owner（import 的活绑定 + setter）。消费方
 * input-render（首屏渲染链与每次输入面渲染）与 queue-projection 经桥键调用。
 */
export function rebindQueueProjectionForRuntime(runtimeId) {
  const next = String(runtimeId || '').trim();
  if (String(queuedProjectionRuntimeId || '').trim() === next) return;
  setQueuedProjectionRuntimeId(next || null);
  setQueuedTexts([]);
  setPendingQueuedCount(0);
  setLocalQueuedInputPending(false);
  if (queuedProjectionRuntimeId) {
    // 既有公开命名空间协议（sse-client 的排队快照缓存对外面）
    const cached = window.ClawFW?.SseClient?.getLastQueuedSnapshot?.(queuedProjectionRuntimeId);
    if (cached && Array.isArray(cached.items)) {
      const texts = window.ClawFW?.SseClient?.reconcileQueuedTexts?.(
        cached.items, Date.now(), queuedProjectionRuntimeId) || [];
      setQueuedTexts(texts.slice());
      // 待发送计数只认未被领取的用户输入：已 claim（inputLease）的项正在
      // 执行，不是排队（与 reconcileQueuedTexts 的展示过滤同一语义）
      setPendingQueuedCount(cached.items.filter((item) => item?.kind !== 'reminder' && !item?.inputLease).length);
    }
  }
  setLastQueueBubbleSignature('');
}

export function handlePersistentInputKey(event) {
  if (event.key === 'Enter') {
    if (event.ctrlKey || event.shiftKey) {
      return;
    }
    event.preventDefault();
    if (voiceTranscribing) {
      setVoicePendingSend(true);
      return;
    }
    if (voiceRecording) {
      setVoicePendingSend(true);
      // 桥接期：定义于 voice-input（voice-input-api 域，语音域收敛时改 import）
      window.stopVoiceRecording();
      return;
    }
    submitQueuedInput();
  }
}

export async function submitQueuedInput() {
  if (_submitInFlight) return;
  // 首次发送消息时请求桌面通知权限（用户手势内请求）-> modules/desktop-notify.js
  // 桥接期：classic 顶层函数（桌面通知域收敛时改 import）
  window._requestNotifyPermission();
  const textarea = document.getElementById('input-persistent');
  if (!textarea) return;
  const text = textarea.value.trim();
  const sessionReferenceCount = (window.SessionReference?.peek?.() || []).length;
  if (!text && _imageBucket().length === 0 && sessionReferenceCount === 0) return;
  const targetRuntimeId = currentRuntimeAgentId;
  // 桥接期：定义于 session-view-state（会话视图状态域收敛时改 import）
  const viewToken = window.captureSessionViewToken(targetRuntimeId);
  const echoFromIndex = currentMessages.length;
  // 一致性校验后的线程输入目标（getActiveThreadInputTarget）：全局指向与
  // 当前视图不符（用户已切走、残留未清）时为 null——消息走当前视图常规
  // 路径，绝不串到别的线程（会话绝对隔离）。
  const activeConversation = window.getActiveThreadInputTarget?.();
  const targetCacheKey = textarea.dataset.sessionKey || window._getSessionInputCacheKey();
  // 图片桶 key 同步捕获（与 targetCacheKey 同款防漂移语义）：await 期间切换
  // 会话后，resolve / 成功清空只作用于发起会话的桶。
  const targetImageKey = _imageBucketKey();

  _submitInFlight = true;
  // 乐观 UI：立即进入 sending 态（spinner），覆盖点击 → user-turn 落定的
  // 整个提交窗口（含图片转存等待）。_submitInFlight 守卫确保此期间点击与
  // 轮询同步都不会把按钮切走或触发 interruptAgent。
  _beginSubmitFeedbackWindow();

  let capabilityActivations = null;
  // 会话引用快照：try 外声明（catch 归还路径可见；try 内 const 会让 catch
  // 拿到 ReferenceError 而不是空数组——B1 审查修复）
  let sessionRefs = [];
  try {
    // paint 门槛：spinner 画出来之后再发请求，杜绝"类设置了但从未绘制"
    // 导致点击无反馈、消息直接蹦出的间歇性空窗
    await _nextPaint();
    // 图片就绪：等待后台上传，并把宿主与发送目标不一致的附件转存过去。
    // 任何附件失败都显式中止（输入与预览保留，供用户重试），绝不静默丢弃。
    const resolved = await _resolvePendingImagesForTarget(targetRuntimeId, targetImageKey);
    if (resolved.failedCount > 0) {
      throw new Error(getCurrentLanguage() === 'zh'
        ? '部分图片上传失败：请重试或移除失败的附件'
        : 'Some image uploads failed: retry or remove the failed attachments');
    }
    const images = resolved.images;
    // 准备阶段尚未投递；导航后保留原草稿，不读取新会话的线程或附件。
    if (!isSessionViewTokenCurrent(viewToken)) {
      window.ClawToast?.show?.({
        id: `input-navigation-${targetRuntimeId}`,
        status: 'info',
        title: getCurrentLanguage() === 'zh' ? '会话已切换，消息尚未发送' : 'Session changed; message not sent',
        description: getCurrentLanguage() === 'zh' ? '草稿已保留，切回原会话后可重试。' : 'Your draft is preserved. Return to the original session to retry.',
      });
      return;
    }

    if (activeConversation?.threadId && typeof window.submitThreadInput === 'function') {
      sessionRefs = window.SessionReference?.consume?.() || [];
      capabilityActivations = window.ClawSlash?.consumeActivations?.() || null;
      const result = await window.submitThreadInput(activeConversation.threadId, {
        text: text || ' ',
        images,
        source: 'chat-composer',
        ...(capabilityActivations?.length ? { capabilityActivations } : {}),
        ...(sessionRefs.length ? { metadata: { 'session-reference': sessionRefs } } : {}),
      });
      const liveTextarea = document.getElementById('input-persistent')
        || document.querySelector('.user-input-textarea:not([disabled])');
      if (liveTextarea && (liveTextarea.dataset?.sessionKey || window._getSessionInputCacheKey()) === targetCacheKey) {
        liveTextarea.value = '';
        autoResize(liveTextarea);
      }
      clearPendingInputImages(targetImageKey);
      if (targetCacheKey) delete sessionInputCache[targetCacheKey];
      // 桥接期：定义于 recap-hint（recap-hint 域桥键，离开摘要域收敛时改 import）
      window._clearRecapForNewMessage();
      window.refreshThreads?.(true);
      // 桥接期：定义于 p2-w2-3a-queue-projection（队列投影域收敛时改 import）
      window.updateQueueIndicator();
      // 线程寻址端点只回答两件事：输入是否被接住（HTTP 成功 = 是），以及
      // 本次投递尝试是否当场送达（deliveryAttempt.delivered）。交接挡板 /
      // head runtime 未就绪时 delivered=0 是正常状态——指令已在 Thread Inbox，
      // 由 runtime-ready / head 推进触发点补投。
      //
      // 因此：送达 = 安静成功（不弹常驻提示）；未送达 = 提示「已暂存」。
      // 正常对话的成功发送不弹 toast。
      const delivered = Number(result?.deliveryAttempt?.delivered) > 0;
      if (delivered) {
        // 与直投成功路径同构：清打断抑制、标记 call 已开始（发送按钮转停止）、
        // 跟随最新。线程域投递经 bridge 转 viewer user-turn，无法区分 viewer
        // 直投与忙时排队，故不做乐观回显（避免与排队气泡重复），消息由
        // 立即轮询 / SSE 回流。
        if (targetRuntimeId) {
          clearInterruptSuppression(targetRuntimeId);
          window._markAgentCallStartedForNotify(targetRuntimeId); // 桥接期：desktop-notify（classic）
          callActivity._agentCallActive.set(targetRuntimeId, true);
          _syncPersistentActionButton();
          window.renderAgentList(); // 桥接期：sidebar-render（classic）
        }
        if (isSessionViewTokenCurrent(viewToken)) {
          if (typeof window.beginFollowLatestEntryWindow === 'function') window.beginFollowLatestEntryWindow();
          if (typeof window.requestFollowLatest === 'function') {
            window.requestFollowLatest({ forceEnable: true, behavior: 'auto' });
          }
          window.ClawFW?.requestImmediatePoll?.();
        }
      } else {
        window.ClawToast?.show?.({
          id: `thread-staged-input-${activeConversation.threadId}`,
          status: 'info',
          title: getCurrentLanguage() === 'zh'
            ? '已暂存 · 新会话就绪后自动继续'
            : 'Staged · will continue in the successor session',
          autoDismiss: 5000,
        });
      }
      return;
    }

    capabilityActivations = window.ClawSlash?.consumeActivations?.() || null;
    // 会话引用随消息流动（一次性附件语义）：consume 取走 pill，失败时归还。
    // agent calling 中排队输入由 react-loop call 内注入消费，metadata 经
    // dispatchTurnMetadata 派发（reminder 随注入点落位），无需前端拦截。
    sessionRefs = window.SessionReference?.consume?.() || [];
    const turnMetadata = sessionRefs.length > 0
      ? { 'session-reference': sessionRefs }
      : null;
    const res = await fetch(`/api/agents/${targetRuntimeId}/user-turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-idempotency-key': newIdempotencyKey() },
      body: JSON.stringify({
        text: text || ' ',
        images: images.length > 0 ? images : undefined,
        source: 'chat-composer',
        ...(capabilityActivations?.length ? { capabilityActivations } : {}),
        ...(turnMetadata ? { metadata: turnMetadata } : {}),
        operationId: `user-turn:${Date.now()}`,
      })
    });
    if (res.ok) {
      const delivery = await res.json().catch(() => ({}));
      // await 期间输入面可能重渲染：定位当前 live textarea（回落到容器内
      // 唯一 composer 输入框），并校验仍属同一会话——已发送文本不得残留或
      // 经草稿写回"复活"。
      const liveTextarea = document.getElementById('input-persistent')
        || document.querySelector('.user-input-textarea:not([disabled])');
      if (liveTextarea
        && (liveTextarea.dataset?.sessionKey || window._getSessionInputCacheKey()) === targetCacheKey) {
        liveTextarea.value = '';
        autoResize(liveTextarea);
      }
      clearPendingInputImages(targetImageKey);
      if (targetCacheKey) delete sessionInputCache[targetCacheKey];
      const stillOwnsView = isSessionViewTokenCurrent(viewToken);
      if (stillOwnsView) {
        window._clearRecapForNewMessage(); // 桥接期：定义于 recap-hint
        // 桥接期：定义于 chat-viewport（聊天视口域收敛时改 import）
        window.beginFollowLatestEntryWindow();
        window.requestFollowLatest({ forceEnable: true, behavior: 'auto' });
      }
      // 只有当 agent 正在 calling 时才显示排队气泡。
      // agent 空闲时后端会立即消费输入，不需要排队指示。
      if (delivery.delivery === 'thread_queued') {
        // 网关域判定（R6）：线程 head 的输入一律先入 Thread Inbox 再做
        // 即时投递尝试。deliveryAttempt.delivered > 0 表示已当场送达
        // 运行中的 head 会话，反馈对齐直投成功路径；仅真滞留（交接挡板
        // / hold / runtime 未就绪）才提示已暂存。刷新线程数据以同步
        // pendingTexts（真滞留时渲染暂存气泡）。
        window.refreshThreads?.(true);
        window.updateQueueIndicator(); // 桥接期：定义于 p2-w2-3a-queue-projection
        if (Number(delivery.deliveryAttempt?.delivered) > 0) {
          if (targetRuntimeId) {
            clearInterruptSuppression(targetRuntimeId);
            window._markAgentCallStartedForNotify(targetRuntimeId); // 桥接期：desktop-notify
            callActivity._agentCallActive.set(targetRuntimeId, true);
            _syncPersistentActionButton();
            window.renderAgentList(); // 桥接期：sidebar-render
          }
        } else {
          window.ClawToast?.show?.({
            id: `thread-staged-gw-${targetRuntimeId}`,
            status: 'info',
            title: getCurrentLanguage() === 'zh' ? '已暂存 · 新会话就绪后自动继续' : 'Staged · will continue in the successor session',
            autoDismiss: 5000,
          });
        }
      } else if (delivery.delivery === 'queued') {
        // SSE 乱序防护（F5）：事件帧先到时快照已含该排队项，POST 响应后到
        // 不再乐观 push，避免气泡瞬时重复（约 1s 才能对账消除）
        const queueClient = window.ClawFW?.SseClient;
        const queueText = text || (images.length ? '🖼' : '') || ' ';
        const shouldProject = !delivery.id || !queueClient?.noteQueuedOptimistic
          || queueClient.noteQueuedOptimistic(delivery.id, queueText, targetRuntimeId);
        if (shouldProject && stillOwnsView) {
          // 乐观气泡只写入提交目标的投影：await 期间用户可能已切走，新会话
          // 的输入面不冒出本会话的排队文本（服务端队列与 SSE 乐观锚点仍
          // 完整记录，切回时经快照恢复）。
          setLocalQueuedInputPending(true);
          setPendingQueuedCount(pendingQueuedCount + 1);
          queuedTexts.push(text || (images && images.length ? '🖼' : '') || ' ');
        }
        window.updateQueueIndicator(); // 桥接期：定义于 p2-w2-3a-queue-projection
      } else if (targetRuntimeId) {
        // 空闲直投（lease / 即时消费）：乐观回显先上屏，真实消息经
        // poll 回流后由对账无缝替换；排队路径走上方气泡，不回显。
        // 引用 chips 只随乐观气泡呈现（服务端消息不持久化引用字段，
        // 引用的持久化产物是随后出现的 session-reference reminder）
        if (stillOwnsView) {
          window.ClawFW?.pushOptimisticUserEcho?.({ text, images, sessionReferences: sessionRefs, fromIndex: echoFromIndex });
        }
        clearInterruptSuppression(targetRuntimeId);
        window._markAgentCallStartedForNotify(targetRuntimeId); // 桥接期：desktop-notify
        callActivity._agentCallActive.set(targetRuntimeId, true);
        _syncPersistentActionButton();
        window.renderAgentList(); // 桥接期：sidebar-render
      }
      // 排队乐观态/提交完成后的状态变化（工单 037）：声明变更即可，
      // 渲染器按签名差异决定是否重建。
      window.notifyInputSurfaceChanged(currentInputRequests || []); // 桥接期：定义于 input-render
      // 削掉 0–300ms 轮询相位：立即取一轮状态/消息（in-flight 自守卫）
      window.ClawFW?.requestImmediatePoll?.();
    } else {
      const error = await res.json().catch(() => ({}));
      const submissionError = new Error(error.error || error.message || `HTTP ${res.status}`);
      // 服务端 operation-contract 把 viewer 的具体拒因归一成稳定码
      // （input_mode_conflict → code=operation_rejected），原码进 legacyCode；
      // 判定必须同时看两处，否则 choice 竞态窗口的 409 退化成通用失败提示。
      submissionError.code = error.code || '';
      submissionError.legacyCode = error.legacyCode || '';
      throw submissionError;
    }
  } catch (e) {
    console.error('排队输入提交失败:', e);
    // 消息未发出：归还激活 refs 与会话引用，输入框重试发送时仍携带
    if (capabilityActivations?.length) {
      window.ClawSlash?.restoreActivations?.(capabilityActivations);
    }
    if (sessionRefs?.length) {
      window.SessionReference?.restore?.(sessionRefs);
    }
    const isChoiceConflict = e?.legacyCode === 'input_mode_conflict' || e?.code === 'input_mode_conflict';
    window.ClawToast?.show({
      id: `user-turn-failed-${targetRuntimeId}`,
      status: isChoiceConflict ? 'info' : 'error',
      title: isChoiceConflict
        ? (getCurrentLanguage() === 'zh' ? '请先完成选择' : 'Please complete the pending choice first')
        : (getCurrentLanguage() === 'zh' ? '消息发送失败' : 'Failed to send message'),
      description: isChoiceConflict
        ? (getCurrentLanguage() === 'zh' ? '输入内容已保留，完成选择后可继续发送。' : 'Your draft is preserved. Send it after completing the choice.')
        : (e instanceof Error ? e.message : String(e)),
      autoDismiss: 6000,
    });
  } finally {
    _submitInFlight = false;
    _endSubmitFeedbackWindow();
  }
}

// 返回 { ok } 供编排方（如运行期回退 rollback-dialog.js）判断结果：
//   { ok: true }                    — 打断请求已被服务端接受
//   { ok: false, reason }           — 未发出或失败（'no-runtime' / 'suppressed'
//                                     / 'request-failed'，失败原因已自行 toast）
export async function interruptAgent() {
  if (!currentRuntimeAgentId) return { ok: false, reason: 'no-runtime' };
  const targetRuntimeId = currentRuntimeAgentId;
  if (isInterruptSuppressed(targetRuntimeId)) return { ok: false, reason: 'suppressed' };
  // 桥接期：定义于 runtime-status（运行时状态域收敛时改 import）
  const wasCalling = window.isRuntimeCalling(targetRuntimeId);

  // 立即进入粘性的 interrupting 状态；中间阶段仍然是“正在停止”，绝不伪装成
  // idle。后续同一 call 的 callActive:true 只是排空中的旧状态，不能恢复按钮。
  markInterruptPending(targetRuntimeId, getNotificationCallStartedAt(lastNotificationStatusPayload));
  callActivity._agentCallActive.delete(targetRuntimeId);
  setLocalQueuedInputPending(false);
  setPendingQueuedCount(0);
  setQueuedTexts([]);
  setQueuedProjectionRuntimeId(String(targetRuntimeId || '').trim() || null);
  setLastQueueBubbleSignature('');
  window.updateQueueIndicator(); // 桥接期：定义于 p2-w2-3a-queue-projection
  _setActionBtnInterrupting();
  // 明确展示过渡态，直到同一 call 的终态到达。
  const statusEl = document.getElementById('notification-status');
  if (statusEl) {
    statusEl.style.display = 'flex';
    statusEl.className = 'notification-status active is-interrupting';
    const phaseEl = document.getElementById('notification-phase');
    const summaryEl = document.getElementById('notification-summary');
    const metricsEl = document.getElementById('notification-metrics');
    if (phaseEl) phaseEl.textContent = getCurrentLanguage() === 'zh' ? '正在停止…' : 'Stopping…';
    if (summaryEl) summaryEl.textContent = getCurrentLanguage() === 'zh'
      ? '等待当前步骤安全退出'
      : 'Waiting for the current step to exit safely';
    if (metricsEl) metricsEl.innerHTML = '';
  }
  setLastRenderedNotificationRuntime(null);
  window.renderAgentList(); // 桥接期：sidebar-render（classic）

  console.log(`[Interrupt] sending POST /api/agents/${targetRuntimeId}/interrupt`);
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(targetRuntimeId)}/interrupt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-idempotency-key': newIdempotencyKey() },
    });
    const data = await res.json().catch(() => ({}));
    console.log(`[Interrupt] response:`, res.status, data);
    if (!res.ok || data?.success === false || data?.error) {
      throw new Error(data?.error || `HTTP ${res.status}`);
    }
    return { ok: true };
  } catch (e) {
    console.error('[Interrupt] request failed:', e);
    // 请求没有被接受时才回滚 interrupting。成功请求没有任何超时回滚；它必须
    // 等待 call.finish/callActive:false，以免旧轮询制造“假恢复”。
    clearInterruptSuppression(targetRuntimeId);
    if (wasCalling) callActivity._agentCallActive.set(targetRuntimeId, true);
    // 桥接期：normalizeAgentIdentity 定义于 app-core（classic）
    if (window.normalizeAgentIdentity(currentRuntimeAgentId) === window.normalizeAgentIdentity(targetRuntimeId)) {
      _syncPersistentActionButton();
      // 桥接期：updateNotificationStatus 定义于 runtime-status（classic）
      window.updateNotificationStatus(lastNotificationStatusPayload || null);
    }
    window.renderAgentList(); // 桥接期：sidebar-render（classic）
    window.ClawToast?.show?.({
      id: `interrupt-failed-${targetRuntimeId}`,
      status: 'error',
      title: getCurrentLanguage() === 'zh' ? '停止请求失败' : 'Stop request failed',
      description: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, reason: 'request-failed', error: e };
  }
}

// ── 启动上次对话结束时间计时器 ───

_callFinishTimerInterval = setInterval(_renderLastCallElapsed, 1000);

// ── 分发器动作（原模板内联事件收编，命名空间 composer.*）──────────
window.ClawFW.actions.registerMany({
  'composer.removePendingImage': (el, event, idx) => removePendingImage(idx),
});

// ── 兼容桥（未迁移消费方收敛后注销）────────────────────────────────────────
// 函数键落 `persistent-input-api` 域：状态键的域（input-queue / input-call-elapsed）
// 已由 p2-w2-3a-* owner claim，且与本文件函数无归属关系；函数键独立成域，
// 便于逐键按消费面归零注销。
const BRIDGE_FUNCTIONS = {
  renderPersistentInput,
  rebindQueueProjectionForRuntime,
  _renderLastCallElapsed,
  resetCallElapsedForSwitch,
  _ensureInputMetaBar,
  _cleanupInputMetaBar,
  _interactiveSurfaceOccupiesInput,
  _renderAttachmentPreview,
  migratePendingInputImages,
  _syncPersistentActionButton,
  submitQueuedInput,
  interruptAgent,
};

// 逐键消费方（grep public/，排除定义方）与注销条件：
//   renderPersistentInput            ← input-render（window.）
//   rebindQueueProjectionForRuntime  ← input-render / p2-w2-3a-queue-projection（window.）
//   _renderLastCallElapsed           ← input-render（window.）/ runtime-status（裸调用）
//   resetCallElapsedForSwitch        ← runtime-status（typeof 裸守卫）
//   _ensureInputMetaBar              ← recap-hint（window.）
//   _cleanupInputMetaBar             ← recap-hint（window.）
//   _interactiveSurfaceOccupiesInput ← p2-w2-3a-queue-projection（window.）
//   _renderAttachmentPreview         ← session-reference-picker（window.，typeof 守卫）
//   migratePendingInputImages        ← thread-store（window.，可选链；原为散装 window 赋值）
//   _syncPersistentActionButton      ← app-main / sidebar-render（闭包内裸调用）/
//                                      input-actions / generative-ui-panel（window.）
//   submitQueuedInput                ← voice-input（window.）
//   interruptAgent                   ← rollback-dialog-runtime（window.）
// 注销条件：以上消费方迁 ESM 并改为 import 之后。
window.KernelState.defineKey('persistent-input-api', 'renderPersistentInput', renderPersistentInput);
window.KernelState.defineKey('persistent-input-api', 'rebindQueueProjectionForRuntime', rebindQueueProjectionForRuntime);
window.KernelState.defineKey('persistent-input-api', '_renderLastCallElapsed', _renderLastCallElapsed);
window.KernelState.defineKey('persistent-input-api', 'resetCallElapsedForSwitch', resetCallElapsedForSwitch);
window.KernelState.defineKey('persistent-input-api', '_ensureInputMetaBar', _ensureInputMetaBar);
window.KernelState.defineKey('persistent-input-api', '_cleanupInputMetaBar', _cleanupInputMetaBar);
window.KernelState.defineKey('persistent-input-api', '_interactiveSurfaceOccupiesInput', _interactiveSurfaceOccupiesInput);
window.KernelState.defineKey('persistent-input-api', '_renderAttachmentPreview', _renderAttachmentPreview);
window.KernelState.defineKey('persistent-input-api', 'migratePendingInputImages', migratePendingInputImages);
window.KernelState.defineKey('persistent-input-api', '_syncPersistentActionButton', _syncPersistentActionButton);
window.KernelState.defineKey('persistent-input-api', 'submitQueuedInput', submitQueuedInput);
window.KernelState.defineKey('persistent-input-api', 'interruptAgent', interruptAgent);

window.KernelState.claim('persistent-input-api', {
  get(key) {
    return BRIDGE_FUNCTIONS[key];
  },
  set(key, value) {
    BRIDGE_FUNCTIONS[key] = value;
  },
});

// 测试缝（P4 迁移）：发送窗口计时 / 胶囊起始确认 / 图片桶是模块私有状态
// （零生产跨文件消费方，不上桥）。迁移前的用例经全局词法作用域直接读写它们；
// ESM 后词法绑定对外不可写，这里给出显式读写入口，不参与生产逻辑。
export const __testInputState = {
  get submitInFlight() { return _submitInFlight; },
  set submitInFlight(value) { _submitInFlight = value; },
  get sendingHoldTimer() { return _sendingHoldTimer; },
  set sendingHoldTimer(value) { _sendingHoldTimer = value; },
  get sendingStartedAt() { return _sendingStartedAt; },
  set sendingStartedAt(value) { _sendingStartedAt = value; },
  get runCapsuleStartAt() { return _runCapsuleStartAt; },
  set runCapsuleStartAt(value) { _runCapsuleStartAt = value; },
  get runCapsuleStartConfirmed() { return _runCapsuleStartConfirmed; },
  set runCapsuleStartConfirmed(value) { _runCapsuleStartConfirmed = value; },
  get pendingImageBuckets() { return _pendingImageBuckets; },
  /** 当前会话的待发送桶（同一引用，测试用它播种/观察附件）。 */
  get imageBucket() { return _imageBucket(); },
};
