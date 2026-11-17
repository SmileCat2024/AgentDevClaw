/**
 * thread-store-domain.js — 工作线程交互域（线程入口 / 等待表面 / 线程输入）
 *
 * 从 thread-store.js 原位拆出（P2 · thread-store 交互域批次，搬代码不改行为）：
 * 点击线程条目与接续占位、activate 响应登记、等待表面挂载、线程寻址输入，
 * 以及线程暂存文本查询。
 *
 * 收尾（最后一批）删除两个**生产零消费**的死导出：
 *   - `getActiveConversationTarget`：全树无读者（线程指向的公开事实就是
 *     `ClawThreads.activeConversation` 本身）；
 *   - `threadAdvanceHead`：head 推进由服务端事务在接续流程内完成，前端无调用方
 *     （三 thread-input 测试迁完后复核仍为零）。
 * 二者连同实现一起删除，不留私有死代码；`ClawThreads.activeConversation`
 * 仍是唯一状态面。
 *
 * 为什么刷新引擎仍留在 classic（R4 残留，不计作已迁）：
 *   - `thread-store.js` 在 index.html 的 classic 标签原位注册三条同步调度
 *     （2s 启动刷新 / 20s 周期 / visibilitychange），这条时点由装载序决定，
 *     搬到 deferred 模块相会整体推迟；
 *   - 首屏同步链 `renderCurrentMainView → renderAgentList →
 *     getAgentListRenderSignature` 直接读线程事实（等待目标签名、线程宿主
 *     判定），`refreshThreads` 收尾也直接调 `updateThreadHeaderIndicator`；
 *     这些函数必须与 classic 渲染链同相可用。引擎的闭包（索引 / 活跃会话 /
 *     挡板判定 / 重绑与重试 / 事实对账）与本模块的入口零交叉（逐条 grep 过），
 *     故可拆。
 *
 * 状态与引擎内部操作的唯一来源：`createThreadStoreHost()`（classic 引擎提供）。
 *   - `getState()` 返回**唯一实时引用** `window.ClawThreads`（每次取用，整对象
 *     替换也生效）：本模块不复制状态、不建镜像、不做 ready 队列；
 *   - 三个内部操作（活跃会话解析 / 挡板判定 / 活跃订阅同步）直接是引擎里那份
 *     实现本身，不重新实现；
 *   - 引擎自身不调用本模块任何函数（闭包已核），因此不存在「ESM 未求值而
 *     classic 已触达」的窗口。
 *   - 引擎顶层函数（`getThreadById` / `getThreadForSession` / `refreshThreads` /
 *     `updateThreadHeaderIndicator`）在 ESM 相之前已求值，本模块经 `window.*`
 *     显式调用（R4 收敛时随引擎一起改 import）。
 *
 * 显式依赖形态：
 *   - 已迁 ESM → import：`currentRuntimeAgentId`（编排 owner）、`allAgents`
 *     （agent-store owner）、`setLastRenderedChatSig`（渲染 entry owner）、
 *     `switchAgent`（runtime-switch 宿主）、`clearChatLoadingSession`
 *     （chat-loading 宿主）、`commitSessionViewPatch`（SessionView 提交策略）、
 *     `runWorkspaceAction`（工作空间动作分发）；
 *   - 仍 classic → `window.*`：`captureSessionViewToken` / `applySessionViewPatch`
 *     （session-view-state）、`renderAgentList`（sidebar-render）、
 *     `renderCurrentMainView`（app-ui）、`setViewerSessionBinding`（app-core），
 *     逐处保留原来的 `typeof` 守卫。
 *
 * 与 workspace-actions 的静态环（A↔B）：两侧互相 import，但都只在函数体内调用
 * 对端绑定（本模块顶层零解引用），求值顺序不影响可求值性；真实整图由
 * test/p2-thread-store-graph.test.js 以生产入口 kernel-entry 求值验证。收敛条件
 * 是导航原语从 workspace-actions 拆出或改单向依赖——在此之前不退回 window 调用。
 *
 * 桥键（domain `thread-store`，ESM 相注册；逐键消费证据见批次报告）：
 *   - `openConversationTarget` ← sidebar-render（线程条目点击）/ im-actions
 *     （接线员对话）/ plugins/coder（ADR-0044 插件宿主边界）；
 *   - `submitThreadInput`       ← persistent-input（发送路径）。
 *
 * 已注销的桥键：`getThreadPendingTexts` —— 唯一消费方 p2-w2-3a-queue-projection
 * 已改具名 import（纯 ESM 消费，classic 相无任何读者），故不保留 window 面，
 * 也不因「队列投影与交互域互相可达」的顾虑保留：该边是单向的
 * （queue-projection → thread-store-domain，回程无静态路径），真实图由
 * test/p2-thread-store-graph.test.js 求值验证。命名导出保留给 ESM 消费方。
 */

