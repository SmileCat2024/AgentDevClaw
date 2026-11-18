/**
 * thread-store.js — 工作线程前端承接层
 *
 * 职责：让「AI 对话」具备感知与承接工作线程的能力，而不改变其他
 * 工作空间的默认行为；线程宿主 APP（coder）的侧栏保持为稳定的
 * 线程入口：
 *   - 周期拉取 /protoclaw/threads，维护 threadId / sessionId 双向索引；
 *   - 会话列表项渲染线程徽标（无数据时输出空串，零视觉影响）；
 *   - 顶栏指示器：当前会话属于线程时显示承接状态；非 head 会话
 *     提供显式「前往当前承接会话」入口（浏览历史时不自动跳转）；
 *   - 线程寻址输入（submitThreadInput → 线程输入网关）由交互域提供：输入走
 *     哪条端点在服务端判定，前端只回答「我在哪个对话里发言」，不接受性、
 *     不挑端点。
 *
 * 当前消费方：声明 threadHost 的 APP（coder、memo，宿主判定由服务端发现
 * 派生）。其他工作空间无线程数据，本模块所有入口均为 no-op / 空输出。
 *
 * ESM 拆分（P2 · thread-store 交互域批次）：交互入口与暂存文本查询已迁
 * `thread-store-domain.js`（openConversationTarget / enterThreadAwaitView /
 * registerSessionActivateTarget / submitThreadInput / getThreadPendingTexts）。
 * 拆分时随迁的 `getActiveConversationTarget` / `threadAdvanceHead` 在收尾复审中
 * 确认生产零消费，已连同实现删除（不再有 window 面，也没有私有死代码）。
 *
 * ESM 迁移状态（P4 T3 批次）：**已转 ESM**，原 classic 标签删除。本文件即
 * 刷新引擎本体（状态 + 索引 + 周期拉取 + 接续重绑 + 顶栏指示器）。
 *
 * 时序审计（R1–R4 + S）：
 *   - R1：仍 classic 的文件里**没有本域键的顶层调用点**（app-main / app-ui /
 *     sidebar-render / session-view-state / runtime-status / persistent-input /
 *     input-composer 的引用全在函数体与事件回调内，含 app-main 的两个顶层 IIFE
 *     逐条 grep 过）。
 *   - R2：boot 主链（`__clawAuthReady` → `startApplication`）在 DOMContentLoaded
 *     之后才触达线程数据；本模块的桥键在 kernel-entry 的模块相注册完成，早于
 *     首屏 `boot.js` 与 DOMContentLoaded，无抢跑窗口。
 *   - R3：本文件无 DOM 引用类状态键——顶栏指示器元素按 `getElementById` 现取，
 *     从不缓存引用，模块求值期不查询 DOM。
 *   - R4（三条同步调度逐条）：2s 启动刷新、20s 周期刷新、`visibilitychange`
 *     监听从解析相移到 deferred 模块相，仍在 DOMContentLoaded 之前注册；计时
 *     起点从「标签解析」变为「模块求值」，差值是剩余 HTML 的解析时间（毫秒级）。
 *     三条调度的语义都是「就绪后周期对账」而非相对解析时刻的定时，且首拉与
 *     周期拉取都对 `refreshInFlight` 与 5s 节流做合并，重复 / 迟触发不影响
 *     结果。判定等价。**唯一需要装载序保证的点**见文件末尾「装载顺序约束」：
 *     `createThreadStoreHost()` 被 thread-store-domain 在装载期取用，本文件必须
 *     早于它求值。
 *   - S：原文件是 sloppy（无 `'use strict'`）。审计出的 sloppy 依赖只有 5 处对
 *     「window 桥访问器」的隐式写/裸读（focusedAgentId / currentRuntimeAgentId /
 *     readOnlyMode / _lastRenderedChatSig / lastRenderedWorkspaceHtml，生产里由
 *     app-core 注册的访问器承接）——转换后改为具名 import 的 setter 与活绑定，
 *     语义不变；无 with、无顶层 this、无隐式全局创建。
 *
 * 交互域经 `createThreadStoreHost()` 取用状态与内部操作：唯一实时引用、
 * 无副本、无 ready 队列。本文件的引擎与各入口闭包不调用交互域任何函数。
 *
 * 显式依赖形态：
 *   - 已迁 ESM → 具名 import：`currentRuntimeAgentId`（编排 owner）、`allAgents`
 *     （agent-store owner）、`setFocusedAgentId` / `setReadOnlyMode`、
 *     `setLastRenderedChatSig` / `setLastRenderedWorkspaceHtml`（渲染 entry owner）。
 *     只 import 这三个无下游的 owner 模块：**不得**改 import
 *     `workspace-actions` / `runtime-switch-host` 等上游编排模块——它们的静态图
 *     含 thread-store-domain，而后者在装载期就调用 `window.createThreadStoreHost()`，
 *     会与「本模块体先于其 import 求值」冲突（自指装载死锁）。
 *   - 仍 classic → 显式 `window.*`（行尾标注定义域）：`getCurrentHostAgentRecord`
 *     （app-main）、`renderAgentList`（sidebar-render）、`renderCurrentMainView`
 *     （app-ui）、`readCurrentSessionViewState` / `applySessionViewPatch`
 *     （session-view-state）、`getRuntimeWorkspaceSessionId` /
 *     `setViewerSessionBinding` / `getRuntimeContextKey`（app-core）、
 *     `_storeVisibleSessionInputDraft`（input-composer）、
 *     `resetRuntimeStatusForSwitch`（runtime-status）。
 *   - 已上桥的 ESM 能力 → `window.*` 晚绑定：`switchAgent`（runtime-switch）、
 *     `runWorkspaceAction`（workspace-actions）、`loadAgents`（agent-snapshot-loader）、
 *     `loadAgentData`（session-data-loader）、`updateQueueIndicator`（input-queue）、
 *     `refreshSidebarRuntimeAfterMutation`（external-runtime）、
 *     `setPendingChatScrollRestore` / `setPendingChatViewportAnchor`（chat-viewport）、
 *     `currentLanguage`（i18n-environment）、`ClawFW` / `ClawToast` / `SessionReference`。
 */

