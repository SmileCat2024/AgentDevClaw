/**
 * refreshAgentCallStates 的 SSE 语义切换测试（S3 修复核心，docs/sse-migration-bcd-preparation.md §5.3）。
 *
 * 提取 sidebar-render.js 的真实函数在沙箱内执行，验证：
 *   - SSE 激活时本地条目不 fetch、不进覆写循环（缺席≠空闲，事件态不被轮询清掉）
 *   - 在线远程条目在 SSE 激活时仍走轮询（SSE 不覆盖远程）
 *   - includeSseLocals（visibilitychange 全量对账）恢复本地条目轮询参与
 *   - applyAgentCallStateFromNotification（事件路径共用）true→false 完成语义
 *   - 聚焦会话 calling 边沿触发发送按钮三态同步（远程轮询路径补齐）
 *   - applyCallStateToAgentRecords 的 prebuilt 跳过与幂等
 *   - prebuilt 宿主行 callActive 清理不随 SSE 本地跳过而消失
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SIDEBAR_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'src', 'modules', 'sidebar-render.js'),
  'utf8',
);

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start === -1) throw new Error(`Missing start marker: ${startMarker}`);
  if (end === -1) throw new Error(`Missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

/**
 * 构建加载了提取函数的沙箱。sseActive 由用例即时翻转（模块闭包读全局）。
 * isSuspendedNotificationPayload 采用与 runtime-status.js 相同的判定语义
 * （state.call.finish 的 data 与 runtime.lastOutcome 双路径），用例以真实
 * 快照形态驱动判定，不依赖外部 flag 时序。
 */
function loadCallStates() {
  const fetched = [];
  const finishedNotified = [];
  const renders = [];
  let sseActive = false;
  const ctx = createFrontendSandbox({
    fetch: async (url) => {
      fetched.push(String(url));
      const match = /\/api\/agents\/([^/]+)\/notification/.exec(String(url));
      const calling = match && match[1].startsWith('remote%3A') ? 'remote-calling' : 'local-calling';
      return { ok: true, status: 200, json: async () => ({ callActive: calling === 'will-idle' }) };
    },
    isSseActive: () => sseActive,
    isRemoteNamespaceAgentId: (id) => String(id || '').startsWith('remote:'),
    getVisibleRemoteEntries: () => [],
    getAgentRuntimeId: (agent) => agent?.runtime_session_id || agent?.runtimeSessionId || null,
    normalizeAgentIdentity: (v) => String(v || '').trim(),
    resolveNotificationCallingState: (payload) => payload?.callActive === true,
    isSuspendedNotificationPayload: (payload) => {
      const isSuspendedOutcome = (d) => !!(d && typeof d === 'object'
        && String(d.status || '').trim() === 'continued'
        && String(d.reason || '').trim() === 'suspended');
      const stateType = String(payload?.state?.type || '').trim();
      if (stateType === 'call.finish') return isSuspendedOutcome(payload.state?.data);
      if (stateType === 'call.start') return false;
      return isSuspendedOutcome(payload?.runtime?.lastOutcome);
    },
    getNotificationCallStartedAt: (payload) => payload?.callStartedAt || 0,
    isInterruptSuppressed: () => false,
    clearInterruptSuppression: () => {},
    _markAgentCallStartedForNotify: () => {},
    _tryNotifyAgentFinished: (runtimeId, payload) => finishedNotified.push({ runtimeId, payload }),
    renderAgentList: () => renders.push(1),
    currentRuntimeAgentId: 'rt-focus',
  });
  // 函数内部状态（提取片段中直接引用）
  ctx.run(`
    const _agentCallActive = new Map();
    const _agentSuspended = new Map();
    const _interruptSuppression = new Map();
    const _recentlyFinishedRuntimes = new Set();
    let lastCallStateRefreshAt = 0;
    let _callStatesRefreshInProgress = false;
  `);
  ctx.run(sourceBetween(SIDEBAR_SOURCE, 'function collectActiveCallRuntimeIds', 'let _callStatesRefreshInProgress'));
  ctx.run(sourceBetween(SIDEBAR_SOURCE, 'function applyAgentCallStateFromNotification', 'async function refreshAgentCallStates'));
  ctx.run(sourceBetween(SIDEBAR_SOURCE, 'async function refreshAgentCallStates', 'let lastAgentListRenderSignature'));
  return {
    ctx,
    fetched,
    finishedNotified,
    renders,
    setSseActive: (v) => { sseActive = v; },
    run: (code) => ctx.run(code),
  };
}

