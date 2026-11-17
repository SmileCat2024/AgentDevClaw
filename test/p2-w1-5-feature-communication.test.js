/**
 * feature-communication（Feature 通道订阅 / 请求宿主适配）真实行为测试 ——
 * P2 第 1 波批次 5。
 *
 * 协议面不可重设计：四元组寻址校验、SSE 订阅事件分发、closed 语义、请求面
 * POST 形状与错误结构化（code / status）全部沿用迁移前语义。ESM 化只把实现
 * 从 IIFE 改为命名导出，`window.ClawFeatureCommunication` 保留为既有公开
 * 命名空间（bg-panel / input-model-switcher 仍在 classic 侧运行时取用）。
 *
 * EventSource / fetch 以全局桩注入（模块内为浏览器全局裸标识符）。
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserStubs, loadModuleOnce } from './helpers/esm-module-loader.js';

const MODULE_PATH = 'public/src/modules/feature-communication.js';
const TARGET = { agentId: 'programming-helper', sessionId: 'sess-1', featureId: 'shell', channelId: 'task-1' };

const pendingCleanups = [];
after(() => {
  while (pendingCleanups.length > 0) pendingCleanups.pop()();
});

class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.closed = false;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  close() { this.closed = true; }

  emit(type, payload, lastEventId = '') {
    for (const listener of this.listeners.get(type) || []) {
      listener({ type, data: payload === undefined ? '' : JSON.stringify(payload), lastEventId });
    }
  }
}
FakeEventSource.instances = [];

/** 装全局桩（window / EventSource / fetch）并加载一份全新模块实例。 */
async function loadModule({ window: windowOverrides = {}, fetch: fetchOverride } = {}) {
  const requests = [];
  const cleanupStubs = installBrowserStubs({ window: windowOverrides });
  FakeEventSource.instances.length = 0;
  const restores = [];
  const install = (key, value) => {
    const had = Object.hasOwn(globalThis, key);
    const prev = globalThis[key];
    globalThis[key] = value;
    restores.push(() => { if (had) globalThis[key] = prev; else delete globalThis[key]; });
  };
  install('EventSource', FakeEventSource);
  install('fetch', fetchOverride || (async (url, options = {}) => {
    requests.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ ok: true, channels: [], result: null }) };
  }));
  pendingCleanups.push(() => { restores.forEach((restore) => restore()); cleanupStubs(); });
  const { module } = await loadModuleOnce(MODULE_PATH, { installGlobals: false });
  return { module, requests };
}

describe('feature-communication：listChannels', () => {
  it('queries the channels endpoint with encoded addressing and returns the list', async () => {
    const { module, requests } = await loadModule({
      fetch: async (url) => {
        requests.push({ url });
        return { ok: true, status: 200, json: async () => ({ ok: true, channels: [{ featureId: 'shell', channelId: 'task-1' }] }) };
      },
    });
    const channels = await module.listChannels('programming-helper', 'sess/1');
    assert.equal(requests[0].url,
      '/protoclaw/feature-comms/channels?agentId=programming-helper&sessionId=sess%2F1');
    assert.deepEqual(channels, [{ featureId: 'shell', channelId: 'task-1' }]);
  });

  it('surfaces the structured error code and HTTP status', async () => {
    const { module } = await loadModule({
      fetch: async () => ({ ok: false, status: 404, json: async () => ({ ok: false, code: 'not_mounted' }) }),
    });
    await assert.rejects(module.listChannels('a', 'b'), (error) => {
      assert.equal(error.message, 'not_mounted');
      assert.equal(error.code, 'not_mounted');
      assert.equal(error.status, 404);
      return true;
    });
  });
});

