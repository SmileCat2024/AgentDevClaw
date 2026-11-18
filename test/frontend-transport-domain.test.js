/**
 * 传输域（modules/transport.js，P4 T1 从 app-core 抽出）契约测试。
 *
 * 钉三件事：
 *   1. fetch 分流补丁：http(s) 页面直通同源；非 HTTP（桌面壳）把 /api/* 指到
 *      ViewerWorker 基址。补丁是页面级基础设施，语义必须与迁移前一致。
 *   2. invoke 既有 classic 消费方（app-main / 悬置域 wg-*）的桥键，也有 ESM 消费
 *      方（具名 import）。函数键经域状态转发：模块装载前的 classic 实现被吸收，
 *      认领后的 classic 写方对两条调用路径同样生效。
 *   3. createViewerReadinessHost 的窄宿主面（application-startup 域装载期取用）。
 *
 * 装载路线：真实 import（esm-module-loader）。每例一份全新 window 桩 + 全新
 * KernelState + 全新 transport 实例（唯一 query 绕模块缓存），互不残留。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserStubs, loadModuleOnce } from './helpers/esm-module-loader.js';

const KERNEL_STATE = 'public/src/modules/kernel-state.js';
const TRANSPORT = 'public/src/modules/transport.js';

/** 装上 window 桩 + 真实 KernelState，返回 transport 模块实例。 */
async function loadTransport({ window: windowOverrides = {} } = {}) {
  const cleanup = installBrowserStubs({ window: windowOverrides });
  try {
    await loadModuleOnce(KERNEL_STATE, { installGlobals: false });
    const { module } = await loadModuleOnce(TRANSPORT, { installGlobals: false });
    return { module, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

test('fetch 分流：http(s) 页面直通同源 fetch（不重写 URL）', async () => {
  const calls = [];
  const nativeFetch = async (input, init) => { calls.push({ input, init }); return { ok: true }; };
  const { module, cleanup } = await loadTransport({ window: { fetch: nativeFetch } });
  try {
    assert.equal(typeof module.invoke, 'function');
    const init = { method: 'POST' };
    await window.fetch('/api/agents', init);
    assert.deepEqual(calls, [{ input: '/api/agents', init }]);
  } finally {
    cleanup();
  }
});

test('fetch 分流：非 HTTP 壳把 /api/* 指到 ViewerWorker 基址（字符串与 Request 两种形态）', async () => {
  const calls = [];
  const nativeFetch = async (input) => { calls.push(String(input && input.url ? input.url : input)); return { ok: true }; };
  const { cleanup } = await loadTransport({
    window: {
      fetch: nativeFetch,
      location: { protocol: 'tauri:', href: 'tauri://localhost/', pathname: '/', search: '' },
    },
  });
  try {
    await window.fetch('/api/agents');
    assert.deepEqual(calls, ['http://127.0.0.1:2026/api/agents']);
    // 非 /api/ 路径原样直通
    await window.fetch('/protoclaw/agents');
    assert.deepEqual(calls.at(-1), '/protoclaw/agents');
  } finally {
    cleanup();
  }
});

test('invoke 桥键：装载前的 classic 实现被吸收，认领后的 classic 写方对 import 侧同样生效', async () => {
  const calls = [];
  const classicInvoke = async (command) => { calls.push(['classic', command]); return { from: 'classic' }; };
  const { module, cleanup } = await loadTransport({ window: { invoke: classicInvoke } });
  try {
    // 吸收：模块接管的是 classic 相已经装好的实现（不是把它顶掉）
    assert.equal(window.invoke, classicInvoke, '桥键读回 classic 实现');
    assert.deepEqual(await module.invoke('get_agents_status'), { from: 'classic' });

    // 认领后的 classic 写方（诊断面 / 壳层替换）→ setter 进域状态 → import 侧跟随
    const replaced = async (command) => { calls.push(['replaced', command]); return { from: 'replaced' }; };
    window.invoke = replaced;
    assert.equal(window.invoke, replaced);
    assert.deepEqual(await module.invoke('get_prebuilt_agents'), { from: 'replaced' });
    assert.deepEqual(calls, [
      ['classic', 'get_agents_status'],
      ['replaced', 'get_prebuilt_agents'],
    ]);
  } finally {
    cleanup();
  }
});

test('createViewerReadinessHost：窄宿主面（now / fetch / url / wait）指向同一个 fetch 接缝', async () => {
  const calls = [];
  const nativeFetch = async (input) => { calls.push(String(input)); return { ok: true }; };
  const { module, cleanup } = await loadTransport({ window: { fetch: nativeFetch } });
  try {
    const host = module.createViewerReadinessHost();
    assert.equal(host.url(), '/api/agents', 'http 页面走同源 Viewer 代理');
    assert.equal(typeof host.now(), 'number');
    await host.fetch('/api/agents');
    assert.deepEqual(calls, ['/api/agents']);
    // wait 只包一个 setTimeout：验证有返回且可 await（不引入 ready/promise 面）
    await host.wait(0);
    assert.deepEqual(calls, ['/api/agents'], '宿主取用的是补丁背后的 native fetch（不递归）');
  } finally {
    cleanup();
  }
});
