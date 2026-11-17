/**
 * ph-thread-history.js 真实行为（P2 W1-4）。
 *
 * 该模块已迁 ESM：面板打开目标（overlay / agent / thread）是模块私有状态，
 * 语言、转义与 toast 走真实 ESM 依赖，classic 宿主通道（runWorkspaceAction）
 * 以 window 桩观察；通知经真实 ClawToast.show 的接口替身捕获。覆盖 ADR-0032 决策 3 的三条入口：存档列表、
 * 「查看原文」只读挂载、以及「从这段继续」的分支请求。
 *
 * 原 vm 沙箱文件（frontend-ph-thread-history.test.js）不在本批授权范围，
 * 由本文件以真实 import 路线接管其核心断言。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserStubs, loadModuleOnce } from './helpers/esm-module-loader.js';

let cleanupGlobals = null;
let threadHistory = null;
let i18n = null;
let calls = null;
let created = [];

function makeElement() {
  const listeners = new Map();
  return {
    id: '',
    className: '',
    innerHTML: '',
    textContent: '',
    parentNode: null,
    dataset: {},
    addEventListener(type, callback) { listeners.set(type, callback); },
    dispatch(type, event) { listeners.get(type)?.(event); },
    querySelectorAll() { return []; },
    appendChild(el) { el.parentNode = this; created.push(el); return el; },
    removeChild(el) { const index = created.indexOf(el); if (index >= 0) created.splice(index, 1); el.parentNode = null; return el; },
    remove() { this.parentNode = null; },
  };
}

const body = {
  appendChild(el) { el.parentNode = body; created.push(el); return el; },
  removeChild(el) { const index = created.indexOf(el); if (index >= 0) created.splice(index, 1); el.parentNode = null; return el; },
};

before(async () => {
  cleanupGlobals = installBrowserStubs({
    window: {
      escapeHtml: (text) => String(text).replace(/[&<>"']/g, (m) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      }[m])),
      ClawFW: {
        actions: {
          handlers: new Map(),
          registerMany(map) { for (const [name, handler] of Object.entries(map)) this.handlers.set(name, handler); },
          invoke(name, el) { return this.handlers.get(name)(el); },
        },
      },
    },
    document: {
      createElement: () => makeElement(),
      getElementById: (id) => (id === 'ph-thread-history-host' ? null : null),
      body,
      addEventListener() {},
    },
  });
  await loadModuleOnce('public/src/modules/kernel-state.js', { installGlobals: false });
  i18n = await import('../public/src/modules/i18n-environment-state.js');
  // toast 已是 ESM 依赖：替换真实 ClawToast 的 show 接口观察通知（同一实例）
  const { ClawToast } = await import('../public/src/modules/toast-notify.js');
  ClawToast.show = (payload) => calls?.toasts.push(payload);
  threadHistory = (await loadModuleOnce('public/src/modules/ph-thread-history.js', { installGlobals: false })).module;
});

after(() => { cleanupGlobals(); });

function reset() {
  calls = { toasts: [], workspaceActions: [], runAction: 0 };
  i18n.setCurrentLanguage('zh');
  created = [];
  Object.assign(window, {
    runWorkspaceAction: (raw) => { calls.runAction += 1; calls.workspaceActions.push(raw); },
  });
}

/** 打开面板后模块挂载的 overlay（host div 先建，overlay 随后）。 */
const overlay = () => created[1];

const chainMeta = [
  { sessionId: 'sess-old', title: 'Old <b>title</b>', endKind: 'trim', endedAt: '2026-01-02T03:04:05Z', messageCount: 12 },
  { sessionId: 'wt-1', title: 'Head', role: 'head', endKind: 'summary' },
  { sessionId: 'sess-sum', title: 'Summarised', endKind: 'summary' },
];