import { currentRuntimeAgentId, setCurrentRuntimeAgentId } from './orchestration-state.js';
import { allAgents, setFocusedAgentId, setReadOnlyMode } from './agent-store-state.js';
import { setLastRenderedChatSig, setLastRenderedWorkspaceHtml } from './render-entry-state.js';
import { getRuntimeContextKey, getRuntimeWorkspaceSessionId, setViewerSessionBinding } from './identity.js';

// 线程事实的唯一真相源（本域状态）。`let` 而非 `const`：桥键 setter 允许 classic
// 写方整对象替换（D4 原样转发），替换后所有闭包读同一活绑定。
export let ClawThreads = {
  threads: [],
  byId: {},
  sessionIndex: {}, // `${agentId}::${sessionId}` → thread summary
  lastRefreshAt: 0,
  initialLoadDone: false,
  refreshInFlight: null,
  lastThreadsSig: '',
  // 服务端列表聚合的内容哈希（条件刷新凭证）：带上它请求，内容未变时
  // 服务端返回 unchanged 短路，跳过全量传输与重建（先例：会话列表 sinceRevision）。
  lastContentHash: '',
  // 当前激活会话是否为「历史成员只读挂载」事实（activate 响应 browseOnly）。
  // 由 workspace-actions 在 activate 落地时写入；只读横幅/输入守卫消费，
  // 与成员关系（sessionIndex / headSessionId）一致：历史成员必然 browseOnly。
  browseOnly: false,
  browseOnlyThreadId: '',
  activeConversation: null,
};

const THREADS_REFRESH_INTERVAL_MS = 20000;

// ── 交互域窄宿主（thread-store-domain.js 的唯一入口）───────────────
//
// 只暴露交互域真正需要的东西：状态唯一实时引用 + 三个引擎内部操作。不做
// 状态镜像、不做 ready 队列、不在交互域里重写任何实现——`getState()` 每次
// 现读本域活绑定（整对象被替换也生效），内部操作就是下面这几份函数本身。
// 交互域在模块相取用，因此本模块必须早于它求值（见文件末尾「装载顺序约束」）。
export function createThreadStoreHost() {
  return Object.freeze({
    getState: () => ClawThreads,
    getCurrentActiveSession: _currentActiveSession,
    isHandoffActive: _handoffActive,
    syncActiveThreadSubscription: _syncActiveThreadSubscription,
  });
}

// ── 内部工具 ──────────────────────────────────────────────────────

function _isZh() {
  // currentLanguage 是 i18n-environment 的桥键（app-core 注册访问器、ESM owner 认领）。
  return window.currentLanguage === 'zh';
}

function _rebuildIndexes() {
  const state = ClawThreads;
  state.byId = {};
  state.sessionIndex = {};
  for (const thread of state.threads) {
    if (!thread?.threadId) continue;
    state.byId[thread.threadId] = thread;
    for (const sessionId of thread.sessionIds || []) {
      const key = `${thread.agentId}::${sessionId}`;
      // 一个会话原则上只属于一条线性线程；若出现脏数据保留首条
      if (!state.sessionIndex[key]) state.sessionIndex[key] = thread;
    }
  }
}

// ── 状态拉取 ──────────────────────────────────────────────────────

