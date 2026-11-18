/**
 * P2 第二波 2（runtime-status 域）——三个跨文件可变状态键的 owner。
 *
 * 装载路线：test/helpers/p2-esm-case.js 的 withP2EsmCase（每个用例 = 一份真实
 * classic 沙箱 + 一张真实 ESM 图，计时器按用例记账并在结束时取消；不带
 * --test-force-exit 也应正常退出）。
 *
 * P4 T2 收尾批次改变了相位：runtime-status 已迁 ESM，三个键的 `defineKey` 也随之
 * 进入模块相（classic 相不再有同名词法绑定）。owner（p2-w2-2-runtime-status-owner）
 * 仍是三个键的唯一物理持有方；注册与认领的先后顺序在本文件里两种都被钉住：
 *   - owner 先 claim、模块后 defineKey → 初值经 impl.set 送入域模块（吸收语义）；
 *   - 键的读写转发、访问器形态、未知键拒绝与桥键注册增量在模块相核对。
 *
 * 钉住的事：
 *   1. 迁移边界：三个键在模块相由 runtime-status 的注册行安装访问器（首屏
 *      `applyLanguage()` → `renderAgentList` / `readCurrentSessionViewState` 读
 *      `connected` 发生在 boot.js，晚于本模块求值——见 P4 时序切换）；
 *   2. 逐键 claim 语义：吸收 + 双向转发，owner 不新增任何注册键；
 *   3. 未知键：已 claim 域补注册未声明键**立即失败**，不返回 undefined、不吞写；
 *   4. 时钟：模块相启动的 200ms 间隔可观测（delay + 一次 tick 的 DOM 写入）；
 *   5. 真实依赖：复位块写入落在 owner 活绑定，并经 tool-progress 桥键清空真实
 *      进度状态（不复制业务、不静默跳过）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';

const OWNER = 'public/src/modules/p2-w2-2-runtime-status-owner.js';
const RUNTIME_STATUS = 'public/src/modules/runtime-status.js';
const TOOL_PROGRESS = 'public/src/modules/tool-progress.js';

// runtime-status 的 ESM import 链（tool-progress → markdown-utils）在模块顶层
// 读取的 classic 桥键值 / 注册表；按生产形态注入。
const CHAIN_GLOBALS = {
  escapeHtml: (text) => String(text ?? ''),
  renderer: {},
  marked: { parse: () => '', setOptions() {}, use() {}, Renderer: class {} },
  ClawFW: { actions: { registerMany() {} } },
  // classic 容器宿主（生产 owner: app-core）：runtime-status 经 callActivity 适配面
  // 取用运行中 / 刚完成 / 打断抑制三个容器。本用例只关心状态键，容器给最小实例。
  createP2BootstrapCallActivityHost: () => ({
    _agentCallActive: new Map(), _recentlyFinishedRuntimes: new Set(),
    _seenChoiceAlertIds: new Set(), _autoTitleTriggered: new Set(),
    _interruptSuppression: new Map(), _lastInterruptUserActionAt: 0,
  }),
};

/** 键映射表：classic 全局名 ↔ owner 导出名 ↔ setter（导出名与全局名唯一差异是下划线）。 */
const KEYS = [
  {
    classic: 'currentRuntimeConnected',
    exported: 'currentRuntimeConnected',
    setter: 'setCurrentRuntimeConnected',
    initial: true,
    next: { fromOwner: 'connected' },
  },
  {
    classic: 'lastNotificationStatusPayload',
    exported: 'lastNotificationStatusPayload',
    setter: 'setLastNotificationStatusPayload',
    initial: null,
    next: { after: 1 },
  },
  {
    classic: '_lastRenderedNotificationRuntime',
    exported: 'lastRenderedNotificationRuntime',
    setter: 'setLastRenderedNotificationRuntime',
    initial: null,
    next: { after: 2 },
  },
];

/**
 * 跨 realm 归一：沙箱里创建的对象原型属于 vm realm，deepStrictEqual 会因原型
 * 不同而失败；这里只比较数据形状（种子值都是 JSON 可表达的纯对象/布尔）。
 */
const plain = (value) => (value && typeof value === 'object' ? { ...value } : value);

function loadClassicKernel(sandbox) {
  sandbox.loadSource('public/src/modules/kernel-state.js');
}

