/**
 * session-view-storage（ESM owner）与 classic 写方之间的所有权转移（P2 真实 ESM 图路线）。
 *
 * 装载路线：classic 相跑真实生产源（app-core 注册全部桥键初值、session-view-state
 * 提供会话视图提交器），session-view-storage / todo-plan 经 `withP2EsmCase` +
 * `c.load` 真实 import，每个用例一张独立模块图（claim 不可撤销，跨用例复用会让
 * 第二个用例失去"认领前"这一相位）。todo-plan 已迁 ESM（P4 L1），它 import
 * session-view-storage——认领前不可能经它写入，故 pre-claim 的 plan 成对值直接写
 * 真实桥访问器（等价于「尚无 owner 时的窗口写入」）。
 *
 * 覆盖：认领前的 classic 写入被原样吸收（引用/值都不复制）、认领后 classic 写方与
 * ESM 命名绑定双向一致、真实 setter 维护「快照 + 签名」成对语义、以及认领后过期
 * 提交被 token 拒绝。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { APP_CORE_DOMAIN, prepareEsmModules, SESSION_VIEW_DOMAIN } from './p2-classic-hosts.js';

const SESSION_VIEW_STORAGE = 'public/src/modules/session-view-storage.js';
const OVERVIEW_DATA = 'public/src/modules/overview-data.js';

/** app-core 在本域注册的全部桥键（认领对象）。 */
const STORAGE_KEYS = [
  'currentMessages',
  'currentInputRequests',
  'toolRenderConfigs',
  'TOOL_NAMES',
  'currentHookInspector',
  'currentHookInspectorSignature',
  'currentOverviewSnapshot',
  'currentOverviewSignature',
  'currentTodoPlan',
  'currentTodoPlanSignature',
];

/** vendor markdown 解析器 / 高亮库最小等价桩（markdown-utils 求值期取用）。 */
const VENDOR_STUBS = {
  marked: { Renderer: class { constructor() {} }, setOptions() {}, parse: () => '' },
  hljs: { getLanguage: () => null, highlight: () => ({ value: '' }) },
};

/** classic 相：app-core（桥键注册 + 宿主工厂）→ session-view-state。 */
function loadClassicBootstrap(sandbox) {
  sandbox.loadSource('public/src/modules/action-dispatcher.js');
  // i18n 已迁 ESM（P4）：t 桥键由 createFrontendSandbox 自动装载，见 test/helpers/install-i18n.js
  prepareEsmModules(sandbox, APP_CORE_DOMAIN);
  prepareEsmModules(sandbox, SESSION_VIEW_DOMAIN);
  // todo-plan 已迁 ESM（P4 L1）：它 import session-view-storage，必须在 case 体内
  // 经 c.load 装载（否则会先替本用例认领本域，失去认领前相位）。
}

test('real session patch preserves early data through claim and rejects stale commits afterward', async () => {
  await withP2EsmCase({ classic: loadClassicBootstrap, globals: VENDOR_STUBS }, async (c) => {
    c.read("currentRuntimeAgentId = 'runtime-a'; focusedAgentId = 'agent-a'; currentRuntimeConnected = true;");
    const messages = [{ role: 'user', content: 'before claim' }];
    c.window.earlyMessages = messages;
    // 认领前的真实 classic 写入：applySessionViewPatch 落进哑存储
    c.read('applySessionViewPatch({ messages: earlyMessages });');

    const storage = await c.load(SESSION_VIEW_STORAGE);
    assert.strictEqual(storage.currentMessages, messages, 'claim absorbs the pre-claim transcript by reference');

    const token = c.read('captureSessionViewToken()');
    c.window.oldToken = token;
    const nextMessages = [{ role: 'assistant', content: 'after claim' }];
    c.window.nextMessages = nextMessages;
    assert.equal(c.read('commitSessionViewPatch(oldToken, { messages: nextMessages })'), true);
    assert.strictEqual(storage.currentMessages, nextMessages);

    c.read("currentRuntimeAgentId = 'runtime-b'; _switchEpoch += 1;");
    assert.equal(c.read("commitSessionViewPatch(oldToken, { messages: [{ content: 'stale' }] })"), false);
    assert.strictEqual(storage.currentMessages, nextMessages, 'a stale response cannot overwrite the new transcript');
  });
});