export async function refreshThreads(force = false) {
  const state = ClawThreads;
  if (state.refreshInFlight) {
    if (!force) return state.refreshInFlight;
    // SSE handoff-started / 发送消息 / 归档等事件触发的强制刷新不得被慢的
    // 周期请求短路：in-flight 拿到的还是旧数据（请求早于事实变化发出），等
    // 它结束后必须再拉一次，否则新事实延迟到下个 20s 轮询周期。
    //
    // 尾部合并：此前每个并发 force 调用都会各自 await 在途请求、再各自发起
    // 一次全量拉取——一次发送 + 一次归档就可能排队 3~4 次重复聚合。这里把
    // 「在途结束之后再拉」收敛为一个共享的补拉 promise，所有并发 force 共享
    // 同一次结果；补拉进行中到达的 force 直接复用它（见下方 trailing 判断）。
    if (state.refreshTrailing) return state.refreshTrailing;
    state.refreshTrailing = (async () => {
      await state.refreshInFlight.catch(() => {});
      state.refreshTrailing = null;
      // 下一个 refreshThreads 会重新走一次真实拉取（此时 refreshInFlight 已清空）
      return refreshThreads(true);
    })();
    return state.refreshTrailing;
  }
  if (!force && state.initialLoadDone && Date.now() - state.lastRefreshAt < 5000) {
    return;
  }
  state.refreshInFlight = (async () => {
    try {
      const query = state.lastContentHash
        ? `?sinceContentHash=${encodeURIComponent(state.lastContentHash)}`
        : '';
      const res = await fetch(`/protoclaw/threads${query}`);
      if (!res.ok) return;
      const data = await res.json();
      // 内容未变（unchanged 短路）或旧服务端忽略参数外的异常形态：线程事实
      // 保持缓存现状，但视图对账不随之跳过——unchanged 只证明线程事实与缓存
      // 一致，不证明视图已对齐缓存事实。重绑一次性错过 successor runtime 快
      // 照（SSE 事件已消费、threads 内容此后不再变化）后，这里是对账的唯一
      // 持续触发点；跳过它会让视图永久冻结在旧 head（历史事故：绿色「只读·
      // 前往当前会话」常驻，用户必须手点才切到新 head）。对账仅消费本地缓存
      // （activeConversation + byId），无网络开销。
      if (data?.unchanged) {
        _reconcileConversationWithThreadHead();
        return;
      }
      if (Array.isArray(data?.threads)) {
        state.threads = data.threads;
        if (typeof data.contentHash === 'string' && data.contentHash) {
          state.lastContentHash = data.contentHash;
        }
        _rebuildIndexes();
        _syncActiveThreadSubscription();
        // 新线程事实落地后对账：视图冻结在旧 head 而线程 head 已推进（SSE
        // 事件丢失 / 与 404 清理竞态）时原地重绑。unchanged 短路不经过这里。
        _reconcileConversationWithThreadHead();
        // This is the thread fact commit boundary for polling and SSE alike.
        // Consumers render only after indexes and the conversation target agree.
        const sig = JSON.stringify(data.threads);
        if (sig !== state.lastThreadsSig) {
          state.lastThreadsSig = sig;
          setLastRenderedWorkspaceHtml('');
          // classic 渲染函数经 window 晚绑定（sidebar-render / app-ui）
          if (typeof window.renderAgentList === 'function') window.renderAgentList();
          if (typeof window.renderCurrentMainView === 'function') window.renderCurrentMainView();
        }
      }
    } catch {
      // 服务端不可达 / 路由未注册：静默保持现状
    } finally {
      state.lastRefreshAt = Date.now();
      state.initialLoadDone = true;
      state.refreshInFlight = null;
      updateThreadHeaderIndicator();
      // 线程数据更新可能影响暂存气泡（pending 指令增减）；聊天渲染有签名
      // 去重，这里直接同步，不依赖下一轮 poll。
      if (typeof window.updateQueueIndicator === 'function') window.updateQueueIndicator();
    }
  })();
  return state.refreshInFlight;
}

// ── 查询 ──────────────────────────────────────────────────────────

export function getThreadById(threadId) {
  return ClawThreads.byId[threadId] || null;
}

export function getThreadForSession(agentId, sessionId) {
  if (!agentId || !sessionId) return null;
  return ClawThreads.sessionIndex[`${agentId}::${sessionId}`] || null;
}

/**
 * 输入目标一致性校验（会话绝对隔离）：全局线程指向（activeConversation）
 * 只在与当前视图一致时才可作为输入目标。不一致（用户已切到别的会话 /
 * 别的工作空间，全局残留未清）返回 null——消息走当前视图的常规路径，
 * 绝不允许"在 A 会话输入、发到 B 线程"的串线。
 * 一致 = 宿主一致（getCurrentHostAgentRecord）+ 视图挂载在该会话
 * （SessionView identity：等待表面经 enterThreadAwaitSurface 落 identity、
 * 正常会话经数据加载落 identity、回工作空间首页时 sessionId 清空——宿主
 * 一致但视图已不在该会话的残留同样拒绝，否则首页上旧会话条目常亮、宿主
 * 节点让位）+ 当前激活会话与指向会话相同；等待重绑态（runtime 态被 404
 * 清空，_currentActiveSession 回退为 activeConversation 自身）天然满足。
 */
export function getActiveThreadInputTarget() {
  const selected = ClawThreads.activeConversation;
  if (!selected?.threadId) return null;
  const hostRecord = typeof window.getCurrentHostAgentRecord === 'function'
    ? window.getCurrentHostAgentRecord()
    : null;
  if (!hostRecord || String(hostRecord.id || '') !== String(selected.agentId || '')) {
    return null;
  }
  const viewIdentity = typeof window.readCurrentSessionViewState === 'function'
    ? (window.readCurrentSessionViewState()?.identity || null)
    : null;
  if (!viewIdentity
    || String(viewIdentity.agentId || '').trim() !== String(selected.agentId || '').trim()
    || String(viewIdentity.sessionId || '').trim() !== String(selected.sessionId || '').trim()) {
    return null;
  }
  const active = _currentActiveSession();
  if (active && active.agentId === String(selected.agentId || '')
    && active.sessionId === String(selected.sessionId || '')) {
    return selected;
  }
  return null;
}

/**
 * 当前激活会话：以用户当前查看的 runtime/session 绑定为准。
 * 宿主的 active_workspace_session_id 会被 IM、CLI、coder 接力等其他入口
 * 改写，不能作为当前浏览器输入目标；共享 runtime 下尤其如此。
 */