import { currentRuntimeAgentId } from './orchestration-state.js';
import { allAgents } from './agent-store-state.js';
import { setLastRenderedChatSig } from './render-entry-state.js';
import { switchAgent } from './runtime-switch-host.js';
import { clearChatLoadingSession } from './chat-loading-host.js';
import { commitSessionViewPatch } from './session-view-commit-host.js';
import { runWorkspaceAction } from './workspace-actions.js';

/** 唯一窄宿主：实时状态引用 + 引擎内部操作（无副本、无 mirror）。 */
const host = window.createThreadStoreHost();

/**
 * 当前激活会话所属线程的 pending 指令文本（暂存气泡数据源）。
 * 无线程 / 无 pending 返回空数组。
 */
export function getThreadPendingTexts() {
  const active = host.getCurrentActiveSession();
  if (!active || !active.agentId || !active.sessionId) return [];
  const thread = window.getThreadForSession(active.agentId, active.sessionId);
  if (!thread || Array.isArray(thread.pendingTexts)) {
    return Array.isArray(thread?.pendingTexts) ? thread.pendingTexts : [];
  }
  return [];
}

/**
 * 接续等待表面（挡板窗口唯一入口）：视图身份挂线程 + 聊天表面挂等待
 * 会话 + 拉取上一棒消息渲染。消息源是服务端会话文件只读出口
 * （/protoclaw/prebuilt_sessions/session_messages：runtime.context.messages
 * 与 viewer /messages 同源同形），挡板期间两代 runtime 都不可用也不影响
 * 上一棒对话可见。挡板结束由 head-advanced 重绑接管（loadAgentData 拉新
 * head，消息自然切换）；挡板失败收敛由引擎的
 * _reconcileConversationWithThreadHead 的死分支终结等待态。输入走线程
 * inbox 暂存（等待重绑态是 getActiveThreadInputTarget 的合法形态），新
 * head 上线后投递。
 */
async function enterThreadAwaitSurface(agentId, thread, sessionId) {
  await switchAgent(agentId, { awaitSessionId: sessionId });
  host.getState().activeConversation = {
    agentId,
    threadId: thread.threadId,
    sessionId,
    runtimeId: '',
    wasHead: true,
    awaitSurface: true,
  };
  window.applySessionViewPatch({ identity: { agentId, sessionId } });
  // 选中态收口：switchAgent 内部的侧栏渲染发生在 activeConversation 落定
  // 之前——那一刻宿主节点被判选中、占位条目判非。等待身份挂载后立即重渲
  // 侧栏纠正高亮（签名含等待目标事实，见 getAgentListRenderSignature）。
  if (typeof window.renderAgentList === 'function') window.renderAgentList();
  window.updateThreadHeaderIndicator();
  host.syncActiveThreadSubscription();
  _loadAwaitSurfaceMessages(agentId, sessionId);
  return { ok: true, target: host.getState().activeConversation };
}

/**
 * 按 threadId 进入等待表面（供「服务端已判定接续中」的调用方使用）。
 *
 * 与 openConversationTarget 的区别：本入口不做前置判定、不再发起 activate
 * 请求。调用方（如 open_session 的 409 分支）已经拿到服务端权威结论，再走
 * openConversationTarget 会先读本地线程缓存判断挡板，构成「请求 → 409 →
 * 再请求」的可循环路径。此处只负责挂视图。
 *
 * 命名必须区别于内部 enterThreadAwaitSurface（classic 时代两者同处一个
 * 文件，classic 顶层函数声明是 window 属性，同名 window 赋值会把内部函数
 * 覆盖成包装器 → 自递归、点击线程一律 thread_missing）。本模块内两者仍是
 * 不同绑定，保持该命名区分。
 */
