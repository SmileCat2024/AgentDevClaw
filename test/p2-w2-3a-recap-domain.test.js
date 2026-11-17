/**
 * P2 第二波 3a「输入面状态所有者」——离开摘要（recap）域整体转 ESM 后的
 * 真实行为与兼容面。
 *
 * 装载路线：`withP2EsmCase`（真实 import + 真实 classic 沙箱）。classic 相跑
 * kernel-state 与 persistent-input（P4 输入面批次起是 ESM：`_ensureInputMetaBar` /
 * `_cleanupInputMetaBar` 经 persistent-input-api 桥键提供），经典宿主函数
 * （会话键、chat surface 判定、agent 记录）按生产签名注入最小桩；ESM 相跑
 * recap-hint 与其静态依赖（recap 状态 owner + 会话/身份/编排/语言域）。
 *
 * 钉住四件事：
 *   1. 策略不变：`RECAP_DISABLED` 仍断开整条触发链路，且不发请求；
 *   2. 状态 owner：`_currentRecapText` / `_recapPendingTrigger` 的读写经
 *      recap-hint 域桥面与 owner 活绑定双向一致；
 *   3. 语义 clear：新消息提交清掉文本与挂起意图，并只遗忘当前会话的
 *      shown/dismissed 记账；
 *   4. 私有 helper 不上桥（`_getRecapAgentAndSession` / `_dismissRecap` 只做
 *      命名导出），分发器动作照常登记。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';

const RECAP = 'public/src/modules/recap-hint.js';
const RECAP_STATE = 'public/src/modules/p2-w2-3a-recap-state.js';

/** 最小 DOM 元素：class 查询 / 追加 / 移除，够 recap 气泡的渲染与清理用。 */
class StubElement {
  constructor(tag = 'div', className = '') {
    this.tagName = tag.toUpperCase();
    this.className = className;
    this.id = '';
    this.innerHTML = '';
    this.textContent = '';
    this.title = '';
    this.style = {};
    this.dataset = {};
    this.children = [];
    this.parentNode = null;
    this.listeners = new Map();
  }

  get classList() {
    const self = this;
    return {
      add(name) { if (!self.classNames().includes(name)) self.className = (self.className + ' ' + name).trim(); },
      remove(name) { self.className = self.classNames().filter((c) => c !== name).join(' '); },
      toggle() {},
      contains(name) { return self.classNames().includes(name); },
    };
  }

  classNames() { return String(this.className || '').split(/\s+/).filter(Boolean); }

  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }

  insertBefore(child, ref) {
    child.parentNode = this;
    const index = ref ? this.children.indexOf(ref) : -1;
    if (index < 0) this.children.push(child); else this.children.splice(index, 0, child);
    return child;
  }

  removeChild(child) {
    this.children = this.children.filter((item) => item !== child);
    child.parentNode = null;
    return child;
  }

  remove() { if (this.parentNode) this.parentNode.removeChild(this); }

  matches(selector) {
    if (selector.startsWith('.')) return this.classNames().includes(selector.slice(1));
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    return this.tagName === selector.toUpperCase();
  }

  querySelector(selector) {
    for (const child of this.children) {
      if (child.matches?.(selector)) return child;
      const nested = child.querySelector?.(selector);
      if (nested) return nested;
    }
    return null;
  }

  querySelectorAll(selector) {
    const out = [];
    for (const child of this.children) {
      if (child.matches?.(selector)) out.push(child);
      out.push(...(child.querySelectorAll?.(selector) || []));
    }
    return out;
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  removeEventListener() {}
  setAttribute() {}
  removeAttribute() {}
  closest() { return null; }
  contains(node) { return this.children.includes(node); }
}

