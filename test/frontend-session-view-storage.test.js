/**
 * session-view-storage（ESM owner）与 classic 写方之间的所有权转移（P2 真实 ESM 图路线）。
 *
 * 装载路线：classic 相跑真实生产源（app-core 注册全部桥键初值、session-view-state
 * 提供会话视图提交器、todo-plan 提供真实的 plan 快照 setter），session-view-storage
 * 经 `withP2EsmCase` + `c.load` 真实 import，每个用例一张独立模块图（claim 不可
 * 撤销，跨用例复用会让第二个用例失去"认领前"这一相位）。
 *
 * 覆盖：认领前的 classic 写入被原样吸收（引用/值都不复制）、认领后 classic 写方与
 * ESM 命名绑定双向一致、真实 setter 维护「快照 + 签名」成对语义、以及认领后过期
 * 提交被 token 拒绝。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';

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

/** classic 相：app-core（桥键注册 + 宿主工厂）→ session-view-state → todo-plan。 */
function loadClassicBootstrap(sandbox) {
  sandbox.loadSource('public/src/modules/action-dispatcher.js');
  sandbox.loadSource('public/src/i18n.js');
  sandbox.loadSource('public/src/app-core.js');
  sandbox.loadSource('public/src/modules/session-view-state.js');
  sandbox.loadSource('public/src/modules/todo-plan.js');
}

test('real session patch preserves early data through claim and rejects stale commits afterward', async () => {
  await withP2EsmCase({ classic: loadClassicBootstrap }, async (c) => {
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
  await withP2EsmCase({ classic: loadClassicBootstrap }, async (c) => {
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
  await withP2EsmCase({ classic: loadClassicBootstrap }, async (c) => {
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
  await withP2EsmCase({ classic: loadClassicBootstrap }, async (c) => {
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
    // 同相再用真实 classic setter（todo-plan）写入它的「快照 + 签名」成对值。
    c.read("setCurrentTodoPlan({ tasks: [{ id: 'before-claim-todo', status: 'pending' }] });");

    const beforeClaim = {
      hook: seed.hook,
      hookSignature: seed.hookSignature,
      overview: seed.overview,
      overviewSignature: seed.overviewSignature,
      todo: c.window.currentTodoPlan,
      todoSignature: c.window.currentTodoPlanSignature,
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
