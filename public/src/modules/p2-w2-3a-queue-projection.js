/**
 * p2-w2-3a-queue-projection.js — 输入面排队气泡投影与后端队列同步（P2 第二波 3a）。
 *
 * 从 persistent-input.js 原位迁出（搬代码不改行为）：队列气泡渲染、后端队列
 * 快照同步、SSE 事件快照消费与输入面声明。持久输入面的提交/中断/图片附件
 * 与「上一次对话结束时间」胶囊仍留在 classic persistent-input.js。
 *
 * 为什么这几支能迁、`rebindQueueProjectionForRuntime` 不能：
 *   首屏同步链（app-main 顶层 applyLanguage → renderCurrentMainView →
 *   notifyInputSurfaceChanged → renderInputRequests）在 classic 相直接调用
 *   `rebindQueueProjectionForRuntime`，因此它保留唯一 classic 实现（也是本域
 *   唯一首屏触达点）；本模块的四个入口全部由轮询 / SSE / 持久输入面渲染触发，
 *   晚于 deferred 模块执行，登记为 behavior 桥键即可服务 classic 消费方。
 *
 * 状态：唯一 owner 是 p2-w2-3a-input-queue-state.js（活绑定 + setter）。
 * 本模块只持有 `_persistentUiSyncInFlight`（并发守卫，零跨文件读者 → 模块私有）。
 *
 * 依赖形态（与原实现一一对应，搬迁不改变调用语义）：
 *   - 已 ESM：`currentRuntimeAgentId`（编排域）、`currentInputRequests`（会话视图
 *     存储）、`isSessionViewTokenCurrent`（session-view-commit 策略）、
 *     `updateInputModelSwitcher` / `updateThinkingEffortSwitcher`
 *     （input-model-switcher）、`isSseActive` / `getLastQueuedSnapshot` /
 *     `reconcileQueuedTexts`（sse-client 传输层）→ **直接 import**；
 *   - 仍 classic 且原实现就是**无守卫直调**：`captureSessionViewToken`
 *     （session-view-state）、`notifyInputSurfaceChanged`（input-render）、
 *     `rebindQueueProjectionForRuntime` / `_syncPersistentActionButton`
 *     （persistent-input）、`isRuntimeCalling`（runtime-status）、
 *     `_interactiveSurfaceOccupiesInput`（persistent-input）
 *     → 显式 `window.X(...)`，**不加 typeof 守卫**：缺实现应当响亮失败，不静默跳过；
 *   - 线程暂存文本（`getThreadPendingTexts`）已由交互域具名导出 → 直接 import。
 *     原实现是「classic 引擎尚未定义该函数时按空处理」的可选守卫；迁到 ESM 后
 *     该函数与暂存文本投影同在 deferred 相（同一张真实图），守卫失去语义，
 *     不再保留（否则等于把"实现可能缺席"写进契约）。
 *
 * 与 sse-client 的双向静态环（本模块读传输层状态，sse-client 读本模块的
 * `applyQueuedInputsTexts`）：两侧都只在函数体内调用对端绑定，模块求值期
 * 零解引用；求值顺序无关，真实整图由本批用例（kernel-entry 入口）执行。
 *
 * 桥键（domain `input-queue`，ESM 相注册；逐键消费证据见批次交付报告）：
 *   - `_renderQueueBubbles`           ← persistent-input.js `renderPersistentInput`
 *   - `updateQueueIndicator`          ← thread-store.js / app-main.js
 *   - `_syncQueueFromBackend`         ← runtime-status.js / generative-ui-panel.js
 *   - `_syncPersistentInputUi`        ← runtime-status.js / app-main.js
 *   - `applyQueuedInputsTexts`        ← 已注销：唯一消费方 sse-client 改具名
 *     import 后零 window 消费方（本批注销 defineKey；命名导出保留，ESM 消费方
 *     继续 import）。
 *   注销条件：上述 classic 消费方改 import 之后。
 */

import { currentRuntimeAgentId } from './orchestration-state.js';
import { currentInputRequests } from './session-view-storage.js';
import { isSessionViewTokenCurrent } from './session-view-commit-host.js';
import { getThreadPendingTexts } from './thread-store-domain.js';
import { updateInputModelSwitcher, updateThinkingEffortSwitcher } from './input-model-switcher.js';
import { isSseActive, getLastQueuedSnapshot, reconcileQueuedTexts } from './sse-client.js';
import {
  queuedTexts,
  lastQueueBubbleSignature,
  setPendingQueuedCount,
  setQueuedTexts,
  setLocalQueuedInputPending,
  setLastQueueBubbleSignature,
  setQueuedProjectionRuntimeId,
} from './p2-w2-3a-input-queue-state.js';