export async function enterThreadAwaitView(target) {
  const threadId = String(target?.threadId || '').trim();
  const thread = threadId ? window.getThreadById(threadId) : null;
  if (!thread) return { ok: false, reason: 'thread_missing' };
  const agentId = String(target?.agentId || thread.agentId || '').trim();
  if (!agentId) return { ok: false, reason: 'agent_missing' };
  const sessionId = String(thread.headSessionId || target?.sessionId || '').trim();
  if (!sessionId) return { ok: false, reason: 'session_missing' };
  return enterThreadAwaitSurface(agentId, thread, sessionId);
}

function _loadAwaitSurfaceMessages(agentId, sessionId) {
  // This read is Session-owned and remains valid while no runtime is bound during rotation.
  const viewToken = window.captureSessionViewToken('', { agentId, sessionId });
  fetch(`/protoclaw/prebuilt_sessions/session_messages?agentId=${encodeURIComponent(agentId)}&sessionId=${encodeURIComponent(sessionId)}`)
    .then((response) => (response.ok ? response.json() : null))
    .then((data) => {
      // 竞态守卫：只允许仍属于该 SessionView 的响应提交。
      const selected = host.getState().activeConversation;
      if (!selected?.awaitSurface || selected.agentId !== agentId || selected.sessionId !== sessionId) return;
      if (!Array.isArray(data?.messages)) return;
      commitSessionViewPatch(viewToken, { messages: data.messages }, () => {
        setLastRenderedChatSig('');
        clearChatLoadingSession();
        if (typeof window.renderCurrentMainView === 'function') window.renderCurrentMainView();
      });
    })
    .catch(() => {});
}

export async function openConversationTarget(target) {
  const threadId = String(target?.threadId || '').trim();
  const thread = threadId ? window.getThreadById(threadId) : null;
  // threadId 已足自解析宿主：接续退役窗口的占位条目点击时 runtimeId 已不在
  // allAgents，调用方只能提供 threadId——宿主从线程事实回退，点击不得静默
  // agent_missing（否则接续中切走后切不回来）。
  const agentId = String(target?.agentId || thread?.agentId || '').trim();
  if (!agentId) return { ok: false, reason: 'agent_missing' };
  if (threadId && !thread) return { ok: false, reason: 'thread_missing' };
  const sessionId = String(thread?.headSessionId || target?.sessionId || '').trim();
  if (!sessionId) return { ok: false, reason: 'session_missing' };

  // 接力挡板窗口：head runtime 的生命周期由接续流程管理（退役 → compact
  // → successor），open_session 会无条件 startManagedAgent 给退役中的 head
  // 启动 runtime，与 rotation 直接打架（历史事故：点击接力条目触发 runtime
  // 竞态、视图混乱闪烁）。本地挂线程等待表面：视图身份挂到线程，接力徽标
  // 即时可见，head-advanced 事件原地重绑后自动接上。awaitSessionId 让
  // 切换落在该会话的聊天加载表面（等待视图）而不是工作空间首页——用户
  // 点的导航目标是这条线程，不是首页。
  if (thread && host.isHandoffActive(thread)) {
    return enterThreadAwaitSurface(agentId, thread, sessionId);
  }

  // Leave the previous conversation selected while navigation saves its draft.
  if (host.getCurrentActiveSession()?.agentId !== agentId) {
    await switchAgent(agentId);
  }

  const runtime = (Array.isArray(allAgents) ? allAgents : []).find((entry) => (
    entry?.source === 'child'
    && entry?.parent_id === agentId
    && String(entry?.active_workspace_session_id || '') === sessionId
  ));
  const runtimeId = String(runtime?.runtime_session_id || runtime?.runtimeSessionId || runtime?.id || '').trim();
  if (runtimeId && typeof window.setViewerSessionBinding === 'function') {
    window.setViewerSessionBinding(runtimeId, sessionId);
  }
  if (runtimeId) {
    await switchAgent(runtimeId);
  } else {
    // 无 runtime 可直接切换：交给工作空间动作的 open_session（服务端 activate
    // 决定挂载）。原实现在此还有一层 `typeof` 守卫与 runtime_missing 返回，
    // 那是 classic 装载序的防御；两个能力现在都是静态 import，恒可用。
    await runWorkspaceAction(JSON.stringify({ type: 'open_session', sessionId }));
  }

  const active = host.getCurrentActiveSession();
  const resolvedRuntimeId = String(currentRuntimeAgentId || runtimeId || '').trim();
  if (active?.agentId !== agentId || active?.sessionId !== sessionId || !resolvedRuntimeId) {
    return { ok: false, reason: 'navigation_failed' };
  }
  host.getState().activeConversation = {
    agentId,
    threadId: thread?.threadId || '',
    sessionId,
    runtimeId: resolvedRuntimeId,
    // 冻结事实：视图身份挂在 head 上才有资格进入「等待重绑」豁免（app-main
    // 404 处理）；历史成员浏览冻结时即非 head，不占用接续窗口语义。
    wasHead: sessionId === thread?.headSessionId,
  };
  host.syncActiveThreadSubscription();
  return { ok: true, target: host.getState().activeConversation };
}