describe('feature-communication：subscribe', () => {
  it('subscribes the four channel event types and forwards snapshot / event payloads', async () => {
    const { module } = await loadModule();
    const seen = [];
    const unsubscribe = module.subscribe(TARGET, {
      snapshot: (data, id) => seen.push(['snapshot', data, id]),
      event: (data, id) => seen.push(['event', data, id]),
      eventType: (type, data) => seen.push(['eventType', type, data]),
      error: () => seen.push(['error']),
    });

    const source = FakeEventSource.instances[0];
    assert.equal(source.url,
      '/protoclaw/feature-comms/stream?agentId=programming-helper&sessionId=sess-1&featureId=shell&channelId=task-1');
    assert.deepEqual([...source.listeners.keys()], ['snapshot', 'resync', 'event', 'closed']);

    source.emit('snapshot', { tasks: [] }, '1');
    source.emit('event', { type: 'task.updated', data: { id: 't1' } }, '2');
    assert.deepEqual(seen, [
      ['snapshot', { tasks: [] }, '1'],
      ['eventType', 'task.updated', { id: 't1' }],
      ['event', { id: 't1' }, '2'],
    ]);

    unsubscribe();
    assert.equal(source.closed, true);
  });

  it('closes the stream and notifies on the closed event; malformed payloads are ignored', async () => {
    const { module } = await loadModule();
    let closed = 0;
    module.subscribe(TARGET, { closed: () => { closed += 1; }, snapshot: () => { throw new Error('must not run'); } });
    const source = FakeEventSource.instances[0];

    // 非 JSON 载荷静默丢弃，不打断订阅
    for (const listener of source.listeners.get('snapshot')) listener({ type: 'snapshot', data: 'not-json' });
    source.emit('closed');
    assert.equal(source.closed, true);
    assert.equal(closed, 1);
  });

  it('maps the stream url through the app base-path provider when present', async () => {
    const { module } = await loadModule({
      window: { __PROTOCLAW_APP_URL__: (url) => `/proxy?to=${encodeURIComponent(url)}` },
    });
    module.subscribe(TARGET, {});
    assert.match(FakeEventSource.instances[0].url, /^\/proxy\?to=/);
  });

  it('rejects targets with a missing or blank addressing field before opening a stream', async () => {
    const { module } = await loadModule();
    assert.throws(() => module.subscribe({ ...TARGET, sessionId: '' }), (error) => {
      assert.ok(error instanceof TypeError);
      assert.equal(error.message, 'sessionId is required');
      return true;
    });
    assert.equal(FakeEventSource.instances.length, 0);
  });
});

describe('feature-communication：request', () => {
  it('posts the four-tuple target with requestType / payload and returns the result', async () => {
    const { module, requests } = await loadModule({
      fetch: async (url, options) => {
        requests.push({ url, options });
        return { ok: true, status: 200, json: async () => ({ ok: true, result: { status: 'running' } }) };
      },
    });
    const result = await module.request(TARGET, 'getStatus', { id: 't1' });
    assert.equal(requests[0].url, '/protoclaw/feature-comms/request');
    assert.equal(requests[0].options.method, 'POST');
    assert.deepEqual(JSON.parse(requests[0].options.body), {
      ...TARGET, requestType: 'getStatus', payload: { id: 't1' },
    });
    assert.deepEqual(result, { status: 'running' });
  });

  it('throws the structured error when the runtime rejects the request', async () => {
    const { module } = await loadModule({
      fetch: async () => ({ ok: false, status: 409, json: async () => ({ ok: false, error: 'channel gone', code: 'closed' }) }),
    });
    await assert.rejects(module.request(TARGET, 'kill', {}), (error) => {
      assert.equal(error.message, 'channel gone');
      assert.equal(error.code, 'closed');
      assert.equal(error.status, 409);
      return true;
    });
  });
});

describe('feature-communication：ESM 兼容面', () => {
  it('keeps window.ClawFeatureCommunication pointing at the exported namespace', async () => {
    const { module } = await loadModule();
    assert.equal(globalThis.window.ClawFeatureCommunication, module.ClawFeatureCommunication);
    assert.equal(module.ClawFeatureCommunication.listChannels, module.listChannels);
    assert.equal(module.ClawFeatureCommunication.subscribe, module.subscribe);
    assert.equal(module.ClawFeatureCommunication.request, module.request);
  });
});
