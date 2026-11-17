/**
 * P2 第二波 2（runtime-status 域）——三个跨文件可变状态键的 owner。
 *
 * 装载路线：test/helpers/p2-esm-case.js 的 withP2EsmCase（每个用例 = 一份真实
 * classic 沙箱 + 一张真实 ESM 图，计时器按用例记账并在结束时取消；不带
 * --test-force-exit 也应正常退出）。
 *
 * 钉住的事：
 *   1. 迁移边界：三个键在经典相同轮次带真初值可读（首屏
 *      `app-main` 顶层 `applyLanguage()` → `renderAgentList` / `renderCurrentMainView`
 *      → `readCurrentSessionViewState()` 读 `connected`）；侧栏投影、通知主逻辑、
 *      200ms 时钟、`resetRuntimeStatusForSwitch` 仍留在 classic；
 *   2. 逐键 claim 语义：每个键的 classic 写值被 owner 吸收（无双存储），此后
 *      双向转发；owner 不新增任何注册键；
 *   3. 未知键：已 claim 域补注册未声明键**立即失败**，不返回 undefined、不吞写；
 *   4. 时钟：classic 相启动的 200ms 间隔可观测（delay + 一次 tick 的 DOM 写入）；
 *   5. 真实依赖：classic 复位块写入落在 owner 活绑定，并经 tool-progress 桥键
 *      清空真实进度状态（不复制业务、不静默跳过）。
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
};

/** 键映射表：classic 全局名 ↔ owner 导出名 ↔ setter（导出名与全局名唯一差异是下划线）。 */
const KEYS = [
  {
    classic: 'currentRuntimeConnected',
    exported: 'currentRuntimeConnected',
    setter: 'setCurrentRuntimeConnected',
    seed: false,
    next: true,
  },
  {
    classic: 'lastNotificationStatusPayload',
    exported: 'lastNotificationStatusPayload',
    setter: 'setLastNotificationStatusPayload',
    seed: { pre: 1 },
    next: { after: 1 },
  },
  {
    classic: '_lastRenderedNotificationRuntime',
    exported: 'lastRenderedNotificationRuntime',
    setter: 'setLastRenderedNotificationRuntime',
    seed: { pre: 2 },
    next: { after: 2 },
  },
];

/**
 * 跨 realm 归一：沙箱里创建的对象原型属于 vm realm，deepStrictEqual 会因原型
 * 不同而失败；这里只比较数据形状（种子值都是 JSON 可表达的纯对象/布尔）。
 */
const plain = (value) => (value && typeof value === 'object' ? { ...value } : value);

function loadClassicRuntimeStatus(sandbox) {
  sandbox.loadSource('public/src/modules/kernel-state.js');
  sandbox.loadSource(RUNTIME_STATUS);
}

test('runtime-status：三键逐键 claim（吸收 + 双向转发），owner 不新增注册键', async () => {
  await withP2EsmCase({ globals: CHAIN_GLOBALS, classic: loadClassicRuntimeStatus }, async (c) => {
    // ── 经典相同轮次：键带真初值可读，且已不再是词法绑定（首屏同步链前提）──
    for (const { classic } of KEYS) {
      assert.equal(c.read(`typeof ${classic}`) !== 'undefined', true, `${classic} 在经典相可读`);
      assert.equal(c.read(`Object.prototype.hasOwnProperty.call(window, ${JSON.stringify(classic)})`), true,
        `${classic} 由 classic 相 defineKey 注册（原词法声明已移除）`);
    }
    // ── 同步边界仍在 classic（首屏投影/指示块/时钟/复位块）──
    for (const name of [
      'collectRuntimeEntriesForPrebuilt', 'isRuntimeCalling', 'isRuntimeSuspended',
      'isSidebarRuntimeDisconnected', 'isSuspendedNotificationPayload',
      'resolveNotificationCallingState', 'updateNotificationStatus',
      'applyNotificationStatus', 'ensureChatRuntimeIndicator', 'ensureNotificationClockTimer',
      'applyContextGuardStatus', 'resetRuntimeStatusForSwitch',
    ]) {
      assert.equal(c.read(`typeof ${name}`), 'function', `${name} 必须保持经典相同轮次可用`);
    }
    // 引用被 ESM 宿主持有 / 闭包私有的 Map 留在 classic 原位
    for (const map of ['_agentSuspended', '_runtimeStatusMemory', '_threadSidebarEntries']) {
      assert.equal(c.read(`${map} instanceof Map`), true, `${map} 仍是 classic 顶层 Map`);
    }

    // ── claim 前：逐键写入经典相哑存储 ──
    for (const { classic, seed } of KEYS) {
      c.read(`${classic} = ${JSON.stringify(seed)}`);
    }

    const registeredBefore = c.read('window.KernelState.stats().registeredKeys');
    const mod = await c.load(OWNER);

    // ── 逐键吸收：claim 时把哑存储现值送进 owner 活绑定 ──
    for (const { classic, exported, seed } of KEYS) {
      assert.deepEqual(plain(mod[exported]), plain(seed), `${classic} 的经典相写值必须被 claim 吸收`);
      assert.deepEqual(plain(c.read(classic)), plain(seed), `${classic} 经访问器读到同一值`);
    }
    // ── 逐键双向转发：classic 写 → owner 读；owner 写 → classic 读 ──
    for (const { classic, exported, setter, next } of KEYS) {
      c.read(`${classic} = ${JSON.stringify(next)}`);
      assert.deepEqual(plain(mod[exported]), plain(next), `${classic} 的 classic 写方必须转发进 owner 活绑定`);
      mod[setter]({ fromOwner: classic });
      assert.deepEqual(plain(c.read(classic)), { fromOwner: classic }, `${setter} 的写入必须对 classic 读方可见`);
    }

    // ── owner 只 claim、不新增注册键（增量口径，不依赖沙箱总键数）──
    const registeredAfter = c.read('window.KernelState.stats().registeredKeys');
    assert.equal(registeredAfter, registeredBefore, 'owner 不得新增桥键注册');

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
  });
});