test('runtime-status：三键注册后逐键双向转发，owner 不新增注册键', async () => {
  await withP2EsmCase({ globals: CHAIN_GLOBALS, classic: loadClassicKernel }, async (c) => {
    // owner 先 claim（注册行尚未执行）→ 三个键此时既无访问器也无值。
    const registeredBeforeOwner = c.read('window.KernelState.stats().registeredKeys');
    const owner = await c.load(OWNER);
    assert.equal(c.read('window.KernelState.stats().registeredKeys'), registeredBeforeOwner,
      'owner 只 claim、不新增桥键注册');
    for (const { classic } of KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(c.window, classic);
      assert.equal(descriptor?.get, undefined,
        `${classic} 的访问器由 runtime-status 的注册行安装（模块相；此刻只有沙箱桩值）`);
    }
    // runtime-status 模块相求值：三个 defineKey 把初值经 impl.set 送入 owner（吸收）。
    const runtimeStatus = await c.load(RUNTIME_STATUS);
    for (const { classic, exported, initial } of KEYS) {
      assert.deepEqual(plain(owner[exported]), plain(initial), `${classic} 的注册初值必须进入 owner 活绑定`);
      assert.deepEqual(plain(c.read(classic)), plain(initial), `${classic} 经访问器读到同一值`);
    }

    // ── 逐键双向转发：classic 写 → owner 读；owner 写 → classic 读 ──
    for (const { classic, exported, setter, next } of KEYS) {
      c.read(`${classic} = ${JSON.stringify(next)}`);
      assert.deepEqual(plain(owner[exported]), plain(next), `${classic} 的 classic 写方必须转发进 owner 活绑定`);
      owner[setter]({ fromOwner: classic });
      assert.deepEqual(plain(c.read(classic)), { fromOwner: classic }, `${setter} 的写入必须对 classic 读方可见`);
    }

    // ── 私有 setter 不上桥 ──
    for (const { setter } of KEYS) {
      assert.equal(c.read(`typeof ${setter}`), 'undefined', `${setter} 不应成为 window 全局`);
    }
    // ── 访问器面：成对、不可枚举、可撤桥 ──
    for (const { classic } of KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(c.window, classic);
      assert.ok(descriptor && typeof descriptor.get === 'function' && typeof descriptor.set === 'function',
        `${classic} 必须是成对访问器`);
      assert.equal(descriptor.enumerable, false, `${classic} 不得进入枚举面`);
      assert.equal(descriptor.configurable, true, `${classic} 必须可撤桥`);
    }

    // ── 侧栏 / 通知域的函数键与状态容器在模块相位就位 ──
    for (const name of [
      'updateNotificationStatus', 'applyContextGuardStatus', 'isRuntimeCalling',
      'ensureChatRuntimeIndicator', 'resetRuntimeStatusForSwitch',
    ]) {
      assert.equal(c.read(`typeof window.${name}`), 'function', `${name} 由 runtime-status-api 域桥键提供`);
    }
    // `_agentSuspended`（B4）与两个缓存容器是模块私有 / 具名导出，不再是全局。
    assert.equal(runtimeStatus._agentSuspended instanceof Map, true, '_agentSuspended 是模块私有 Map（B4 具名导出）');
    assert.equal(c.read("typeof _agentSuspended"), 'undefined', 'B4 容器不再作为全局暴露');
  });
});

test('runtime-status：已 claim 域补注册未知键立即抛错，不吞值', async () => {
  await withP2EsmCase({ globals: CHAIN_GLOBALS, classic: loadClassicKernel }, async (c) => {
    await c.load(OWNER);

    // 同域补注册未声明键：KernelState 会把初值经 impl.set 送进域模块，
    // owner 的 set 必须立刻拒绝（错误在注册点暴露，而非退化成写丢失）。
    assert.throws(
      () => c.read("window.KernelState.defineKey('runtime-status', 'ghostKey', 1)"),
      /\[runtime-status\] 未知状态键：ghostKey/,
      '未声明键必须立即失败并指明 domain/key',
    );
    // 失败后不留半成品：window 上没有该键的访问器，也没有可读值。
    assert.equal(c.read("Object.prototype.hasOwnProperty.call(window, 'ghostKey')"), false,
      '失败后不得安装访问器');
    assert.equal(c.read("typeof window.ghostKey"), 'undefined', '失败后不得留下可读值');

    // 失败的补注册不得影响既有键：三键仍正常转发（错误只落在未知键上）。
    await c.load(RUNTIME_STATUS);
    const owner = await c.load(OWNER);
    c.read('lastNotificationStatusPayload = { afterGhost: true }');
    assert.equal(owner.lastNotificationStatusPayload.afterGhost, true,
      '未知键报错后，已声明键的转发照常生效');
  });
});

