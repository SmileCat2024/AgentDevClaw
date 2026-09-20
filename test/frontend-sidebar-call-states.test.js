/**
 * refreshAgentCallStates 的 SSE 语义切换测试（S3 修复核心，docs/sse-migration-bcd-preparation.md §5.3）。
 *
 * 提取 sidebar-render.js 的真实函数在沙箱内执行，验证：
 *   - SSE 激活时本地条目不 fetch、不进覆写循环（缺席≠空闲，事件态不被轮询清掉）
 *   - 在线远程条目在 SSE 激活时仍走轮询（SSE 不覆盖远程）
 *   - includeSseLocals（visibilitychange 全量对账）恢复本地条目轮询参与
 *   - applyAgentCallStateFromNotification（事件路径共用）true→false 完成语义
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