export function _currentActiveSession() {
  try {
    const host = typeof window.getCurrentHostAgentRecord === 'function'
      ? window.getCurrentHostAgentRecord()
      : null;
    const runtimeId = String(currentRuntimeAgentId || '').trim();
    const sessionId = runtimeId ? String(getRuntimeWorkspaceSessionId(runtimeId) || '').trim() : '';
    if (host?.id && sessionId) {
      return { agentId: host.id, sessionId };
    }
    // 接续退役窗口（且仅此窗口）：runtime 态被 /responses 404 清空，但视图
    // 身份（activeConversation）仍指向线程会话——这不是用户离开，是「等待
    // 重绑」，线程指向保留。有 runtime 态时绝不回退：绑定缺席 + 条目字段
    // 缺失不是「等待重绑」，回退残留 activeConversation 会把输入串到与当前
    // 视图无关的会话（历史事故：main 会话输入串到残留 coder 会话并经
    // ensureHeadRuntime 唤醒其 head runtime）。
    if (!runtimeId) {
      const selected = ClawThreads.activeConversation;
      if (selected?.threadId && selected?.sessionId
        && String(selected.agentId || '').trim() === String(host.id || '').trim()) {
        return { agentId: host.id, sessionId: String(selected.sessionId || '').trim() };
      }
    }
    // 宿主 active 回退已删除：宿主 active_workspace_session_id 会被 IM、CLI、
    // coder 接力等入口改写（跨会话共享可变状态），作为输入目标是串扰源——
    // 解析失败宁可为 null（输入降级 direct），不得猜测。
  } catch {
    // 输入路由在 app-main 身份尚未完成初始化时退化为 direct。
  }
  return null;
}

// ── 会话列表徽标（渲染点由 session-list-render.js 调用）──────────

// 会话列表位的线程徽标（第 N 棒 / 承接中 / 已接续 / 接力中）已按产品要求
// 全部移除：接续过程提示仅保留顶栏交接窗口的「上下文接力中…」一个。
// session-list-render 的调用点经 typeof 守卫，函数缺席时零渲染。

/**
 * 线程宿主判定（APP 级，ADR-0025）：给定会话属于某条线程（即线程宿主
 * APP 的会话）时为真。线程索引未就绪（首拉前）时保守返回 false。
 */
export function isThreadHostAgentId(agentId, sessionId) {
  const id = String(agentId || '').trim();
  if (!id || !sessionId) return false;
  return !!(ClawThreads?.sessionIndex
    && ClawThreads.sessionIndex[`${id}::${sessionId}`]);
}

/**
 * 交接挡板是否立起（与服务端 isHandoffBarrierActive 同一派生规则）。
 *
 * 判定只读线程记录的 status，不设本地时间窗：挡板的立起与收敛完全由
 * 服务端持久化事务决定（beginSessionHandoff 置 rotating，commit / fail /
 * 陈旧兜底收敛）。前端再叠一层「超过 N 分钟即视为无交接」的本地规则，
 * 会与服务端产生两个真相——服务端仍按 rotating 拒绝挂载（409），前端
 * 却已当窗口结束去发起 open_session，两侧各说各话，触发无界重试。
 */
export function _handoffActive(thread) {
  return String(thread?.status || '') === 'rotating';
}

// ── 顶栏指示器 ────────────────────────────────────────────────────

export function updateThreadHeaderIndicator() {
  const anchor = document.getElementById('chat-context-bar');
  if (!anchor || !anchor.parentElement) return;

  let el = document.getElementById('thread-header-indicator');
  const active = _currentActiveSession();
  const thread = active ? getThreadForSession(active.agentId, active.sessionId) : null;

  if (!thread) {
    if (el) el.remove();
    return;
  }

  const isZh = _isZh();
  const isHead = active && active.sessionId === thread.headSessionId;

  // 接续对用户不可感知：正常工作态（非交接窗口）不显示任何线程指示器；
  // 顶栏只保留交接窗口内的「上下文接力中…」一个提示。
  if (isHead && !_handoffActive(thread)) {
    if (el) el.remove();
    return;
  }

  if (!el) {
    el = document.createElement('span');
    el.id = 'thread-header-indicator';
    anchor.parentElement.insertBefore(el, anchor);
  }

  if (isHead) {
    el.className = 'thread-header-indicator relaying';
    el.onclick = null;
    el.title = `${thread.threadId} · ${isZh ? '正在交接到后续会话，期间输入将暂存到线程' : 'handing off; input will be staged in the thread'}`;
    el.textContent = isZh ? '上下文接力中…' : 'Relaying context…';
  } else {
    // 历史成员：只读查看（T006 / ADR-001）。成员关系（sessionIndex）是事实源，
    // 不依赖 browseOnly 时序：非 head 即只读。明示「只读 + 前往当前 head」，
    // 点击是显式动作——绝不静默跳转 / 静默转投（work-thread-design §2.2）。
    const browseOnly = ClawThreads.browseOnly === true
      && (ClawThreads.browseOnlyThreadId === '' || ClawThreads.browseOnlyThreadId === thread.threadId);
    el.className = 'thread-header-indicator historical' + (browseOnly ? ' readonly' : '');
    el.title = isZh
      ? `当前为只读查看；点击前往当前承接会话`
      : `Read-only view; click to open the current head session.`;
    el.textContent = isZh ? '只读 · 前往当前会话' : 'Read-only · open head';
    el.onclick = () => {
      jumpToThreadHead(thread.threadId);
    };
  }
};

// ── 接力分隔条（聊天区顶部：非 root 棒显示来源与方式）──────────────