// 队列同步并发守卫（原 `_persistentUiSyncInFlight`）：零跨文件读者，模块私有。
let persistentUiSyncInFlight = false;

export function _renderQueueBubbles(container) {
  // 交互面（选择卡/回退对话框）占用输入面期间，暂存/排队气泡不能出现在
  // 交互卡上方。updateQueueIndicator() 可能与交互面状态变更交错调用，因此
  // 这里也要做最后一道 DOM 侧守卫，而不能只依赖 input-render 的互斥清理。
  // 桥接期：_interactiveSurfaceOccupiesInput 定义于 persistent-input
  // （classic，`_renderLastCallElapsed` 的 1s tick 也在用它，故未随本批迁出）
  if (window._interactiveSurfaceOccupiesInput()) {
    container.querySelectorAll('.queue-bubbles-stack').forEach(el => el.remove());
    setLastQueueBubbleSignature('');
    return;
  }

  // 线程暂存（Thread Inbox pending）与 viewer 排队同栈渲染：
  // 前者意图归属是「工作」（交接窗口/非 head 暂存，新会话就绪后投递），
  // 后者归属是「runtime」（call 间排队）。样式变体区分，语义不混。
  const threadPending = getThreadPendingTexts();
  const signature = JSON.stringify({ q: queuedTexts, t: threadPending });
  const existingStack = container.querySelector('.queue-bubbles-stack');
  if (signature === lastQueueBubbleSignature && (
    (queuedTexts.length === 0 && threadPending.length === 0 && !existingStack)
    || ((queuedTexts.length > 0 || threadPending.length > 0) && existingStack)
  )) {
    return;
  }
  setLastQueueBubbleSignature(signature);

  container.querySelectorAll('.queue-bubbles-stack').forEach(el => el.remove());
  if (queuedTexts.length === 0 && threadPending.length === 0) return;

  const stack = document.createElement('div');
  stack.className = 'queue-bubbles-stack';
  for (const txt of threadPending) {
    const b = document.createElement('div');
    b.className = 'queue-bubble thread-staged';
    b.textContent = txt.length > 80 ? txt.substring(0, 80) + '...' : txt;
    b.title = txt;
    stack.appendChild(b);
  }
  for (const txt of queuedTexts) {
    const b = document.createElement('div');
    b.className = 'queue-bubble';
    b.textContent = txt.length > 80 ? txt.substring(0, 80) + '...' : txt;
    b.title = txt;
    stack.appendChild(b);
  }

  const card = container.querySelector('.user-input-card');
  if (card) container.insertBefore(stack, card);
  else container.appendChild(stack);
}

export function updateQueueIndicator() {
  // 渲染入口守卫：投影先与当前查看的 runtime 对齐（幂等重绑），旧会话
  // 残留的排队文本不得渲染进新会话的输入面。
  // 桥接期：rebindQueueProjectionForRuntime 定义于 persistent-input（classic
  // 首屏同步边界，输入面批次收敛时改 import）。原实现就是无守卫直调，
  // 缺失时应有响亮失败，不静默跳过。
  window.rebindQueueProjectionForRuntime(currentRuntimeAgentId);
  const container = document.getElementById('user-input-container');
  if (container) _renderQueueBubbles(container);
}

/**
 * 队列快照的同步消费（轮询路径与 SSE 事件路径共用）：更新排队文本 / 待发送
 * 计数 / 队列气泡 / 输入面声明。texts 已由调用方完成乐观对账（SSE 路径经
 * SseClient.reconcileQueuedTexts）。
 */
export function applyQueuedInputsTexts(runtimeId, texts, snapshotCount) {
  // 写入口归属守卫：投影只承载当前查看的 runtime；轮询 / SSE 异步竞态下
  // 过期快照的写入直接丢弃，不污染新会话的排队气泡。
  if (String(runtimeId || '').trim() !== String(currentRuntimeAgentId || '').trim()) return;
  setQueuedProjectionRuntimeId(String(runtimeId || '').trim() || null);
  setQueuedTexts(Array.isArray(texts) ? texts.slice() : []);
  setPendingQueuedCount(Number.isFinite(snapshotCount) ? snapshotCount : queuedTexts.length);
  // 桥接期：isRuntimeCalling 定义于 runtime-status（classic，W2-2 后续批次
  // 转 ESM 后改 import）；原实现为无守卫直调。
  if (queuedTexts.length === 0 && !window.isRuntimeCalling(runtimeId)) {
    setLocalQueuedInputPending(false);
  }
  updateQueueIndicator();
  // 桥接期：notifyInputSurfaceChanged 定义于 input-render（classic，输入面
  // 批次收敛时改 import）；原实现为无守卫直调。
  window.notifyInputSurfaceChanged(currentInputRequests || []);
}

