/**
 * IM 前端交互层（ADR-0042 里程碑 2）的请求契约测试。
 *
 * frontend-im-thread-shape.test.js 锁的是「数据形状」；本文件锁的是
 * 「点下去发出什么请求」。里程碑 1 之后前端交互层与服务端的错配是
 * 实际故障的来源，逐条对应：
 *
 *   1. 绑定线路必然 400 —— 前端发 { lineId, carrier, agentId, sessionId }，
 *      服务端要求 agentId + threadId 成对；
 *   2. 换个渠道就静默丢绑定 —— im_line_transfer 只收到 carrier 时会把
 *      boundTarget 清空，前端必须在改 carrier 时把既有绑定一起带上；
 *   3. 新建门户对话多造一条线程 —— 旧路径走 create_session，而 qqbot 是
 *      threadHost，服务端事务已负责建线程与换代归档。
 *
 * 用真实源码在 vm 沙箱执行，fetch 用记录型 stub 替换，断言落在
 * 「请求 URL + 请求体」上，不依赖内部实现分支。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

/**
 * 加载 im-actions.js 并注入记录型 fetch。
 *
 * 依赖面按 im-actions 文件头的声明提供：im-ui 的归一/草稿/目标清单能力、
 * app-core 的全局状态、thread-store 的导航入口。这里只需要它们「存在」，
 * 行为由各自的测试负责。
 */
function loadIMActions({ draft, routableTargets = [], responses = {} } = {}) {
  const fetchCalls = [];

  const imWorkspaceState = {
    data: null,
    draft,
    loading: false,
    saving: false,
    error: '',
    savedAt: null,
    routableTargets,
    routableTargetsRequest: null,
  };

  const sandbox = createFrontendSandbox({
    imWorkspaceState,
    imWorkspaceRequest: null,
    imWorkspaceAutoSaveTimer: null,
    qqbotConfigState: { data: null, draft: null, loading: false, error: '', sourcePath: '', savedAt: null },
    qqbotConfigRequest: null,
    currentLanguage: 'zh',
    // ── im-ui.js 提供的能力 ──
    normalizeIMWorkspaceBundleData(raw) { return JSON.parse(JSON.stringify(raw || {})); },
    normalizeQQBotConfigData(raw) { return raw || {}; },
    getQQBotConfigDraft() { return {}; },
    ensureQQBotConfigLoaded() { return Promise.resolve({}); },
    getIMWorkspaceDraft() { return imWorkspaceState.draft; },
    ensureIMWorkspaceLoaded() { return Promise.resolve(null); },
    ensureIMRoutableTargetsLoaded() { return Promise.resolve(routableTargets); },
    imParseLineTargetValue(value) {
      const raw = String(value || '');
      const index = raw.indexOf('::');
      if (index <= 0) return { agentId: '', threadId: '' };
      return { agentId: raw.slice(0, index), threadId: raw.slice(index + 2) };
    },
    // ── 宿主与导航 ──
    renderCurrentMainView() {},
    loadAgents() { return Promise.resolve(); },
    markActionLoading() {},
    fetch: async (url, init = {}) => {
      fetchCalls.push({
        url,
        method: init.method || 'GET',
        body: init.body ? JSON.parse(init.body) : null,
      });
      const responder = responses[url];
      const payload = typeof responder === 'function' ? responder(init) : (responder ?? { ok: true });
      return {
        ok: payload.ok !== false,
        status: payload.status || 200,
        json: async () => payload,
        text: async () => JSON.stringify(payload),
      };
    },
  });

  // thread-store.js 的导航入口：im-actions 通过 window 取用
  const openCalls = [];
  const alerts = [];
  sandbox.window.openConversationTarget = async (target) => {
    openCalls.push({ agentId: target.agentId, threadId: target.threadId });
    return { ok: true };
  };
  sandbox.window.refreshThreads = async () => {};
  // 沙箱自带的 window.alert 是空实现，这里换成记录型以便观察失败路径
  sandbox.window.alert = (message) => { alerts.push(String(message)); };

  sandbox.loadSource('public/src/modules/im-actions.js');
  return { sandbox, fetchCalls, openCalls, alerts };
}

/** 草稿形状：一条接 qq 的线路，绑到 coder 线程。 */
function makeDraft({ boundThreadId = 'wt-coder-1', carrier = 'qq' } = {}) {
  return {
    workspaceConfig: {
      operatorThreadId: 'wt-operator-1',
      lines: [
        {
          id: 'line1',
          label: '通道 1',
          carrier,
          boundTarget: boundThreadId ? { agentId: 'coder', threadId: boundThreadId } : null,
        },
      ],
    },
    qqConfig: {},
    feishuConfig: {},
    wecomConfig: {},
    rokidConfig: {},
  };
}

