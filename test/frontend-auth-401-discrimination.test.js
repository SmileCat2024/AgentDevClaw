/**
 * auth-client 的 401 甄别契约（isAuthLayerUnauthorized / fetch 拦截）。
 *
 * 历史事故：业务路由 model_catalog/codex 用 401 表达「上游 Codex 账号未登录」，
 * 全局 fetch 拦截器把一切 401 当成「访问保护会话过期」弹出登录浮层——用户
 * 打开 Codex 设置页就要求输入 Claw 密码。修复分两层：服务端业务错误不再用
 * 401（model-config.js），前端只认认证层 401 响应体的 code:'AUTH_REQUIRED'。
 * 本文件钉前端这一层：三类 401 各自的正确归宿，以及拦截器读体不消费原响应流。
 *
 * 装载路线与 frontend-auth-client-bridge.test.js 相同：真实 import + 桩 window。
 * 观察点是 document.body.appendChild 收到的浮层元素（id 'claw-auth-overlay'）。
 */
/* global window */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserStubs, loadModuleOnce } from './helpers/esm-module-loader.js';

function createActionsStub() {
  const registered = new Map();
  return {
    registered,
    register(name, fn) { registered.set(name, fn); },
    registerMany(map) { for (const [name, fn] of Object.entries(map)) registered.set(name, fn); },
    unregisterOwner() { return 0; },
  };
}

/** JSON 响应桩：clone() 返回等价副本，供拦截器读体而不动原响应。 */
function jsonResponse(status, body) {
  const raw = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(raw),
    text: async () => raw,
    clone: () => jsonResponse(status, body),
  };
}

/** 非 JSON 体响应桩：json() 拒绝（模拟漏到网关其他服务的 HTML 401 等）。 */
function nonJsonResponse(status, raw) {
  return {
    ok: false,
    status,
    json: async () => { throw new Error('not JSON'); },
    text: async () => raw,
    clone: () => nonJsonResponse(status, raw),
  };
}

/**
 * 路由化 fetch 桩：按 URL 前缀分发。/protoclaw/auth/status 固定返回
 * enabled+authenticated（会话有效、保护开启——浮层唯一剩下的触发条件）。
 */
function createRouteFetch(routes) {
  return async (input) => {
    const url = typeof input === 'string' ? input : input?.url || '';
    if (url.startsWith('/protoclaw/auth/status')) {
      return jsonResponse(200, { enabled: true, configured: true, authenticated: true });
    }
    for (const [prefix, respond] of Object.entries(routes)) {
      if (url.startsWith(prefix)) return respond(url);
    }
    throw new Error('test fetch stub: unexpected url ' + url);
  };
}

/** 可观测 document 桩：createElement 的元素 querySelector 返回表单桩，
 * body.appendChild 记录浮层挂载（showLogin 的可观察副作用）。 */
function createObservingDocument() {
  const appended = [];
  const formEl = {
    addEventListener() {}, removeEventListener() {},
    textContent: '', value: '', disabled: false, innerHTML: '',
    style: {}, dataset: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    querySelector: () => null, querySelectorAll: () => [],
    focus() {}, select() {},
  };
  const makeEl = () => ({
    id: '', innerHTML: '', textContent: '', dataset: {}, children: [], style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    addEventListener() {}, removeEventListener() {},
    appendChild() {}, removeChild() {}, remove() {},
    // showLogin 装浮层后立即查 form/error/password 三个节点并挂 submit 监听
    querySelector: (sel) => (String(sel).startsWith('#claw-auth-') ? formEl : null),
    querySelectorAll: () => [],
    focus() {},
  });
  return {
    appended,
    document: {
      createElement: () => makeEl(),
      createTextNode: (text) => ({ textContent: text }),
      body: { appendChild(el) { appended.push(el); }, removeChild() {} },
    },
  };
}

