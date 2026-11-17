/**
 * P2 输入 / 提示 / loader 消费方批次：真实整图求值与新增静态环的时序证据。
 *
 * 本批把若干「已迁 ESM 的消费方仍经 window 调用已迁生产者」改成具名 import，
 * 其中两处新增静态环（环成立的前提是环内两侧都只在函数体内调用对端绑定）：
 *   1. `p2-w2-3a-queue-projection ↔ sse-client`：投影读传输层状态，传输层把
 *      排队快照交回投影落气泡；
 *   2. `agent-loader-host → project-data`：agent-loader-host 具名取
 *      getPhSessionOwnershipParams，闭合
 *      agent-loader-host → project-data → session-ui →
 *      agent-snapshot-loader-host → session-data-loader-host → agent-loader-host
 *      这一圈。环闭合并发成立的前提：环内各 host 的**顶层读取**一律惰性转调
 *      （agent-loader-host / agent-snapshot-loader-host / session-data-loader-host
 *      三处都是 `(...args) => fn(...args)`，不把尚未初始化的绑定直接放成函数值）；
 *   3. `sidebar-operations → project-data`（updateAgentRecord）与
 *      `ctx-menu-items → project-data`（updateAgentRecord / getPathLeaf）：
 *      同一条边的其余消费方，均只在函数体内调用。
 *
 * 本文件不复刻业务逻辑，只证明图本身：以生产入口 `kernel-entry.js`
 * （→ `p2-entry.js` → 各批次入口）求值整张真实图，再逐个以环内成员为入口
 * 单独求值，确认换入口不改变可求值性（环内顶层零解引用 → 无 TDZ）。
 *
 * classic 相用 `prepareClassicSandbox`（index.html 的先行脚本序）提供真实宿主
 * 工厂；ESM 相全部走 `c.load` 的真实 import。三个 Observer 是浏览器平台全局
 * （Node 没有），按最小语义补上，不参与任何断言。
 *
 * 噪音纪律（不能"有输出但只有零断言"地绿）：装载即发起的两个请求按**真实端点
 * 契约形状**应答——`/api/feature-ui/declarations` → `{ ok, declarations,
 * warnings }`（feature-ui-registry 装载即 refresh，`ok` 缺失会 console.error），
 * `/protoclaw/app_info` → `{ ok, version, … }`；未登记端点直接断言失败。每个
 * 用例结束都断言无任何 console.warn / console.error 输出。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';

const KERNEL_ENTRY = 'public/src/modules/kernel-entry.js';
const QUEUE_PROJECTION = 'public/src/modules/p2-w2-3a-queue-projection.js';
const SSE_CLIENT = 'public/src/modules/sse-client.js';
const AGENT_LOADER_HOST = 'public/src/modules/agent-loader-host.js';
const AGENT_SNAPSHOT_HOST = 'public/src/modules/agent-snapshot-loader-host.js';
const SESSION_DATA_HOST = 'public/src/modules/session-data-loader-host.js';
const AGENT_DATA_LOADER = 'public/src/modules/agent-data-loader.js';
const PROJECT_DATA = 'public/src/modules/project-data.js';
const SIDEBAR_OPERATIONS = 'public/src/modules/sidebar-operations.js';
const CTX_MENU_ITEMS = 'public/src/modules/ctx-menu-items.js';
const AUTO_TITLE = 'public/src/modules/auto-title.js';
const SLASH_MENU = 'public/src/modules/slash-menu.js';

class NoopObserver {
  observe() {}

  unobserve() {}

  disconnect() {}

  takeRecords() { return []; }
}

/** 装载期会发出的真实端点（逐个按生产契约应答；未登记的端点即测试失败）。 */
const DECLARATIONS_API = '/api/feature-ui/declarations';
const APP_INFO_API = '/protoclaw/app_info';
/**
 * 装载期请求集合（精确相等）。P4 批次把 debug-panel-host / voice-input 并入
 * kernel-entry 图后新增三项，都是模块求值期的真实请求：rail 面板偏好拉取
 * （ui-prefs）与语音提示音预载（静态资产）。
 */