const LOCAL_AGENTS = [{ connected: true, runtime_session_id: 'rt-local-1', name: 'L1' }];

describe('refreshAgentCallStates: SSE 语义切换（S3）', () => {
  let env;
  beforeEach(() => { env = loadCallStates(); });

  it('SSE 激活 + 仅本地条目：零 fetch 且状态保留', async () => {
    env.setSseActive(true);
    env.ctx.allAgents = LOCAL_AGENTS;
    env.run('applyAgentCallStateFromNotification("rt-local-1", { callActive: true })');
    await env.run('refreshAgentCallStates([{ connected: true, runtime_session_id: "rt-local-1", name: "L1" }])');
    assert.equal(env.fetched.length, 0, '本地条目不 fetch');
    const active = env.run('Array.from(_agentCallActive.keys())');
    assert.deepEqual(JSON.parse(JSON.stringify(active)), ['rt-local-1'], '事件态不被覆写循环清掉');
  });

  it('SSE 激活 + 本地与远程混合：只 fetch 远程条目', async () => {
    env.setSseActive(true);
    await env.run(`refreshAgentCallStates([
      { connected: true, runtime_session_id: "rt-local-1", name: "L1" },
      { connected: true, runtime_session_id: "remote:host1:rt-9", name: "R1" },
    ])`);
    assert.equal(env.fetched.length, 1);
    assert.ok(env.fetched[0].includes('remote%3A'), '只轮询远程条目: ' + env.fetched[0]);
  });

  it('SSE 关闭：全部条目照常轮询', async () => {
    env.setSseActive(false);
    await env.run(`refreshAgentCallStates([
      { connected: true, runtime_session_id: "rt-local-1", name: "L1" },
      { connected: true, runtime_session_id: "remote:host1:rt-9", name: "R1" },
    ])`);
    assert.equal(env.fetched.length, 2);
  });

  it('includeSseLocals（visibilitychange 全量对账）：SSE 激活下本地条目也轮询', async () => {
    env.setSseActive(true);
    await env.run(`refreshAgentCallStates([{ connected: true, runtime_session_id: "rt-local-1", name: "L1" }], { includeSseLocals: true })`);
    assert.equal(env.fetched.length, 1);
  });

  it('prebuilt 宿主行 callActive 清理不随 SSE 本地跳过消失', async () => {
    env.setSseActive(true);
    const result = await env.run(`(async () => {
      const agents = [{ connected: true, source: "prebuilt", runtime_session_id: "rt-host", callActive: true }];
      await refreshAgentCallStates(agents);
      return agents[0].callActive;
    })()`);
    assert.equal(result, false, 'prebuilt 宿主行被无条件清理');
    assert.equal(env.fetched.length, 0, 'SSE 激活时不因清理而 fetch');
  });

  it('F2b：SSE 激活 + 无远程条目时断连条目仍被孤儿回收（提前返回分支）', async () => {
    env.setSseActive(true);
    // rt-dead 曾在调用中，现已断连（不在 agents 的 connected 集）
    env.run('applyAgentCallStateFromNotification("rt-dead", { callActive: true })');
    await env.run('refreshAgentCallStates([{ connected: true, runtime_session_id: "rt-alive" }])');
    const active = env.run('Array.from(_agentCallActive.keys())');
    assert.deepEqual(JSON.parse(JSON.stringify(active)), [], '断连条目被回收');
    assert.equal(env.fetched.length, 0);
  });

  it('F2a：断连 agent 的 callActive 覆写 false（覆写循环遍历 agents 全集）', async () => {
    env.setSseActive(false);
    const result = await env.run(`(async () => {
      const agents = [
        { connected: true, runtime_session_id: "rt-live", callActive: false },
        { connected: false, runtime_session_id: "rt-gone", callActive: true },
      ];
      await refreshAgentCallStates(agents);
      return agents.map((a) => [a.runtime_session_id, a.callActive === true]);
    })()`);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), [['rt-live', false], ['rt-gone', false]]);
  });

  it('F2a/S3 平衡：SSE 激活时本地存活条目的 callActive 豁免覆写（缺席≠空闲）', async () => {
    env.setSseActive(true);
    const result = await env.run(`(async () => {
      const agents = [{ connected: true, runtime_session_id: "rt-local-1", callActive: true }];
      await refreshAgentCallStates(agents);
      return agents[0].callActive === true;
    })()`);
    assert.equal(result, true, '事件维护的本地存活条目不被覆写 false');
    assert.equal(env.fetched.length, 0, '零 fetch');
  });
});