/**
 * 查询会话的接力边信息（它从哪个会话、以何种方式接续而来）。
 * 返回 { threadId, fromSessionId, relayKind } 或 null。
 */
// ── 线程动作 ──────────────────────────────────────────────────────

async function jumpToThreadHead(threadId) {
  const thread = getThreadById(threadId);
  if (!thread || !thread.headSessionId) return { ok: false, reason: 'thread_not_found' };

  const active = _currentActiveSession();
  if (active && active.agentId === thread.agentId && active.sessionId === thread.headSessionId) {
    return { ok: true, already: true };
  }

  // 线程会话属于 thread.agentId 的工作空间；跨空间先切换宿主
  if (active && active.agentId && active.agentId !== thread.agentId && typeof window.switchAgent === 'function') {
    await window.switchAgent(thread.agentId);
  }

  if (typeof window.runWorkspaceAction === 'function') {
    await window.runWorkspaceAction(JSON.stringify({ type: 'open_session', sessionId: thread.headSessionId }));
  }
  updateThreadHeaderIndicator();
  return { ok: true };
}

// ── 接续换头：保持同一会话视图身份，只更换 runtime 绑定与消息数据源 ──

let _activeThreadSubscription = null;

export function _syncActiveThreadSubscription() {
  // 只读浏览（归档对话 / 历史存档）不参与线程跟随：视图冻结在目标 Session
  // 上，既不是 head 也不等待重绑，线程指向不得被对齐或重建。
  if (ClawThreads.activeConversation?.readOnly === true) return;
  const active = _currentActiveSession();
  const thread = active ? getThreadForSession(active.agentId, active.sessionId) : null;
  const selected = ClawThreads.activeConversation;
  if (selected?.threadId) {
    const selectedThread = getThreadById(selected.threadId);
    const currentSessionBelongsToThread = selectedThread?.agentId === active?.agentId
      && (selectedThread.sessionIds || []).includes(active?.sessionId);
    // 接续退役窗口：runtime 态被 /responses 404 清理清空，_currentActiveSession
    // 落到宿主 main 会话——这不是用户离开，是「视图身份仍在、等待重绑」态。
    // 保留线程指向与订阅，否则 handoff-started 指示器延迟、head-advanced
    // 重绑失效。豁免以宿主焦点为界：用户已切到别的工作空间（宿主不再是
    // 本线程宿主）时豁免失效，落入下方重建分支清除残留——全局线程指向
    // 不跨工作空间存续（会话隔离；历史事故：main 会话输入经残留指向串到
    // coder 线程）。
    const runtimeStateCleared = String(currentRuntimeAgentId || '').trim() === '';
    const hostRecord = typeof window.getCurrentHostAgentRecord === 'function'
      ? window.getCurrentHostAgentRecord()
      : null;
    const hostOwnsThread = !!hostRecord
      && String(hostRecord.id || '') === String(selected.agentId || '');
    if (selectedThread?.agentId === selected.agentId && hostOwnsThread
      && (!selected.runtimeId || runtimeStateCleared)) {
      // A user navigation has selected this stable thread target but the
      // session runtime has not mounted yet. Do not replace it with whatever
      // conversation was visible before the navigation began. Same for the
      // succession gap after the 404 cleanup cleared the runtime binding.
    } else if (selectedThread?.agentId === selected.agentId && currentSessionBelongsToThread) {
      selected.sessionId = selectedThread.headSessionId || selected.sessionId;
      selected.runtimeId = String(currentRuntimeAgentId || selected.runtimeId || '');
      // wasHead 是「冻结时是否 head」的事实，记账对齐不改变它——历史成员
      // 被对齐 head 后仍不得获得接续重绑资格（对账入口以 wasHead 为锚）。
    } else {
      ClawThreads.activeConversation = thread ? {
        agentId: active.agentId,
        threadId: thread.threadId,
        sessionId: active.sessionId,
        runtimeId: String(currentRuntimeAgentId || ''),
        wasHead: active.sessionId === thread.headSessionId,
      } : (active ? {
        agentId: active.agentId,
        threadId: '',
        sessionId: active.sessionId,
        runtimeId: String(currentRuntimeAgentId || ''),
        wasHead: false,
      } : null);
    }
  } else {
    ClawThreads.activeConversation = thread ? {
      agentId: active.agentId,
      threadId: thread.threadId,
      sessionId: active.sessionId,
      runtimeId: String(currentRuntimeAgentId || ''),
      wasHead: active.sessionId === thread.headSessionId,
    } : (active ? {
      agentId: active.agentId,
      threadId: '',
      sessionId: active.sessionId,
      runtimeId: String(currentRuntimeAgentId || ''),
      wasHead: false,
    } : null);
  }
  // Sidebar discovery includes new and background threads. A wildcard keeps
  // the request bounded regardless of history size and needs no reconnect on edits.
  if (_activeThreadSubscription) return;
  const client = window.ClawFW?.SseClient;
  if (typeof client?.subscribeThreadEvents !== 'function') return;
  const subscription = { unsubscribe: null };
  subscription.unsubscribe = client.subscribeThreadEvents('*', async (event) => {
    if (['thread.created', 'thread.handoff-started', 'thread.head-advanced', 'thread.archived', 'thread.deleted'].includes(event?.type)
      && typeof window.refreshSidebarRuntimeAfterMutation === 'function') {
      await window.refreshSidebarRuntimeAfterMutation().catch(error => console.warn('Sidebar refresh failed:', error));
    }
    if (['thread.created', 'thread.handoff-started', 'thread.archived', 'thread.deleted'].includes(event?.type)) {
      // Events discover changes; the shared refresh commits authoritative facts
      // for background sidebar entries as well as the selected conversation.
      await refreshThreads(true).catch(() => {});
      window.renderAgentList();
      return;
    }
    if (event?.type !== 'thread.head-advanced') return;
    const fromSessionId = String(event.payload?.fromSessionId || '').trim();
    const toSessionId = String(event.payload?.toSessionId || '').trim();
    if (!fromSessionId || !toSessionId) return;
    // 事件只是加速信号：重绑的成立条件一律以调用时点的 threads / allAgents
    // 权威事实为准（_rebindConversationToThreadHead 内部守卫），与轮询事实
    // 对账共用同一实现，不存在第二条重绑路径。
    await refreshThreads(true).catch(() => {});
    window.renderAgentList();
    await _rebindConversationToThreadHead(event.threadId, fromSessionId, toSessionId);
  });
  _activeThreadSubscription = subscription;
}