test('the archive panel lists older generations, never the head, and pins agent/thread on the action', async () => {
  reset();
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ sessionChainMeta: chainMeta }) });

  await threadHistory.openThreadHistory('programming-helper', 'wt-1');

  const html = overlay().innerHTML;
  assert.match(html, /Old &lt;b&gt;title&lt;\/b&gt;/, 'title is escaped');
  assert.match(html, /精简前/, 'trim archives are labelled');
  assert.match(html, /12 条消息/);
  assert.match(html, /摘要前/);
  assert.doesNotMatch(html, /Head/, 'the head session is not listed as an archive');

  const actionJson = /data-workspace-action="([^"]+)"/.exec(html)[1]
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const action = JSON.parse(actionJson);
  assert.equal(action.type, 'view_session_record');
  assert.equal(action.agentId, 'programming-helper');
  assert.equal(action.sessionId, 'sess-old');
  assert.equal(action.threadId, 'wt-1', '只读浏览据此冻结在线程历史成员上');
});

test('view original closes the panel and forwards the read-only action', async () => {
  reset();
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ sessionChainMeta: chainMeta }) });
  await threadHistory.openThreadHistory('programming-helper', 'wt-1');

  const raw = JSON.stringify({ type: 'view_session_record', agentId: 'programming-helper', sessionId: 'sess-old', threadId: 'wt-1' });
  window.PhThreadHistory.viewOriginal(raw);

  assert.deepEqual(calls.workspaceActions, [raw]);
  assert.equal(created.length, 1, '面板已从宿主摘除（只留 host 容器）');
});

test('continue from an archive branches to the end of that generation and opens the new session', async () => {
  reset();
  let phase = 'chain';
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    if (phase === 'chain') return { ok: true, json: async () => ({ sessionChainMeta: chainMeta }) };
    requests.push({ url: String(url), options });
    if (String(url).includes('/session_record?')) {
      return { ok: true, json: async () => ({ messages: [{ role: 'user' }, { role: 'assistant' }, { role: 'user' }] }) };
    }
    return { ok: true, json: async () => ({ newSessionId: 'sess-new' }) };
  };
  await threadHistory.openThreadHistory('programming-helper', 'wt-1');
  phase = 'branch';

  const button = { disabled: false };
  await window.PhThreadHistory.continueFrom('sess-old', button);

  const branch = requests.find((entry) => entry.url === '/protoclaw/sessions/branch');
  assert.deepEqual(JSON.parse(branch.options.body), {
    agentId: 'programming-helper',
    sourceSessionId: 'sess-old',
    cutMsgIndexEnd: 2,
  });
  assert.equal(button.disabled, true);
  assert.equal(calls.toasts.at(-1).status, 'success');
  assert.deepEqual(JSON.parse(calls.workspaceActions.at(-1)), { type: 'open_session', sessionId: 'sess-new' });
  assert.equal(created.length, 1, '分支发起后面板关闭');
});

test('a failing archive read re-enables the button and reports through the toast', async () => {
  reset();
  let phase = 'chain';
  globalThis.fetch = async (url) => {
    if (phase === 'chain') return { ok: true, json: async () => ({ sessionChainMeta: chainMeta }) };
    if (String(url).includes('/session_record?')) return { ok: false, status: 500, text: async () => '' };
    return { ok: true, json: async () => ({}) };
  };
  await threadHistory.openThreadHistory('programming-helper', 'wt-1');
  phase = 'branch';

  const button = { disabled: false };
  await window.PhThreadHistory.continueFrom('sess-old', button);

  assert.equal(button.disabled, false);
  assert.equal(calls.toasts.at(-1).status, 'error');
  assert.match(calls.toasts.at(-1).title, /record request failed: 500/);
  assert.equal(calls.runAction, 0);
});

test('an empty chain reports informationally and never mounts a panel', async () => {
  reset();
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ sessionChainMeta: [] }) });

  await threadHistory.openThreadHistory('programming-helper', 'wt-1');

  assert.equal(calls.toasts.length, 1);
  assert.equal(calls.toasts[0].status, 'info');
  assert.equal(created.length, 0, '空链不建面板容器');
});