export async function _syncPersistentInputUi(runtimeId = currentRuntimeAgentId) {
  if (persistentUiSyncInFlight) return;
  persistentUiSyncInFlight = true;
  // Always update model switcher regardless of queue/runtime state
  updateInputModelSwitcher();
  updateThinkingEffortSwitcher();
  // 桥接期：captureSessionViewToken 定义于 session-view-state（classic 同步
  // 快照捕获，会话视图域收敛时改 import）；isSessionViewTokenCurrent 已是
  // ESM（session-view-commit 策略），本模块直接 import。
  const viewToken = window.captureSessionViewToken(runtimeId);
  const snapshotBeforeFetch = getLastQueuedSnapshot(runtimeId);
  try {
    if (!runtimeId) {
      setQueuedTexts([]);
      setPendingQueuedCount(0);
      setQueuedProjectionRuntimeId(null);
      updateQueueIndicator();
      // 桥接期：_syncPersistentActionButton 定义于 persistent-input（classic）
      window._syncPersistentActionButton();
      return;
    }

    const expectedRuntimeId = runtimeId;
    // 桥接期：_syncPersistentActionButton 定义于 persistent-input（classic）
    window._syncPersistentActionButton();

    // SSE 激活时优先消费事件通道缓存的最新快照（零请求）；缓存缺席
    // （首载/事件未达）时回退 fetch 一次补齐，等事件接管
    if (isSseActive()) {
      const cached = getLastQueuedSnapshot(expectedRuntimeId);
      if (cached && Array.isArray(cached.items)) {
        const texts = reconcileQueuedTexts(cached.items, Date.now(), expectedRuntimeId) || [];
        // 待发送气泡/计数只认用户输入且未被领取：reminder（机器通报）同队
        // 存放但不展示，已 claim（inputLease）的项正在执行、不算排队
        applyQueuedInputsTexts(expectedRuntimeId, texts,
          cached.items.filter((item) => item?.kind !== 'reminder' && !item?.inputLease).length);
        return;
      }
    }

    const res = await fetch(`/api/agents/${expectedRuntimeId}/queued-inputs`);
    if (!res.ok || expectedRuntimeId !== currentRuntimeAgentId) return;
    const data = await res.json();
    if (!isSessionViewTokenCurrent(viewToken)) return;
    // 请求期间 SSE 已带来更新的观察，HTTP 快照不再拥有队列写入权。
    if (getLastQueuedSnapshot(expectedRuntimeId) !== snapshotBeforeFetch) return;
    const queue = Array.isArray(data) ? data : (Array.isArray(data.inputs) ? data.inputs : []);
    // 同上：reminder（机器通报）不进待发送气泡与待发送计数；已 claim
    // （inputLease）的项正在执行、不算排队（与 SSE 路径同一投影语义）
    const userQueue = queue.filter((item) => item?.kind !== 'reminder' && !item?.inputLease);
    const viewerQueueTexts = userQueue
      .map((item) => {
        const t = typeof item?.text === 'string' ? item.text.trim() : '';
        if (t) return t;
        const imgCount = Array.isArray(item?.images) ? item.images.length : 0;
        return imgCount > 0 ? '🖼' : '';
      })
      .filter(Boolean);

    // 即使文本相同也消费权威计数与排空事实；DOM 去重由渲染器负责。
    reconcileQueuedTexts(queue, Date.now(), expectedRuntimeId);
    applyQueuedInputsTexts(expectedRuntimeId, viewerQueueTexts, userQueue.length);
  } catch (e) {
    // ignore transient queue sync failures
  } finally {
    persistentUiSyncInFlight = false;
  }
}

// 查询后端真实队列余量，移除已被消费的气泡
export async function _syncQueueFromBackend() {
  await _syncPersistentInputUi();
}

window.KernelState.defineKey('input-queue', '_renderQueueBubbles', _renderQueueBubbles);
window.KernelState.defineKey('input-queue', 'updateQueueIndicator', updateQueueIndicator);
window.KernelState.defineKey('input-queue', '_syncQueueFromBackend', _syncQueueFromBackend);
window.KernelState.defineKey('input-queue', '_syncPersistentInputUi', _syncPersistentInputUi);