test('线路绑定线程：请求体带 agentId + threadId，不发 sessionId', async () => {
  const { sandbox, fetchCalls } = loadIMActions({
    draft: makeDraft({ boundThreadId: null }),
    responses: { '/protoclaw/im_line_transfer': { ok: true, bundle: makeDraft() } },
  });

  await sandbox.window.handleLineTargetChange('line1', 'coder::wt-coder-9');

  const transfer = fetchCalls.find((c) => c.url === '/protoclaw/im_line_transfer');
  assert.ok(transfer, '应调用 im_line_transfer');
  assert.equal(transfer.method, 'POST');
  assert.deepEqual(transfer.body, {
    lineId: 'line1',
    carrier: 'qq',
    agentId: 'coder',
    threadId: 'wt-coder-9',
  });
  // 服务端按 agentId + threadId 成对校验，sessionId 是已退役的寻址方式
  assert.equal('sessionId' in transfer.body, false);
});

test('线路目标清空：走 disconnect 而不是 transfer 空绑定', async () => {
  const { sandbox, fetchCalls } = loadIMActions({
    draft: makeDraft(),
    responses: { '/protoclaw/im_line_disconnect': { ok: true, bundle: makeDraft({ boundThreadId: null }) } },
  });

  await sandbox.window.handleLineTargetChange('line1', '');

  assert.ok(fetchCalls.some((c) => c.url === '/protoclaw/im_line_disconnect'));
  assert.equal(fetchCalls.some((c) => c.url === '/protoclaw/im_line_transfer'), false);
});

test('渠道切换保留既有绑定：carrier 变更时一并提交当前 boundTarget', async () => {
  // 服务端 im_line_transfer 在「只给 carrier 不给目标」时会清空绑定，
  // 因此前端必须把当前绑定原样带上，否则用户换个渠道就丢绑定。
  const { sandbox, fetchCalls } = loadIMActions({
    draft: makeDraft({ boundThreadId: 'wt-coder-1', carrier: 'qq' }),
    responses: { '/protoclaw/im_line_transfer': { ok: true, bundle: makeDraft() } },
  });

  await sandbox.window.handleLineCarrierChange('line1', 'weixin');

  const transfer = fetchCalls.find((c) => c.url === '/protoclaw/im_line_transfer');
  assert.ok(transfer);
  assert.deepEqual(transfer.body, {
    lineId: 'line1',
    carrier: 'weixin',
    agentId: 'coder',
    threadId: 'wt-coder-1',
  });
});

test('渠道切换与原 carrier 相同：仍按新 carrier 提交（不因相等而跳过）', async () => {
  const { sandbox, fetchCalls } = loadIMActions({
    draft: makeDraft({ boundThreadId: null, carrier: 'qq' }),
    responses: { '/protoclaw/im_line_transfer': { ok: true, bundle: makeDraft() } },
  });

  await sandbox.window.handleLineCarrierChange('line1', 'qq');

  const transfer = fetchCalls.find((c) => c.url === '/protoclaw/im_line_transfer');
  assert.equal(transfer.body.carrier, 'qq');
  // 无绑定时不带 agentId/threadId，避免服务端把空目标当成一次绑定改写
  assert.equal('agentId' in transfer.body, false);
});

test('打开门户对话：走 im_operator/conversation/start', async () => {
  const { sandbox, fetchCalls, openCalls } = loadIMActions({
    draft: makeDraft(),
    responses: {
      '/protoclaw/im_operator/conversation/start': {
        ok: true,
        threadId: 'wt-operator-1',
        thread: { agentId: 'qqbot', threadId: 'wt-operator-1' },
      },
    },
  });

  await sandbox.window.launchOperatorConversation(false);

  const start = fetchCalls.find((c) => c.url === '/protoclaw/im_operator/conversation/start');
  assert.ok(start, '应调用 conversation/start');
  assert.equal(start.method, 'POST');
  // 不得回退到 create_session：qqbot 是 threadHost，那会多造一条线程
  assert.equal(fetchCalls.some((c) => String(c.url).includes('create_session')), false);
  assert.deepEqual(openCalls, [{ agentId: 'qqbot', threadId: 'wt-operator-1' }]);
});

test('新建门户对话：走 conversation/new 并导航到新线程', async () => {
  const { sandbox, fetchCalls, openCalls } = loadIMActions({
    draft: makeDraft(),
    responses: {
      '/protoclaw/im_operator/conversation/new': {
        ok: true,
        threadId: 'wt-operator-2',
        thread: { agentId: 'qqbot', threadId: 'wt-operator-2' },
      },
    },
  });

  await sandbox.window.launchOperatorConversation(true);

  assert.ok(fetchCalls.some((c) => c.url === '/protoclaw/im_operator/conversation/new'));
  assert.equal(fetchCalls.some((c) => String(c.url).includes('conversation/start')), false);
  assert.deepEqual(openCalls, [{ agentId: 'qqbot', threadId: 'wt-operator-2' }]);
});

test('门户对话失败：不回写 receptionistSessionId，不清空既有引用', async () => {
  const draft = makeDraft();
  const { sandbox, fetchCalls, alerts } = loadIMActions({
    draft,
    responses: {
      '/protoclaw/im_operator/conversation/start': { ok: false, status: 500, message: 'boom' },
    },
  });

  await sandbox.window.launchOperatorConversation(false);

  // 失败时给出可读提示，且不产生任何配置写回
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /boom/);
  assert.equal(fetchCalls.some((c) => c.method === 'PUT'), false);
  assert.equal(draft.workspaceConfig.operatorThreadId, 'wt-operator-1');
});