/**
 * 登记 activate 响应中的目标事实（T006 / T003 响应 shape）。
 *
 * 服务端 activate 已按 Thread 成员关系解析目标：历史成员返回
 * `browseOnly:true` + `target`（实际生效对象 = Thread）。前端据此：
 *   - 历史成员 → ClawThreads.browseOnly 置位（顶栏只读横幅 + 输入守卫）；
 *   - 任何成员 → 刷新线程（Thread 是真实对象，不能只刷 Session）。
 *
 * @param {object} [activateResult] activate 路由的响应 JSON
 */
export function registerSessionActivateTarget(activateResult) {
  const state = host.getState();
  const target = activateResult?.target?.actual || activateResult?.target;
  if (activateResult?.browseOnly === true) {
    state.browseOnly = true;
    state.browseOnlyThreadId = String(activateResult?.target?.threadId || target?.threadId || '').trim();
  } else {
    // 非 browse-only 的打开/创建：清除历史残留的只读事实
    state.browseOnly = false;
    state.browseOnlyThreadId = '';
  }
  // 兼容 Session 入口返回实际 Thread 结果时（T003 target shape）：
  // UI 刷新 Thread 而不是只刷新 Session——head 推进 / 成员变化立即可见。
  if (target?.type === 'thread' || activateResult?.browseOnly === true) {
    void window.refreshThreads(true);
  }
  window.updateThreadHeaderIndicator();
  host.syncActiveThreadSubscription();
}

export async function submitThreadInput(threadId, payload = {}) {
  const res = await fetch(`/protoclaw/threads/${encodeURIComponent(threadId)}/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: typeof payload.text === 'string' ? payload.text : '',
      ...(Array.isArray(payload.images) ? { images: payload.images } : {}),
      ...(typeof payload.source === 'string' ? { source: payload.source } : {}),
      ...(typeof payload.sourceRef === 'string' ? { sourceRef: payload.sourceRef } : {}),
      ...(payload.kind ? { kind: payload.kind } : {}),
      ...(Array.isArray(payload.capabilityActivations)
        ? { capabilityActivations: payload.capabilityActivations } : {}),
      ...(payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
        ? { metadata: payload.metadata } : {}),
    }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.ok !== true) {
    throw Object.assign(new Error(data?.message || `thread input failed (${res.status})`), {
      code: data?.code || 'thread_input_failed',
      status: res.status,
    });
  }
  void window.refreshThreads?.(true);
  return data;
}

// ── 桥接期兼容面（classic 消费方仍按 window 键调用）──────────────────
const bridge = {
  openConversationTarget,
  submitThreadInput,
};

// 时序审计（配方第二节）：三个键的消费点全在点击 / 发送 / 通知激活 / 队列投影
// 渲染之后，晚于 deferred 模块求值，ESM 相注册即可；classic 相无触达点。
window.KernelState.defineKey('thread-store', 'openConversationTarget', openConversationTarget);
window.KernelState.defineKey('thread-store', 'submitThreadInput', submitThreadInput);
window.KernelState.claim('thread-store', {
  get: (key) => bridge[key],
  set: (key, value) => { bridge[key] = value; },
});