/**
 * 接续重绑（唯一实现）：把视图身份从 fromSessionId 原地换到 toSessionId 的
 * head runtime。调用方（SSE head-advanced 处理器 / threads 事实对账）各自
 * 先刷新线程事实再进入；守卫全部建立在权威数据上——线程匹配、head 对账、
 * runtime 对账、宿主一致，任一失配静默退出（幂等，重复调用安全）。
 */
let _rebindInFlight = false;

// 重绑瞬态失败的有界重试：successor runtime 尚未进入 allAgents 快照
// （loadAgents in-flight 合并到旧请求 / viewer 注册竞态）时，`if (!runtime)`
// 是唯一瞬态退出点——其余守卫失败都是事实失配（用户已离开等），不重试。
// 不重试的话该窗口是重绑的最后一次性机会（SSE head-advanced 已消费、
// threads 内容此后不再变化），冻结只能等周期轮询的 unchanged 对账兜底
// （最长 20s）或用户手点；秒级重试把恢复压回接续「无缝」量级。
const REBIND_RETRY_INTERVAL_MS = 2000;
const REBIND_RETRY_MAX_ATTEMPTS = 5;
let _rebindRetryTimer = null;

function _scheduleRebindRetry(threadId, fromSessionId, toSessionId, attempt) {
  if (attempt >= REBIND_RETRY_MAX_ATTEMPTS) return;
  if (_rebindRetryTimer) return;
  _rebindRetryTimer = setTimeout(() => {
    _rebindRetryTimer = null;
    void _rebindConversationToThreadHead(threadId, fromSessionId, toSessionId, attempt + 1)
      .catch((error) => console.warn('[threads] rebind retry failed:', error));
  }, REBIND_RETRY_INTERVAL_MS);
}

function _cancelRebindRetry() {
  if (_rebindRetryTimer) {
    clearTimeout(_rebindRetryTimer);
    _rebindRetryTimer = null;
  }
}