test('runtime-status：已 claim 域补注册未知键立即抛错，不吞值', async () => {
  await withP2EsmCase({ globals: CHAIN_GLOBALS, classic: loadClassicRuntimeStatus }, async (c) => {
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
    const mod = await c.load(OWNER);
    c.read('lastNotificationStatusPayload = { afterGhost: true }');
    assert.equal(mod.lastNotificationStatusPayload.afterGhost, true,
      '未知键报错后，已声明键的转发照常生效');
  });
});

test('runtime-status：classic 相启动的 200ms 通知时钟可观测（delay + tick 写入）', async () => {
  const intervals = [];
  await withP2EsmCase({
    globals: CHAIN_GLOBALS,
    classic: (sandbox) => {
      sandbox.loadSource('public/src/modules/kernel-state.js');
      // 最小计时 spy：只记录 window.setInterval 的 delay 与回调，随后恢复完整。
      const realSetInterval = sandbox.setInterval;
      sandbox.setInterval = (callback, delay, ...rest) => {
        intervals.push({ callback, delay });
        return realSetInterval(callback, delay, ...rest);
      };
      try {
        sandbox.loadSource(RUNTIME_STATUS);
      } finally {
        sandbox.setInterval = realSetInterval;
      }
    },
  }, async (c) => {
    const clock = intervals.filter((entry) => entry.delay === 200);
    assert.equal(clock.length, 1, 'classic 相恰好启动一个 200ms 间隔（通知时钟）');
    assert.equal(c.timerCount() >= 1, true, '该间隔按用例记账（dispose 时取消）');

    // tick 可观测：置上快照并手动跑一次回调，观察 metrics 的 DOM 写入。
    const metrics = { innerHTML: '' };
    const statusEl = { style: { display: '' } };
    c.document.getElementById = (id) => {
      if (id === 'notification-status') return statusEl;
      if (id === 'notification-metrics') return metrics;
      return null;
    };
    c.read(`_lastRenderedNotificationRuntime = { callStartedAt: Date.now() - 1500 }`);
    clock[0].callback();
    assert.match(metrics.innerHTML, /notification-metric/, '一次 tick 必须写出运行时计时块');
  });
});

test('runtime-status：classic 复位块写入落在 owner 活绑定，并清空真实工具进度', async () => {
  await withP2EsmCase({ globals: CHAIN_GLOBALS, classic: loadClassicRuntimeStatus }, async (c) => {
    const calls = [];
    c.expose('__resetCalls', calls);
    c.expose('resetCallElapsedForSwitch', () => { calls.push('elapsed'); });
    c.expose('runWithSuppressedChatViewportObservers', (work) => { calls.push('suppress'); work(); });

    // 生产时序：复位块被调用时 tool-progress 的桥键已就位
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

    // 就地改造本案的 document 桩（globalThis.document 与 sandbox.document 是同一
    // 对象，classic 与 ESM 两侧都读到同一份覆盖）。
    c.document.getElementById = (id) => {
      if (id === 'notification-status') return { style: {}, className: '', querySelector: () => null };
      if (id === 'chat-container') return chatStub;
      if (id === 'notification-phase' || id === 'notification-summary' || id === 'notification-metrics') {
        return { textContent: '', innerHTML: '' };
      }
      return null;
    };

    // 生产消费方路径：classic 裸标识符调用（thread-store 接续 rebind / runtime-switch）
    c.read('resetRuntimeStatusForSwitch()');

    assert.equal(owner.lastRenderedNotificationRuntime, null, '快照清空写入 owner 活绑定');
    assert.equal(owner.lastNotificationStatusPayload, null, '通知载荷清空写入 owner 活绑定');
    assert.equal(c.read('_lastRenderedNotificationRuntime'), null, 'classic 读方同步看到清空');
    assert.deepEqual(calls, ['elapsed', 'suppress'], 'classic 依赖各调用一次（视口抑制只在有残留块时）');
    assert.equal(removed, 1, '残留指示块被移除');
    assert.equal(toolProgress.resolveToolProgressForCall({ id: 'call-reset' }), null,
      '复位块经 tool-progress 桥键清空真实进度（不是副本，也不是静默跳过）');
  });
});
