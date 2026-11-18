import test from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { APP_CORE_DOMAIN, prepareEsmModules } from './p2-classic-hosts.js';

/**
 * call-interrupt 同步引擎：production owner 是 app-core 的 bootstrap IIFE（P4 T5 起
 * 在模块相求值），四个 `call-interrupt` 桥键与 `_interruptSuppression`（domain
 * app-core 的 const 容器槽）都指向同一份状态。
 */
const caseOptions = () => ({
  classic: (sandbox) => prepareEsmModules(sandbox, APP_CORE_DOMAIN),
});

test('interrupting never expires by time and only a known newer call releases it', async () => {
  await withP2EsmCase(caseOptions(), async (c) => {
    const pending = c.read('_interruptSuppression');
    pending.clear();

    c.window.markInterruptPending('one', 1000);
    for (const observed of [undefined, 0, -1, NaN, 999, 1000]) {
      assert.equal(c.window.isInterruptSuppressed('one', observed), true);
    }
    assert.equal(c.window.isInterruptSuppressed('two', 2000), false);
    assert.equal(c.window.isInterruptSuppressed('one', 1001), false);
    assert.equal(pending.has('one'), false);
    c.window.markInterruptPending('one');
    assert.equal(c.window.isInterruptSuppressed('one', 2000), true, 'unknown interrupted call cannot be compared');
    c.window.clearInterruptSuppression('two');
    assert.equal(c.window.isInterruptSuppressed('one'), true);
    c.window.clearInterruptSuppression('one');
    assert.equal(c.window.isInterruptSuppressed('one'), false);
  });
});

test('notification call identity accepts positive timestamps and prioritizes runtime fields', async () => {
  await withP2EsmCase(caseOptions(), async (c) => {
    assert.equal(c.window.getNotificationCallStartedAt({ runtime: { callStartedAt: '12' }, callStartedAt: 30 }), 12);
    assert.equal(c.window.getNotificationCallStartedAt({ callStartedAt: 30 }), 30);
    for (const value of [null, -1, 0, 'bad', Infinity]) {
      assert.equal(c.window.getNotificationCallStartedAt({ callStartedAt: value }), 0);
    }
  });
});

test('ESM adapter and classic owner share the original const Map', async () => {
  await withP2EsmCase(caseOptions(), async (c) => {
    const original = c.read('_interruptSuppression');
    original.set('early', { callStartedAt: 10 });
    const module = await c.load('public/src/modules/call-interrupt-host.js');
    assert.equal(typeof c.window.isInterruptSuppressed, 'function', 'classic bridge key is the production owner');
    assert.equal(module.isInterruptSuppressed('early', 10), true);
    assert.equal(c.window.isInterruptSuppressed('early', 10), true, 'classic reads the same owner');
    c.read('_interruptSuppression.delete("early")');
    assert.equal(module.isInterruptSuppressed('early', 10), false);
    module.markInterruptPending('later', 20);
    assert.equal(original.get('later').callStartedAt, 20);
    assert.equal(c.window.isInterruptSuppressed('later', 20), true);
    // const 容器槽：窗口面按引用交出同一容器（整替只影响窗口面，模块内部继续持有
    // 原容器——与迁移前「classic 顶层 const + 同名 window 普通属性」的分叉一致）。
    assert.strictEqual(c.read('_interruptSuppression'), original, '桥键交出的是 owner 的容器');
  });
});