export async function _rebindConversationToThreadHead(threadId, fromSessionId, toSessionId, attempt = 0) {
  if (_rebindInFlight) return;
  // 只读浏览（归档对话 / 历史存档）不参与接续重绑：视图是用户显式选定的
  // 历史会话，head 推进不得把它拉走（历史事故：点开存档后被接续自动跳到
  // 最新 head）。
  if (ClawThreads.activeConversation?.readOnly === true) return;
  _rebindInFlight = true;
  try {
    const current = _currentActiveSession();
    const selectedConversation = ClawThreads.activeConversation;
    const ownerAgentId = String(selectedConversation?.agentId || '').trim();
    // 重绑守卫：用户仍挂在本线程的视图（threadId 匹配）即可。不再要求
    // current.sessionId === fromSessionId——接续退役旧 head 时 /responses 404
    // 清理会清空 runtime 态，_currentActiveSession 落到宿主 main 会话，原
    // 前置在被打断后必不满足（历史事故：重绑静默跳过，successor 需手动
    // 点击）。runtime 态仍在时仍要求指向 from 会话，防止迟到事件把已切到
    // 同线程历史分支的用户拉走。
    const runtimeStateHeld = String(currentRuntimeAgentId || '').trim() !== '';
    const userStillOnThread = selectedConversation?.threadId === threadId
      && (!ownerAgentId || current?.agentId === ownerAgentId)
      && (!runtimeStateHeld || current?.sessionId === fromSessionId);
    const nextThread = getThreadById(threadId);
    if (!userStillOnThread || nextThread?.headSessionId !== toSessionId) {
      return;
    }
    if (typeof window.loadAgents === 'function') await window.loadAgents().catch(() => {});
    const latest = _currentActiveSession();
    const latestConversation = ClawThreads.activeConversation;
    if (latestConversation?.threadId !== threadId
      || latestConversation.agentId !== ownerAgentId
      || latest?.agentId !== ownerAgentId) return;
    const runtime = (Array.isArray(allAgents) ? allAgents : []).find((agent) => (
      agent?.source === 'child'
      && agent?.parent_id === ownerAgentId
      && String(agent?.active_workspace_session_id || '') === toSessionId
    ));
    if (!runtime) {
      _scheduleRebindRetry(threadId, fromSessionId, toSessionId, attempt);
      return;
    }
    const previousRuntimeId = String(currentRuntimeAgentId || '').trim();
    if (previousRuntimeId && typeof getRuntimeWorkspaceSessionId === 'function'
      && getRuntimeWorkspaceSessionId(previousRuntimeId) !== fromSessionId) return;
    window._storeVisibleSessionInputDraft();
    const previousRuntimeIdForDraft = String(currentRuntimeAgentId || selectedConversation?.runtimeId || '').trim();
    const previousAttachmentKey = window.SessionReference?.activeKey?.() || '';
    const nextRuntimeId = String(runtime.runtime_session_id || runtime.runtimeSessionId || runtime.id || '').trim();
    if (!nextRuntimeId) return;
    const successorSessionKey = `${nextRuntimeId}::${toSessionId}`;
    if (previousAttachmentKey) {
      window.migratePendingInputImages?.(previousAttachmentKey, successorSessionKey);
    }
    window.ClawToast?.dismiss?.(`thread-staged-input-${threadId}`);
    window.ClawToast?.dismiss?.(`thread-staged-gw-${previousRuntimeIdForDraft || selectedConversation?.runtimeId || ''}`);
    // saveCurrentRuntimeToCache 只是 runtime-view-cache-host 的 ESM 具名导出，从未上 window
    // 面——该分支在生产恒不执行（原样保留，删除属另案）。
    if (previousRuntimeId && typeof window.saveCurrentRuntimeToCache === 'function') {
      window.saveCurrentRuntimeToCache(previousRuntimeId, getRuntimeContextKey(previousRuntimeId));
    }
    setViewerSessionBinding(nextRuntimeId, toSessionId);
    window.applySessionViewPatch({ identity: { agentId: ownerAgentId, sessionId: toSessionId } });
    const openedConversation = ClawThreads.activeConversation;
    if (openedConversation?.threadId === threadId && openedConversation.agentId === ownerAgentId) {
      openedConversation.sessionId = toSessionId;
      openedConversation.runtimeId = nextRuntimeId;
    }
    ClawThreads.activeConversation = {
      agentId: ownerAgentId,
      threadId,
      sessionId: toSessionId,
      runtimeId: nextRuntimeId,
      wasHead: true,
    };
    // 线程会话归属线程宿主 APP（如 coder）：侧栏高亮同步切到该 APP。
    setFocusedAgentId(ownerAgentId);
    setCurrentRuntimeAgentId(nextRuntimeId);
    setReadOnlyMode(false);
    setLastRenderedChatSig('');
    window.setPendingChatScrollRestore(null);
    if (typeof window.setPendingChatViewportAnchor === 'function') window.setPendingChatViewportAnchor(null);
    window.resetRuntimeStatusForSwitch();
    window.renderAgentList();
    window.loadAgentData(nextRuntimeId).catch((error) => console.warn('[threads] successor view rebind failed:', error));
    refreshThreads(true).catch(() => {});
    _cancelRebindRetry();
    _syncActiveThreadSubscription();
  } finally {
    _rebindInFlight = false;
  }
}

/**
 * 事实对账（ADR-0024 接续零感知）：SSE head-advanced 只是加速信号，事件
 * 丢失（断连 / 后台标签）时 threads 轮询拉到 head 已推进的快照即是重绑的
 * 正当时刻。视图冻结在本线程旧 head（wasHead）且线程 head 已换代 → 经
 * _rebindConversationToThreadHead 唯一实现原地换绑。挂在 refreshThreads
 * 收尾：404 豁免块的强刷、20s 周期轮询（含 unchanged 短路——线程内容不再
 * 变化后它是冻结恢复的唯一周期触发点）、事件处理器的事实刷新都会经过这
 * 里，无需独立触发器。
 *
 * 差值锚点：runtime viewer 绑定是「视图正在显示的会话」真相（记账
 * sessionId 会被 _syncActiveThreadSubscription 的跟随分支对齐 head，不能
 * 作信号）；runtime 态被 404 清空的退役窗口用冻结值（此时无人改写它）。
 */
export function _reconcileConversationWithThreadHead() {
  const selected = ClawThreads.activeConversation;
  if (!selected?.threadId || selected.wasHead !== true) return;
  const thread = getThreadById(selected.threadId);
  if (!thread || thread.status === 'closed') return;
  const headSessionId = String(thread.headSessionId || '').trim();
  if (!headSessionId) return;
  const runtimeId = String(currentRuntimeAgentId || '').trim();
  const boundSessionId = runtimeId && typeof getRuntimeWorkspaceSessionId === 'function'
    ? String(getRuntimeWorkspaceSessionId(runtimeId) || '').trim()
    : '';
  const viewedSessionId = boundSessionId || String(selected.sessionId || '').trim();
  if (!viewedSessionId) return;
  // 挡板已收敛的等待表面：等待表面挂着、线程不再处于接续中、head 未推进、
  // 无 runtime——rotation 失败收敛后的形态（旧 head 已退役、successor 未
  // 起来、线程落 rotation_failed / open），没有任何可以等待的对象。终结
  // 等待态：已渲染的上一棒消息保留可读，提示接续失败。恢复路径：再点线程
  // 条目 → open_session → activate 拉起旧 head（挡板已收敛，无竞态）。
  //
  // 判定依据只用记录里的 status（服务端权威），不叠加本地时间窗：挡板该
  // 不该算结束由服务端事务决定（commit / fail / 陈旧兜底都会收敛 status）。
  // 前端若自设过期线，会在服务端仍拒绝挂载时当窗口已结束，制造两侧分歧。
  if (selected.awaitSurface === true
    && headSessionId === viewedSessionId
    && !runtimeId
    && !_handoffActive(thread)) {
    ClawThreads.activeConversation = null;
    updateThreadHeaderIndicator();
    window.ClawToast?.show?.({
      id: `thread-handoff-failed-${selected.threadId}`,
      status: 'error',
      title: window.currentLanguage === 'zh' ? '线程接续失败' : 'Thread handoff failed',
      description: window.currentLanguage === 'zh'
        ? '接续未完成，当前显示上一棒的对话记录；重新点击线程条目可恢复。'
        : 'Handoff did not complete. Showing the previous run; click the thread again to resume.',
    });
    return;
  }
  if (headSessionId === viewedSessionId) return;
  if (!(thread.sessionIds || []).includes(viewedSessionId)) return;
  void _rebindConversationToThreadHead(selected.threadId, viewedSessionId, headSessionId)
    .catch((error) => console.warn('[threads] head reconciliation rebind failed:', error));
}

