/**
 * debug-preflight 的跨文件入口边界：loadPreflight 为零消费模块私有实现，
 * 不上 window 桥；面板渲染入口 renderPreflightPanel 仍以桥服务 app-ui 的
 * registerFeaturePanel('preflight') 闭包。
 *
 * 为什么删掉原来的「window.loadPreflight 发布归属」断言：HEAD 的唯一调用点
 * （预检面板自身的渲染路径 `window.loadPreflight()`）在转 ESM 后改为直接调用
 * 模块内函数，app-ui 的重复发布也已删除，全仓再无生产消费方——按迁移配方
 * 步 5 第 3 类（零消费面 → 键收敛为模块私有，不注册、不上桥），生产桥不应
 * 为测试而保留。
 *
 * 装载路线（P2 真实 ESM 图）：classic 相按真实加载序跑 action-dispatcher →
 * i18n → app-core → session-view-state → markdown-bootstrap（debug-preflight
 * 依赖它们的 KernelState 初值与 escapeHtml），debug-preflight 经 `c.load` 真实
 * import。断言改为真实行为面：
 *   1. 零消费键不挂 window，同时命名导出仍在（模块私有 + 导出供后续 import）；
 *   2. app-ui 既不发布也不转调 loadPreflight；
 *   3. 装载不发起预检请求，首渲染（走 classic 消费方的桥访问器路径）落空态并
 *      同步触发恰好一次 POST /protoclaw/preflight。
 *
 * 断言口径（如实）：PREFLIGHT_STATE 是模块私有，不再能从 classic 沙箱直读
 * `data` / `loading`；改由「装载零请求 + 首次渲染落空态并同步触发恰好一次请求」
 * 证明同一组事实（若装载后 loading 仍为真或已有数据，首渲染就不会走空态分支，
 * 请求也不会发生）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Renderer } from 'marked';
import { withP2EsmCase } from './helpers/p2-esm-case.js';

const APP_UI_SOURCE = readFileSync(new URL('../public/src/app-ui.js', import.meta.url), 'utf8');
const DEBUG_PREFLIGHT = 'public/src/modules/debug-preflight.js';

/** vendor 桩：markdown-bootstrap 只在装载期需要 Renderer 与 setOptions。 */
const markedStub = { Renderer, setOptions() {} };

function loadClassicBootstrap(sandbox) {
  sandbox.marked = markedStub;
  sandbox.window.marked = markedStub;
  sandbox.loadSource('public/src/modules/action-dispatcher.js');
  // i18n 已迁 ESM（P4）：t 桥键由 createFrontendSandbox 自动装载，见 test/helpers/install-i18n.js
  sandbox.loadSource('public/src/app-core.js');
  sandbox.loadSource('public/src/modules/session-view-state.js');
  sandbox.loadSource('public/src/modules/markdown-bootstrap.js');
}

function createFetchStub() {
  const calls = [];
  const stub = async (url, options) => {
    calls.push({ url: String(url), options });
    return { ok: false, status: 0, json: async () => ({}) };
  };
  stub.calls = calls;
  return stub;
}

/** 非预期 warn/error 捕获：装载相不该有诊断输出。 */
function captureConsoleNoise() {
  const entries = [];
  const original = { warn: console.warn, error: console.error };
  const record = (level) => (...args) => {
    entries.push(`${level}: ${args.map((value) => (value instanceof Error ? value.message : String(value))).join(' ')}`);
  };
  console.warn = record('warn');
  console.error = record('error');
  return {
    assertClean(label) {
      assert.deepEqual(entries, [], `${label} 不得出现 warn/error 输出：\n${entries.join('\n')}`);
    },
    restore() {
      console.warn = original.warn;
      console.error = original.error;
    },
  };
}

async function withCleanConsole(label, fn) {
  const noise = captureConsoleNoise();
  try {
    const result = await fn();
    noise.assertClean(label);
    return result;
  } finally {
    noise.restore();
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('loadPreflight 是零消费模块私有实现：不挂 window，命名导出保留', async () => {
  await withCleanConsole('零消费键', async () => {
    const fetchStub = createFetchStub();
    await withP2EsmCase(
      { classic: loadClassicBootstrap, globals: { fetch: fetchStub } },
      async (c) => {
        const preflight = await c.load(DEBUG_PREFLIGHT);
        // 模块私有 + 命名导出（后续消费方 import，不经 window）
        assert.equal(typeof preflight.loadPreflight, 'function');
        // 生产桥已撤：window 无该键，classic 裸标识符也解析不到
        assert.equal('loadPreflight' in c.window, false);
        assert.equal(c.read('typeof loadPreflight'), 'undefined');
      },
    );
  });
});

test('app-ui 不发布也不转调 loadPreflight', () => {
  assert.equal(/window\.loadPreflight\s*=/.test(APP_UI_SOURCE), false);
  assert.equal(/[^.\w]loadPreflight\s*\(/.test(APP_UI_SOURCE), false);
});

test('装载 debug-preflight 不发起预检请求：首渲染（classic 消费方路径）才取数', async () => {
  await withCleanConsole('首屏不触达', async () => {
    const fetchStub = createFetchStub();
    await withP2EsmCase(
      { classic: loadClassicBootstrap, globals: { fetch: fetchStub } },
      async (c) => {
        await c.load(DEBUG_PREFLIGHT);
        assert.deepEqual(fetchStub.calls, [], '装载模块不得发起预检请求');

        // 空态渲染（data 为空、loading 未在进行）→ 同步触发一次取数。
        // 走 app-ui 面板注册闭包的同一条路：classic 裸标识符经桥访问器取到实现。
        const html = c.read('renderPreflightPanel()');
        assert.match(html, /feature-panel-empty/);
        await tick();
        assert.deepEqual(fetchStub.calls.map((call) => call.url), ['/protoclaw/preflight']);
      },
    );
  });
});