const EXPECTED_ENDPOINTS = [
  DECLARATIONS_API,
  APP_INFO_API,
  '/api/feature-ui/ui-prefs?agentId=home',
  '/sounds/voice-recording-start.mp3',
  '/sounds/voice-recording-stop.mp3',
];

const jsonResponse = (payload) => ({ ok: true, status: 200, json: async () => payload });

/**
 * 一个用例的整图 fixture：真实端点契约 + 噪音记录。
 * `console` 只吞普通输出，warn / error 一律记录并在用例结束时断言为空。
 */
function createGraphHarness() {
  const warnings = [];
  const errors = [];
  const endpoints = [];
  const fetchStub = async (url) => {
    const target = String(url);
    endpoints.push(target);
    if (target === DECLARATIONS_API) {
      // 生产契约（server/routes/feature-assets.js）：{ ok, declarations, warnings }
      return jsonResponse({ ok: true, declarations: [], warnings: [] });
    }
    if (target === APP_INFO_API) {
      // 生产契约（server/routes/agent-lifecycle.js）：{ ok, version, … }
      return jsonResponse({ ok: true, version: '0.0.0-graph-fixture', frameworkVersion: '0.0.0-graph-fixture' });
    }
    return jsonResponse({ ok: false, error: `unexpected endpoint: ${target}` });
  };
  return {
    warnings,
    errors,
    endpoints,
    options: {
      label: 'p2-input-loader-cycle-graph',
      classic: (sandbox) => {
        prepareClassicSandbox(sandbox);
      },
      globals: {
        fetch: fetchStub,
        MutationObserver: NoopObserver,
        ResizeObserver: NoopObserver,
        IntersectionObserver: NoopObserver,
        console: {
          ...console,
          log() {},
          info() {},
          debug() {},
          warn: (...args) => { warnings.push(args); },
          error: (...args) => { errors.push(args); },
        },
      },
    },
  };
}

/**
 * 整图用例统一收口：端点白名单 + 零 warn / 零 error。
 * `extraClassic` 在真实 classic 链之后追加本用例需要的 classic 文件（生产同源，
 * 不复制宿主契约）。
 */
async function withGraphCase(fn, { extraClassic = null } = {}) {
  const harness = createGraphHarness();
  if (typeof extraClassic === 'function') {
    const baseClassic = harness.options.classic;
    harness.options.classic = (sandbox) => {
      baseClassic(sandbox);
      extraClassic(sandbox);
    };
  }
  const result = await withP2EsmCase(harness.options, async (c) => {
    // 刷新引擎（P4 T3 起是真实 ESM）：交互域在**装载期**取它的窄宿主
    // createThreadStoreHost，必须先于 thread-store-domain 进同一张图。
    await c.load('public/src/modules/thread-store.js');
    return fn(c, harness);
  });
  const unexpected = harness.endpoints.filter((url) => !EXPECTED_ENDPOINTS.includes(url));
  assert.deepEqual(unexpected, [], '整图 fixture 不得命中未登记端点（契约形状必须按真实端点给出）');
  assert.deepEqual(harness.errors, [], '整图求值不得产生任何 console.error（含 fixture 契约不匹配的失败告警）');
  assert.deepEqual(harness.warnings, [], '整图求值不得产生任何 console.warn');
  return result;
}