async function loadAuthClient(fetchStub, documentOverrides) {
  const cleanup = installBrowserStubs({
    window: {
      fetch: fetchStub,
      ClawFW: { actions: createActionsStub() },
      KernelState: undefined,
    },
    document: documentOverrides,
  });
  try {
    await loadModuleOnce('public/src/modules/kernel-state.js', { installGlobals: false });
    const { module } = await loadModuleOnce('public/src/modules/auth-client.js', { installGlobals: false });
    await module.authReady; // initialize() 完成，会话有效、无浮层
    return { module, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('业务 401（无 AUTH_REQUIRED 标记）不弹登录浮层——历史事故形态', async () => {
  const observing = createObservingDocument();
  const { cleanup } = await loadAuthClient(
    createRouteFetch({
      // 服务端已改 400；保留 401 形态作为前端甄别的回归防线（防服务端回归或
      // 其他路由再犯同类误用时前端跟着误弹）
      '/protoclaw/model_catalog/': () => jsonResponse(401, { error: 'No Codex account is logged in' }),
    }),
    observing.document,
  );
  try {
    await window.fetch('/protoclaw/model_catalog/codex', { method: 'POST' });
    await flush();
    assert.equal(observing.appended.filter((el) => el.id === 'claw-auth-overlay').length, 0,
      '上游账号未登录的业务 401 不得触发登录浮层');
  } finally {
    cleanup();
  }
});

test('认证层 401（code:AUTH_REQUIRED）触发登录浮层，且原响应流不被消费', async () => {
  const observing = createObservingDocument();
  const { cleanup } = await loadAuthClient(
    createRouteFetch({
      '/api/agents': () => jsonResponse(401, { ok: false, error: 'Authentication required', code: 'AUTH_REQUIRED' }),
    }),
    observing.document,
  );
  try {
    const response = await window.fetch('/api/agents/list');
    await flush();
    assert.equal(observing.appended.filter((el) => el.id === 'claw-auth-overlay').length, 1,
      '会话过期的认证层 401 必须弹登录浮层');
    // clone 读体不得消费原响应：调用方照常拿到 JSON
    const body = await response.json();
    assert.equal(body.code, 'AUTH_REQUIRED');
  } finally {
    cleanup();
  }
});

test('非 JSON 体的 401（漏到网关其他服务等）不弹登录浮层', async () => {
  const observing = createObservingDocument();
  const { cleanup } = await loadAuthClient(
    createRouteFetch({
      '/api/agents': () => nonJsonResponse(401, '<html>401 Unauthorized</html>'),
    }),
    observing.document,
  );
  try {
    await window.fetch('/api/agents/list');
    await flush();
    assert.equal(observing.appended.filter((el) => el.id === 'claw-auth-overlay').length, 0,
      '读不出 AUTH_REQUIRED 标记的 401 按业务错误处理');
  } finally {
    cleanup();
  }
});

test('登录接口自身的 401（AUTH_INVALID_CREDENTIALS）不弹浮层', async () => {
  const observing = createObservingDocument();
  const fetchStub = async (input) => {
    const url = typeof input === 'string' ? input : input?.url || '';
    if (url.startsWith('/protoclaw/auth/status')) {
      return jsonResponse(200, { enabled: true, configured: true, authenticated: true });
    }
    if (url.startsWith('/protoclaw/auth/login')) {
      return jsonResponse(401, { ok: false, error: 'Invalid password', code: 'AUTH_INVALID_CREDENTIALS' });
    }
    throw new Error('unexpected url ' + url);
  };
  const { cleanup } = await loadAuthClient(fetchStub, observing.document);
  try {
    await window.fetch('/protoclaw/auth/login', { method: 'POST', body: '{}' });
    await flush();
    assert.equal(observing.appended.filter((el) => el.id === 'claw-auth-overlay').length, 0,
      '密码错误是登录流程内错误（表单内呈现），不是会话过期');
  } finally {
    cleanup();
  }
});