// ── 启动（周期刷新；非线程宿主的服务端列表恒空，开销可忽略）──────
//
// 三条同步调度在模块求值相注册（时相审计见头注 R4）：仍在 DOMContentLoaded
// 之前，语义是「就绪后周期对账」，与 classic 相注册等价。

setTimeout(() => {
  refreshThreads(true);
}, 2000);

setInterval(() => {
  if (document.visibilityState === 'visible') {
    refreshThreads();
  }
}, THREADS_REFRESH_INTERVAL_MS);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    refreshThreads();
  }
});

// ── 桥接期兼容面（仍 classic / 仍经 window 取用的消费方）────────────
//
// domain 取 `thread-store-engine` 而非 `thread-store`：后者已被
// thread-store-domain 认领（openConversationTarget / submitThreadInput），
// 同域二次 claim 会覆盖它的 impl、把那两个键取成 undefined（先例：
// voice-input-api 与状态域 voice-input 的分域）。
//
// 逐键消费方（配方步 5 的 grep 结果）：
//   - ClawThreads            ← session-readonly-view（只读视图冻结判定）/ app-main
//                              （绑定会话标题兜底、host seam）/ plugins/coder（线程列表投影）
//   - refreshThreads         ← workspace-actions（activate / 归档 / 接力后强刷）/
//                              persistent-input / trim-page / ctx-menu-items /
//                              threads-domain / im-actions / ph-session-move / app-main
//   - getThreadById          ← thread-store-domain / ctx-menu-items / home-dashboard（悬置域）/
//                              plugins/coder
//   - getThreadForSession    ← thread-store-domain / session-list-render / session-readonly-view /
//                              ctx-menu-items / app-main
//   - getActiveThreadInputTarget ← persistent-input / input-composer / input-render /
//                              sidebar-render / app-main
//   - isThreadHostAgentId    ← sidebar-render / workspace-actions / slash-commands /
//                              session-dialogs / trim-page
//   - updateThreadHeaderIndicator ← thread-store-domain / session-readonly-view / app-main
//   - createThreadStoreHost  ← thread-store-domain（装载期取用，见下方顺序约束）
//
// 注销条件：以上消费方逐批改具名 import 后逐键注销（`-domain` / `-render` /
// `-main` 三件收口时整块删）。
//
// 装载顺序约束（接线必读）：`createThreadStoreHost()` 在 thread-store-domain
// 的**模块求值期**被调用，因此本模块必须先于 thread-store-domain 求值。
// p2-entry 经 workspace-actions 的 import 链带入 thread-store-domain，故
// `import './thread-store.js'` 必须排在 p2-entry **之前**（kernel-entry 顶部）；
// 放进 p4-entry 会晚于 p2-entry，装载期即 TypeError。
const bridged = {
  ClawThreads,
  refreshThreads,
  getThreadById,
  getThreadForSession,
  getActiveThreadInputTarget,
  isThreadHostAgentId,
  updateThreadHeaderIndicator,
  createThreadStoreHost,
};
// 逐键显式注册（不用循环）：桥债口径按 defineKey 调用点数计量。
window.KernelState.defineKey('thread-store-engine', 'ClawThreads', bridged.ClawThreads);
window.KernelState.defineKey('thread-store-engine', 'refreshThreads', bridged.refreshThreads);
window.KernelState.defineKey('thread-store-engine', 'getThreadById', bridged.getThreadById);
window.KernelState.defineKey('thread-store-engine', 'getThreadForSession', bridged.getThreadForSession);
window.KernelState.defineKey('thread-store-engine', 'getActiveThreadInputTarget', bridged.getActiveThreadInputTarget);
window.KernelState.defineKey('thread-store-engine', 'isThreadHostAgentId', bridged.isThreadHostAgentId);
window.KernelState.defineKey('thread-store-engine', 'updateThreadHeaderIndicator', bridged.updateThreadHeaderIndicator);
window.KernelState.defineKey('thread-store-engine', 'createThreadStoreHost', bridged.createThreadStoreHost);
window.KernelState.claim('thread-store-engine', {
  get: (key) => bridged[key],
  set: (key, value) => {
    bridged[key] = value;
    // 状态对象是模块活绑定：classic 写方整对象替换必须让引擎自身也看见。
    if (key === 'ClawThreads') ClawThreads = value;
  },
});