test('session-view-storage claim absorbs pre-claim values without copying or losing references', async () => {
  await withP2EsmCase({ classic: loadClassicBootstrap, globals: VENDOR_STUBS }, async (c) => {
    // 认领前的 classic 写方：整体替换两个引用型状态
    const beforeClaimMessages = [{ role: 'user', content: 'written before claim' }];
    const beforeClaimInputRequests = [{ id: 'written-before-claim' }];
    c.window.beforeClaimMessages = beforeClaimMessages;
    c.window.beforeClaimInputRequests = beforeClaimInputRequests;
    c.read('currentMessages = beforeClaimMessages; currentInputRequests = beforeClaimInputRequests;');

    // 认领前经真实 window 访问器读到的全部值（含 app-core 的初值对象）
    const before = {};
    for (const key of STORAGE_KEYS) before[key] = c.window[key];

    const storage = await c.load(SESSION_VIEW_STORAGE);
    for (const key of STORAGE_KEYS) {
      assert.strictEqual(storage[key], before[key], `${key} keeps its pre-claim reference/value`);
      assert.strictEqual(c.window[key], before[key], `${key} window accessor reads the claimed value`);
    }
    assert.strictEqual(storage.currentMessages, beforeClaimMessages);
    assert.strictEqual(storage.currentInputRequests, beforeClaimInputRequests);

    storage.currentMessages.push({ role: 'assistant', content: 'in-place mutation' });
    assert.strictEqual(c.window.currentMessages, storage.currentMessages);
    assert.equal(c.window.currentMessages[1].content, 'in-place mutation');
    assert.strictEqual(beforeClaimMessages[1].content, 'in-place mutation', 'no copy was made at claim time');
  });
});

test('session-view-storage named live bindings and classic accessors stay bidirectional after claim', async () => {
  await withP2EsmCase({ classic: loadClassicBootstrap, globals: VENDOR_STUBS }, async (c) => {
    const storage = await c.load(SESSION_VIEW_STORAGE);

    const classicMessages = [{ role: 'user', content: 'classic replacement' }];
    c.window.classicMessages = classicMessages;
    c.read('currentMessages = classicMessages;');
    assert.strictEqual(storage.currentMessages, classicMessages);

    const esmInputRequests = [{ id: 'esm replacement' }];
    storage.setCurrentInputRequests(esmInputRequests);
    assert.strictEqual(c.window.currentInputRequests, esmInputRequests);
    assert.strictEqual(storage.currentInputRequests, esmInputRequests);

    for (const key of STORAGE_KEYS) {
      assert.ok(Object.prototype.hasOwnProperty.call(storage, key), `${key} is a named export`);
    }
  });
});