function createDocumentStub() {
  const elements = new Map();
  return {
    elements,
    getElementById(id) { return elements.get(id) || null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement: (tag) => new StubElement(tag),
    createTextNode: (text) => ({ textContent: text }),
    addEventListener() {},
    removeEventListener() {},
    body: new StubElement('body'),
    documentElement: new StubElement('html'),
    activeElement: null,
    hidden: false,
    readyState: 'complete',
  };
}

function recapCaseOptions({ sessionKey = 'session-a', chatActive = true } = {}) {
  const documentStub = createDocumentStub();
  const inputContainer = new StubElement('div', 'user-input-container');
  inputContainer.id = 'user-input-container';
  documentStub.elements.set('user-input-container', inputContainer);
  const fetchCalls = [];
  const host = {
    sessionKey,
    chatActive,
    agentId: 'agent-a',
    workspaceSessionId: 'ws-session-a',
  };

  return {
    documentStub,
    inputContainer,
    fetchCalls,
    host,
    options: {
      classic: (sandbox) => {
        sandbox.loadSource('public/src/modules/kernel-state.js');
        // persistent-input 已迁 ESM（P4 输入面批次）：用例体里 c.load，桥键
        // （_ensureInputMetaBar / _cleanupInputMetaBar）随其模块相注册。
        // classic 宿主面（生产由 app-main / app-ui / app-core 提供）
        sandbox._getSessionInputCacheKey = () => host.sessionKey;
        sandbox.isChatSurfaceActive = () => host.chatActive;
        sandbox.isRuntimeCalling = () => false;
        sandbox.getCurrentAgentRecord = () => ({ id: host.agentId });
        sandbox.getActiveWorkspaceSessionId = () => host.workspaceSessionId;
      },
      globals: {
        document: documentStub,
        ClawFW: { actions: { registerMany() {} }, SseClient: null },
        fetch: async (url) => { fetchCalls.push(String(url)); return { ok: true, json: async () => ({}) }; },
        // 输入面静态图的 classic 宿主工厂（生产由 app-core / app-main 提供）。
        // 本用例只用 _ensureInputMetaBar / _cleanupInputMetaBar，两个能力不触达这些 seam。
        createSessionViewCommitHost: () => ({}),
        createP2BootstrapCallActivityHost: () => ({}),
        createP2BootstrapDomHost: () => ({}),
        createPollCoordinatorHost: () => ({}),
      },
    },
  };
}

test('recap 策略不变：RECAP_DISABLED 断开触发链路，且不发 recap 请求', async () => {
  const { options, fetchCalls } = recapCaseOptions();
  await withP2EsmCase(options, async (c) => {
    // 输入面 meta bar 助手（persistent-input 的桥键）先于 recap 渲染就位
    await c.load('public/src/modules/persistent-input.js');
    const recap = await c.load(RECAP);
    assert.equal(recap.RECAP_DISABLED, true, '临时禁用策略必须原样保留');

    // 把「有对话、在 chat surface、会话键存在」全部备好——只剩 RECAP_DISABLED 拦住
    const sessionStorage = await c.load('public/src/modules/session-view-storage.js');
    sessionStorage.setCurrentMessages([{ role: 'user' }, { role: 'assistant' }]);
    const state = await c.load(RECAP_STATE);
    state.recapLastSeenBySession['session-a'] = Date.now() - 6 * 60 * 1000;

    assert.equal(await recap._maybeFetchRecap(), undefined);
    assert.deepEqual(fetchCalls, [], '禁用状态下不得发出 recap 请求');
    assert.equal(state.recapFetchInFlight, false);
    assert.equal(state.recapPendingTrigger, false);

    // 轮询里的 presence 跟踪同样整段跳过：lastSeen 保持调用前的值（不被刷新成 now）
    const lastSeenBefore = state.recapLastSeenBySession['session-a'];
    const nowBefore = Date.now();
    recap._trackRecapSessionPresence();
    assert.equal(state.recapLastSeenBySession['session-a'], lastSeenBefore,
      'disabled 状态下不得把 lastSeen 刷新为本次 tick');
    assert.ok(lastSeenBefore < nowBefore + 1, 'lastSeen 仍是上次留下的旧时间戳');
    assert.deepEqual(fetchCalls, []);
  });
});

test('recap 状态 owner：桥面访问器与活绑定双向一致', async () => {
  const { options } = recapCaseOptions();
  await withP2EsmCase(options, async (c) => {
    // 输入面 meta bar 助手（persistent-input 的桥键）先于 recap 渲染就位
    await c.load('public/src/modules/persistent-input.js');
    const recap = await c.load(RECAP);
    const state = await c.load(RECAP_STATE);

    // 注册在 ESM 相：本域在 classic 相没有触达点（首屏只走 hidden 分支）
    // _currentRecapText 桥已注销（agent-data-loader 改 import 本模块 API）；
    // _recapPendingTrigger 仍有 classic 消费方（runtime-status），保留访问器。
    assert.equal(c.read('typeof _currentRecapText'), 'undefined');
    assert.equal(c.read('Object.prototype.propertyIsEnumerable.call(window, "_recapPendingTrigger")'), false);
    assert.equal(typeof c.window._recapPendingTrigger, 'boolean');

    // classic 写方（runtime-status 的补触发）→ owner
    c.read('_recapPendingTrigger = true;');
    assert.equal(state.recapPendingTrigger, true);

    // owner → classic 裸读（runtime-status 在 call.finish 帧读 _recapPendingTrigger）
    state.setCurrentRecapText('from-owner');
    state.setRecapPendingTrigger(false);
    assert.equal(state.currentRecapText, 'from-owner');
    assert.equal(c.read('_recapPendingTrigger'), false);

    // 同一实现挂桥：compat 面与命名导出同址
    assert.equal(c.window._maybeFetchRecap, recap._maybeFetchRecap);
    assert.equal(c.window._renderRecapHint, recap._renderRecapHint);
    assert.equal(c.window._clearRecapForNewMessage, recap._clearRecapForNewMessage);
    assert.equal(c.window._trackRecapSessionPresence, recap._trackRecapSessionPresence);
  });
});

test('recap 语义 clear：清文本与挂起意图，只遗忘当前会话的记账', async () => {
  const { options } = recapCaseOptions({ sessionKey: 'session-a' });
  await withP2EsmCase(options, async (c) => {
    // 输入面 meta bar 助手（persistent-input 的桥键）先于 recap 渲染就位
    await c.load('public/src/modules/persistent-input.js');
    const recap = await c.load(RECAP);
    const state = await c.load(RECAP_STATE);

    state.setCurrentRecapText('old recap');
    state.setRecapPendingTrigger(true);
    state.recapShownForSession.add('session-a');
    state.recapShownForSession.add('session-b');
    state.recapDismissedForSession.add('session-a');

    recap._clearRecapForNewMessage();

    assert.equal(state.currentRecapText, '');
    assert.equal(state.recapPendingTrigger, false, '新消息提交同时清掉「忙完再触发」的挂起意图');
    assert.equal(state.currentRecapText, '', 'clear 后文本归零（桥已注销，摘要文本只经模块 API 读取）');
    assert.equal(c.read('_recapPendingTrigger'), false);
    assert.equal(state.recapShownForSession.has('session-a'), false);
    assert.equal(state.recapDismissedForSession.has('session-a'), false);
    assert.equal(state.recapShownForSession.has('session-b'), true, '其他会话的记账不受影响');

    // 私有 helper 不上桥：只做命名导出（各消费方在自己域内调用）
    assert.equal(typeof recap._getRecapAgentAndSession, 'function');
    assert.equal(c.read('typeof _getRecapAgentAndSession'), 'undefined');
    assert.equal(c.read('typeof _dismissRecap'), 'undefined');
  });
});

test('recap 渲染面：有摘要文本时挂到 meta bar，dismiss 后移除', async () => {
  const { options, inputContainer } = recapCaseOptions({ sessionKey: 'session-a', chatActive: true });
  await withP2EsmCase(options, async (c) => {
    // 输入面 meta bar 助手（persistent-input 的桥键）先于 recap 渲染就位
    await c.load('public/src/modules/persistent-input.js');
    const recap = await c.load(RECAP);
    const state = await c.load(RECAP_STATE);

    // 无文本：不渲染
    recap._renderRecapHint();
    assert.equal(inputContainer.querySelector('.input-meta-bar'), null);

    // 有文本：渲染到 meta bar（meta bar 由 classic _ensureInputMetaBar 建）
    state.setCurrentRecapText('<b>summary</b>');
    recap._renderRecapHint();
    const bar = inputContainer.querySelector('.input-meta-bar');
    assert.ok(bar, '应有 meta bar 承载 recap 提示');
    const hint = bar.querySelector('.recap-hint');
    assert.ok(hint, '应有 recap 提示节点');
    assert.match(hint.innerHTML, /&lt;b&gt;summary&lt;\/b&gt;/, '摘要文本必须按 HTML 转义');
    assert.match(hint.innerHTML, /data-action="recap\.dismiss"/);

    // 同一文本重复渲染是属性级更新，不重建节点
    recap._renderRecapHint();
    assert.equal(bar.querySelectorAll('.recap-hint').length, 1);

    // dismiss：清文本 + 记账当前会话 + 移除节点
    recap._dismissRecap();
    assert.equal(state.currentRecapText, '');
    assert.equal(state.recapDismissedForSession.has('session-a'), true);
    assert.equal(inputContainer.querySelector('.recap-hint'), null);

    // 会话切走（chat surface 不再活跃）时也不残留
    state.setCurrentRecapText('another');
    state.recapDismissedForSession.delete('session-a');
    recap._renderRecapHint();
    assert.ok(inputContainer.querySelector('.recap-hint'));
    c.read('isChatSurfaceActive = () => false');
    recap._renderRecapHint();
    assert.equal(inputContainer.querySelector('.recap-hint'), null);
  });
});