test('生产入口整图求值：kernel-entry → p2-entry 下新增环与 import 消费方都可求值', async () => {
  await withGraphCase(async (c, harness) => {
    // 生产入口自身不导出任何东西；能求值即证明整张图（含两处新环）无 TDZ。
    const entry = await c.load(KERNEL_ENTRY);
    assert.deepEqual(Object.keys(entry), [], 'kernel-entry 是纯副作用入口');

    const queue = await c.load(QUEUE_PROJECTION);
    const sse = await c.load(SSE_CLIENT);
    const loaderHost = await c.load(AGENT_LOADER_HOST);
    const slash = await c.load(SLASH_MENU);
    // 环两侧的具名导出都在（与 c.load 同一实例：同一 case 图）
    assert.equal(typeof queue.applyQueuedInputsTexts, 'function');
    assert.equal(typeof queue.updateQueueIndicator, 'function');
    assert.equal(typeof sse.getLastQueuedSnapshot, 'function');
    assert.equal(typeof sse.reconcileQueuedTexts, 'function');
    assert.equal(typeof sse.isSseActive, 'function');
    assert.equal(typeof loaderHost.loadAgentDetail, 'function');
    // 惰性转调的宿主仍以函数形态暴露（环内先求值时不会被实例化成 undefined）
    const snapshotHost = await c.load(AGENT_SNAPSHOT_HOST);
    const sessionDataHost = await c.load(SESSION_DATA_HOST);
    assert.equal(typeof snapshotHost.loadAgents, 'function');
    assert.equal(typeof sessionDataHost.loadAgentData, 'function');
    // 环闭合后 project-data 的两个消费方导出仍在（同一图实例）
    const projectData = await c.load(PROJECT_DATA);
    assert.equal(typeof projectData.updateAgentRecord, 'function');
    assert.equal(typeof projectData.getPathLeaf, 'function');
    assert.equal(typeof slash.ClawSlash.submitWithPendingPrompts, 'function');
    // 传输层公开命名空间仍在（classic 消费方协议）
    assert.equal(c.window.ClawFW.SseClient.getLastQueuedSnapshot, sse.getLastQueuedSnapshot,
      'ClawFW.SseClient 命名空间指向真实模块导出');
    // fixture 契约被真正走到：装载即拉取的两个端点恰好是这两个（不多不少）
    assert.deepEqual([...new Set(harness.endpoints)].sort(), [...EXPECTED_ENDPOINTS].sort(),
      '装载期请求集合 = feature-ui declarations + app_info（按真实契约应答）');
  });
});

// 环内成员（含把 project-data 拉进环的四支 P1 host）逐个作为入口：谁先求值
// 都必须成立（环内两侧顶层不解引用对端绑定 → 无 TDZ）。
const RUNTIME_SWITCH_HOST = 'public/src/modules/runtime-switch-host.js';
const WORKSPACE_SURFACE_HOST = 'public/src/modules/workspace-surface-host.js';
const WORKSPACE_ENTRY_HOST = 'public/src/modules/workspace-entry-host.js';
const WORKSPACE_SESSION_NAV_HOST = 'public/src/modules/workspace-session-navigation-host.js';
// 18 节点 SCC（agent-loader-host → project-data 闭合后的整圈）的其余成员：
// 换谁先求值都不能踩到未初始化的绑定。ph-* 一侧（另一个 SCC，owner 在飞）不在此
// 列，避免本文件对别人的改动敏感。
const SCC_MEMBERS = [
  'assembly-actions',
  'assembly-data',
  'debug-summary-upload',
  'feature-config',
  'fw-config-panel',
  'runtime-status-loader-host',
  'session-ui',
  'template-engine',
  'workspace-blocks',
].map((name) => `public/src/modules/${name}.js`);

for (const entry of [
  SSE_CLIENT,
  QUEUE_PROJECTION,
  AGENT_LOADER_HOST,
  AGENT_SNAPSHOT_HOST,
  SESSION_DATA_HOST,
  AGENT_DATA_LOADER,
  PROJECT_DATA,
  SIDEBAR_OPERATIONS,
  CTX_MENU_ITEMS,
  AUTO_TITLE,
  SLASH_MENU,
  RUNTIME_SWITCH_HOST,
  WORKSPACE_SURFACE_HOST,
  WORKSPACE_ENTRY_HOST,
  WORKSPACE_SESSION_NAV_HOST,
  ...SCC_MEMBERS,
]) {
  test(`以 ${entry.split('/').pop()} 为入口先求值：静态环闭合并可导出`, async () => {
    await withGraphCase(async (c) => {
      const module = await c.load(entry);
      assert.ok(module && typeof module === 'object', `${entry} 求值成功`);
      // 环对端在本入口下同样已求值（同一 case 图）
      const queue = await c.load(QUEUE_PROJECTION);
      const sse = await c.load(SSE_CLIENT);
      assert.equal(typeof queue.applyQueuedInputsTexts, 'function');
      assert.equal(typeof sse.isSseActive, 'function');
    });
  });
}