describe('applyAgentCallStateFromNotification: 事件路径共用消费（S3）', () => {
  let env;
  beforeEach(() => { env = loadCallStates(); });

  it('非焦点 true→false：记录完成并触发完成通知', () => {
    env.run('applyAgentCallStateFromNotification("rt-other", { callActive: true })');
    env.run('applyAgentCallStateFromNotification("rt-other", { callActive: false })');
    assert.equal(env.finishedNotified.length, 1);
    assert.equal(env.finishedNotified[0].runtimeId, 'rt-other');
    const finished = env.run('Array.from(_recentlyFinishedRuntimes)');
    assert.deepEqual(JSON.parse(JSON.stringify(finished)), ['rt-other']);
  });

  it('焦点 true→false：不进 recentlyFinished（避免自我标记）', () => {
    env.run('applyAgentCallStateFromNotification("rt-focus", { callActive: true })');
    env.run('applyAgentCallStateFromNotification("rt-focus", { callActive: false })');
    assert.equal(env.finishedNotified.length, 1); // 完成通知仍触发
    const finished = env.run('Array.from(_recentlyFinishedRuntimes)');
    assert.deepEqual(JSON.parse(JSON.stringify(finished)), []);
  });

  it('false→false 幂等：不触发完成通知', () => {
    env.run('applyAgentCallStateFromNotification("rt-other", { callActive: false })');
    assert.equal(env.finishedNotified.length, 0);
  });

  it('ADR-0019 非焦点挂起落定：_agentSuspended 置位（recentlyFinished 同步记录但由渲染优先级掩盖）', () => {
    env.run('applyAgentCallStateFromNotification("rt-other", { callActive: true })');
    env.run('applyAgentCallStateFromNotification("rt-other", { runtime: { callActive: false, lastOutcome: { status: "continued", reason: "suspended" } }, callActive: false })');
    const suspended = env.run('Array.from(_agentSuspended.keys())');
    assert.deepEqual(JSON.parse(JSON.stringify(suspended)), ['rt-other'], '挂起聚合置位（侧栏静止绿灯数据源）');
    // recentlyFinished 也记录（挂起也是 call 结束边沿），渲染端 suspended 优先级掩盖
    const finished = env.run('Array.from(_recentlyFinishedRuntimes)');
    assert.deepEqual(JSON.parse(JSON.stringify(finished)), ['rt-other']);
  });

  it('ADR-0019 唤醒轮 call.start：挂起聚合清除（calling 转圈接管）', () => {
    env.run('applyAgentCallStateFromNotification("rt-other", { callActive: true })');
    env.run('applyAgentCallStateFromNotification("rt-other", { runtime: { callActive: false, lastOutcome: { status: "continued", reason: "suspended" } }, callActive: false })');
    env.run('applyAgentCallStateFromNotification("rt-other", { callActive: true })');
    const suspended = env.run('Array.from(_agentSuspended.keys())');
    assert.deepEqual(JSON.parse(JSON.stringify(suspended)), [], '新 call 开始即清挂起');
  });

  it('聚焦会话 calling 边沿：触发发送按钮三态同步（远程轮询路径补齐）', () => {
    const syncs = [];
    env.ctx._syncPersistentActionButton = () => { syncs.push(1); };
    env.run('applyAgentCallStateFromNotification("rt-focus", { callActive: true })');
    assert.equal(syncs.length, 1, 'false→true 边沿触发按钮同步（call 开始 → stop 态）');
    env.run('applyAgentCallStateFromNotification("rt-focus", { callActive: true })');
    assert.equal(syncs.length, 1, '无 calling 边沿不重复触发');
    env.run('applyAgentCallStateFromNotification("rt-focus", { callActive: false })');
    assert.equal(syncs.length, 2, 'true→false 边沿触发按钮同步（call 结束 → send 态）');
  });

  it('非聚焦会话 calling 边沿：不触发发送按钮同步', () => {
    const syncs = [];
    env.ctx._syncPersistentActionButton = () => { syncs.push(1); };
    env.run('applyAgentCallStateFromNotification("rt-other", { callActive: true })');
    env.run('applyAgentCallStateFromNotification("rt-other", { callActive: false })');
    assert.equal(syncs.length, 0, '非聚焦 runtime 的边沿不碰聚焦会话的按钮');
  });

  it('挂起边沿（calling 无变化）不触发按钮同步', () => {
    const syncs = [];
    env.ctx._syncPersistentActionButton = () => { syncs.push(1); };
    env.run('applyAgentCallStateFromNotification("rt-focus", { runtime: { callActive: false, lastOutcome: { status: "continued", reason: "suspended" } }, callActive: false })');
    assert.equal(syncs.length, 0, 'idle→挂起的落定不触发按钮（按钮只读 calling）');
  });

  it('ADR-0019 非挂起落定：聚合清除', () => {
    env.run('applyAgentCallStateFromNotification("rt-other", { callActive: true })');
    env.run('applyAgentCallStateFromNotification("rt-other", { runtime: { callActive: false, lastOutcome: { status: "continued", reason: "suspended" } }, callActive: false })');
    env.run('applyAgentCallStateFromNotification("rt-other", { callActive: false })');
    const suspended = env.run('Array.from(_agentSuspended.keys())');
    assert.deepEqual(JSON.parse(JSON.stringify(suspended)), []);
  });

  it('ADR-0019 poll 全清分支：_agentSuspended 随 _agentCallActive 对称清空', async () => {
    env.run('applyAgentCallStateFromNotification("rt-lone", { callActive: true })');
    env.run('applyAgentCallStateFromNotification("rt-lone", { runtime: { callActive: false, lastOutcome: { status: "continued", reason: "suspended" } }, callActive: false })');
    // 无任何存活条目（polledIds 空 + 非 SSE）→ 全清
    await env.run('refreshAgentCallStates([])');
    const suspended = env.run('Array.from(_agentSuspended.keys())');
    assert.deepEqual(JSON.parse(JSON.stringify(suspended)), []);
  });

  it('ADR-0019 断连孤儿回收：挂起键随存活集回收（SSE 激活提前返回分支）', async () => {
    env.setSseActive(true);
    env.run('applyAgentCallStateFromNotification("rt-dead", { callActive: true })');
    env.run('applyAgentCallStateFromNotification("rt-dead", { runtime: { callActive: false, lastOutcome: { status: "continued", reason: "suspended" } }, callActive: false })');
    // rt-dead 已断连（不在存活集），孤儿清理应回收挂起键
    await env.run('refreshAgentCallStates([{ connected: true, runtime_session_id: "rt-alive" }])');
    const suspended = env.run('Array.from(_agentSuspended.keys())');
    assert.deepEqual(JSON.parse(JSON.stringify(suspended)), []);
  });

  it('ADR-0019 唤醒轮完整循环：挂起→转圈→再挂起（绿灯恢复）', () => {
    // T0 初始挂起轮结束（真实快照形态）
    env.run('applyAgentCallStateFromNotification("rt-loop", { callActive: true })');
    env.run('applyAgentCallStateFromNotification("rt-loop", { runtime: { callActive: false, lastOutcome: { status: "continued", reason: "suspended" } }, callActive: false })');
    assert.deepEqual(JSON.parse(JSON.stringify(env.run('Array.from(_agentSuspended.keys())'))), ['rt-loop'], 'T0 挂起：绿灯数据源');

    // T2 唤醒轮开始（真实 SSE 快照形态：state=call.start，判定显式排除挂起）
    env.run('applyAgentCallStateFromNotification("rt-loop", { state: { type: "call.start", data: {} }, runtime: { callActive: true }, callActive: true })');
    assert.deepEqual(JSON.parse(JSON.stringify(env.run('Array.from(_agentCallActive.keys())'))), ['rt-loop'], 'T2 唤醒：转圈数据源');
    assert.deepEqual(JSON.parse(JSON.stringify(env.run('Array.from(_agentSuspended.keys())'))), [], 'T2 唤醒：挂起清除');

    // T4 唤醒轮结束、再次挂起（连续挂起；state.data 与 runtime.lastOutcome 双路径均带完整 outcome）
    env.run('applyAgentCallStateFromNotification("rt-loop", { state: { type: "call.finish", data: { status: "continued", reason: "suspended" } }, runtime: { callActive: false, lastOutcome: { status: "continued", reason: "suspended" } }, callActive: false })');
    assert.deepEqual(JSON.parse(JSON.stringify(env.run('Array.from(_agentSuspended.keys())'))), ['rt-loop'], 'T4 再挂起：绿灯恢复（suspended 复位）');
    assert.deepEqual(JSON.parse(JSON.stringify(env.run('Array.from(_agentCallActive.keys())'))), [], 'T4 再挂起：转圈结束');
  });

  it('ADR-0019 唤醒轮完整循环：挂起→转圈→真完成（蓝灯窗口）', () => {
    env.run('applyAgentCallStateFromNotification("rt-loop2", { callActive: true })');
    env.run('applyAgentCallStateFromNotification("rt-loop2", { runtime: { callActive: false, lastOutcome: { status: "continued", reason: "suspended" } }, callActive: false })');
    // 唤醒轮 → 真完成（completed outcome）
    env.run('applyAgentCallStateFromNotification("rt-loop2", { state: { type: "call.start", data: {} }, runtime: { callActive: true }, callActive: true })');
    env.run('applyAgentCallStateFromNotification("rt-loop2", { state: { type: "call.finish", data: { status: "completed", reason: "completed" } }, runtime: { callActive: false, lastOutcome: { status: "completed", reason: "completed" } }, callActive: false })');
    assert.deepEqual(JSON.parse(JSON.stringify(env.run('Array.from(_agentSuspended.keys())'))), [], '真完成：挂起清除');
    assert.deepEqual(JSON.parse(JSON.stringify(env.run('Array.from(_recentlyFinishedRuntimes)'))), ['rt-loop2'], '真完成：蓝灯窗口开启');
  });
});

describe('applyCallStateToAgentRecords: 记录写入', () => {
  let env;
  beforeEach(() => { env = loadCallStates(); });

  it('匹配记录写入、prebuilt 跳过、值不变幂等', () => {
    env.ctx.allAgents = [
      { runtime_session_id: 'rt-a' },
      { runtime_session_id: 'rt-a' },
      { source: 'prebuilt', runtime_session_id: 'rt-a' },
      { runtime_session_id: 'rt-b' },
    ];
    const first = env.run('applyCallStateToAgentRecords("rt-a", true)');
    assert.equal(first, true);
    assert.equal(env.ctx.allAgents[0].callActive, true);
    assert.equal(env.ctx.allAgents[1].callActive, true);
    assert.equal(env.ctx.allAgents[2].callActive, undefined, 'prebuilt 跳过');
    assert.equal(env.ctx.allAgents[3].callActive, undefined, '非匹配不动');
    const second = env.run('applyCallStateToAgentRecords("rt-a", true)');
    assert.equal(second, false, '值不变返回 false');
  });
});