test('runtime-status：模块相启动的 200ms 通知时钟可观测（delay + tick 写入）', async () => {
  const intervals = [];
  await withP2EsmCase({
    globals: CHAIN_GLOBALS,
    classic: loadClassicKernel,
  }, async (c) => {
    // 最小计时 spy：只记录 window.setInterval 的 delay 与回调（模块经 window 取用）。
    const realSetInterval = c.window.setInterval;
    c.window.setInterval = (callback, delay, ...rest) => {
      intervals.push({ callback, delay });
      return realSetInterval(callback, delay, ...rest);
    };
    try {
      await c.load(RUNTIME_STATUS);
    } finally {
      c.window.setInterval = realSetInterval;
    }

    const clock = intervals.filter((entry) => entry.delay === 200);
    assert.equal(clock.length, 1, '模块相恰好启动一个 200ms 间隔（通知时钟）');
    assert.equal(c.timerCount() >= 1, true, '该间隔按用例记账（dispose 时取消）');

    // tick 可观测：置上快照并手动跑一次回调，观察 metrics 的 DOM 写入。
    const metrics = { innerHTML: '' };
    const statusEl = { style: { display: '' } };
    c.document.getElementById = (id) => {
      if (id === 'notification-status') return statusEl;
      if (id === 'notification-metrics') return metrics;
      return null;
    };
    const owner = await c.load(OWNER);
    owner.setLastRenderedNotificationRuntime({ callStartedAt: Date.now() - 1500 });
    clock[0].callback();
    assert.match(metrics.innerHTML, /notification-metric/, '一次 tick 必须写出运行时计时块');
  });
});

test('runtime-status：复位块写入落在 owner 活绑定，并清空真实工具进度', async () => {
  await withP2EsmCase({ globals: CHAIN_GLOBALS, classic: loadClassicKernel }, async (c) => {
    const calls = [];
    c.expose('__resetCalls', calls);
    c.expose('resetCallElapsedForSwitch', () => { calls.push('elapsed'); });
    c.expose('runWithSuppressedChatViewportObservers', (work) => { calls.push('suppress'); work(); });

    // 生产时序：复位块被调用时 runtime-status 与 tool-progress 的桥键都已就位。
    await c.load(RUNTIME_STATUS);
    const toolProgress = await c.load(TOOL_PROGRESS);
    const owner = await c.load(OWNER);

    toolProgress.applyToolProgressNotification({
      state: { type: 'tool.progress', data: { callId: 'call-reset', startedAt: Date.now() } },
    });
    assert.ok(toolProgress.resolveToolProgressForCall({ id: 'call-reset' }), '进度已入表');

    owner.setLastRenderedNotificationRuntime({ callStartedAt: 1 });
    owner.setLastNotificationStatusPayload({ callActive: true });
    let removed = 0;
    const indicator = { remove() { removed += 1; } };
    const chatStub = {
      querySelector: (selector) => (selector === '#runtime-indicator-row' ? indicator : null),
      querySelectorAll: () => [],
    };

    // 就地改造本案的 document 桩（ESM 侧读 globalThis.document，与沙箱同一对象）。
    c.document.getElementById = (id) => {
      if (id === 'notification-status') return { style: {}, className: '', querySelector: () => null };
      if (id === 'chat-container') return chatStub;
      if (id === 'notification-phase' || id === 'notification-summary' || id === 'notification-metrics') {
        return { textContent: '', innerHTML: '' };
      }
      return null;
    };

    // 生产消费方路径：经 runtime-status-api 桥键（thread-store 接续 rebind /
    // runtime-switch 的切换宿主面）。
    c.read('window.resetRuntimeStatusForSwitch()');

    assert.equal(owner.lastRenderedNotificationRuntime, null, '快照清空写入 owner 活绑定');
    assert.equal(owner.lastNotificationStatusPayload, null, '通知载荷清空写入 owner 活绑定');
    assert.equal(c.read('_lastRenderedNotificationRuntime'), null, 'classic 读方同步看到清空');
    assert.deepEqual(calls, ['elapsed', 'suppress'], '依赖各调用一次（视口抑制只在有残留块时）');
    assert.equal(removed, 1, '残留指示块被移除');
    assert.equal(toolProgress.resolveToolProgressForCall({ id: 'call-reset' }), null,
      '复位块经 tool-progress 桥键清空真实进度（不是副本，也不是静默跳过）');
  });
});