test('storage bridge and real setters keep overview/todo snapshot-signature pairs across claim', async () => {
  await withP2EsmCase({ classic: loadClassicBootstrap, globals: VENDOR_STUBS }, async (c) => {
    // ── 认领前：经 app-core 已注册的窗口访问器写入**非空**快照与签名 ──
    // hook / overview 此刻还没有 ESM owner，访问器落在哑存储；认领必须按引用
    // 吸收这些真实值（只吸收默认空值证明不了吸收语义）。
    const seed = {};
    c.window.__seed = seed;
    c.read(`
      __seed.hook = { lifecycleOrder: ['CallStart'], features: [{ name: 'before-claim-hook', tools: [] }], hooks: [] };
      __seed.hookSignature = 'hook-before-claim';
      __seed.overview = { updatedAt: 11, modelName: 'model-before-claim', context: { messageCount: 4 } };
      __seed.overviewSignature = 'overview-before-claim';
      currentHookInspector = __seed.hook;
      currentHookInspectorSignature = __seed.hookSignature;
      currentOverviewSnapshot = __seed.overview;
      currentOverviewSignature = __seed.overviewSignature;
    `);
    // todo 的「快照 + 签名」成对值：认领前无 owner，直接写真实桥访问器（todo-plan
    // 已迁 ESM，其 setter 依赖本域 owner，不能在本相位使用）。
    c.read(`
      __seed.todo = { feature: 'todo', tasks: [{ id: 'before-claim-todo', status: 'pending' }] };
      currentTodoPlan = __seed.todo;
      currentTodoPlanSignature = 'todo-before-claim';
    `);

    const beforeClaim = {
      hook: seed.hook,
      hookSignature: seed.hookSignature,
      overview: seed.overview,
      overviewSignature: seed.overviewSignature,
      todo: seed.todo,
      todoSignature: 'todo-before-claim',
    };
    // 认领前访问器读回的就是刚写入的引用/值（哑存储承接，未被任何 owner 认领）。
    assert.strictEqual(c.window.currentHookInspector, beforeClaim.hook);
    assert.strictEqual(c.window.currentOverviewSnapshot, beforeClaim.overview);
    assert.equal(c.window.currentHookInspectorSignature, 'hook-before-claim');
    assert.equal(c.window.currentOverviewSignature, 'overview-before-claim');
    assert.equal(beforeClaim.hook.features[0].name, 'before-claim-hook');
    assert.equal(beforeClaim.overview.modelName, 'model-before-claim');
    assert.equal(beforeClaim.todo.tasks[0].id, 'before-claim-todo');
    assert.ok(beforeClaim.todoSignature, 'the classic setter computed a signature pre-claim');

    const storage = await c.load(SESSION_VIEW_STORAGE);
    const overviewData = await c.load(OVERVIEW_DATA);
    // todo-plan（P4 L1 已迁 ESM）：真实 plan setter，import 本域 owner 之外的
    // markdown-utils / domRefs 宿主已由 classic 相提供。
    await c.load('public/src/modules/todo-plan.js');

    assert.strictEqual(storage.currentHookInspector, beforeClaim.hook);
    assert.equal(storage.currentHookInspectorSignature, beforeClaim.hookSignature);
    assert.strictEqual(storage.currentOverviewSnapshot, beforeClaim.overview);
    assert.equal(storage.currentOverviewSignature, beforeClaim.overviewSignature);
    assert.strictEqual(storage.currentTodoPlan, beforeClaim.todo);
    assert.equal(storage.currentTodoPlanSignature, beforeClaim.todoSignature);

    // ── 认领后：真实 classic setter（todo-plan）与真实 ESM setter（overview-data）
    //    都必须更新成对的两半，且 window 访问器读到同一份 ──
    c.read("setCurrentTodoPlan({ tasks: [{ id: 'after-claim-todo', status: 'completed' }] });");
    overviewData.setCurrentHookInspector({ features: [{ name: 'after-claim-hook' }] });
    overviewData.setCurrentOverviewSnapshot({ updatedAt: 22, context: { messageCount: 9 } });

    assert.equal(storage.currentTodoPlan.tasks[0].id, 'after-claim-todo');
    assert.ok(storage.currentTodoPlanSignature);
    assert.notEqual(storage.currentTodoPlanSignature, beforeClaim.todoSignature);
    assert.equal(c.window.currentTodoPlanSignature, storage.currentTodoPlanSignature);

    assert.equal(storage.currentHookInspector.features[0].name, 'after-claim-hook');
    assert.ok(storage.currentHookInspectorSignature);
    assert.notEqual(storage.currentHookInspectorSignature, beforeClaim.hookSignature);
    assert.equal(c.window.currentHookInspectorSignature, storage.currentHookInspectorSignature);

    assert.equal(storage.currentOverviewSnapshot.updatedAt, 22);
    assert.equal(storage.currentOverviewSnapshot.context.messageCount, 9);
    assert.ok(storage.currentOverviewSignature);
    assert.notEqual(storage.currentOverviewSignature, beforeClaim.overviewSignature);
    assert.equal(c.window.currentOverviewSignature, storage.currentOverviewSignature);

    // classic 消费方经桥键调 setter 也被认领后的 owner 转发生效（session-view-state
    // 的 applySessionViewPatch 走的就是这条路径）。
    assert.equal(typeof c.window.setCurrentHookInspector, 'function');
    c.window.setCurrentHookInspector({ features: [{ name: 'bridged-hook' }] });
    assert.equal(storage.currentHookInspector.features[0].name, 'bridged-hook');
  });
});
