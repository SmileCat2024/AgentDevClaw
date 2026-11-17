import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';
import { loadModuleOnce } from './helpers/esm-module-loader.js';

test('interrupting never expires by time and only a known newer call releases it', () => {
  const ctx = createFrontendSandbox();
  ctx.loadSource('public/src/app-core.js');
  const pending = ctx.run('_interruptSuppression');
  pending.clear();

  ctx.markInterruptPending('one', 1000);
  for (const observed of [undefined, 0, -1, NaN, 999, 1000]) {
    assert.equal(ctx.isInterruptSuppressed('one', observed), true);
  }
  assert.equal(ctx.isInterruptSuppressed('two', 2000), false);
  assert.equal(ctx.isInterruptSuppressed('one', 1001), false);
  assert.equal(pending.has('one'), false);
  ctx.markInterruptPending('one');
  assert.equal(ctx.isInterruptSuppressed('one', 2000), true, 'unknown interrupted call cannot be compared');
  ctx.clearInterruptSuppression('two');
  assert.equal(ctx.isInterruptSuppressed('one'), true);
  ctx.clearInterruptSuppression('one');
  assert.equal(ctx.isInterruptSuppressed('one'), false);
});

test('notification call identity accepts positive timestamps and prioritizes runtime fields', () => {
  const ctx = createFrontendSandbox();
  ctx.loadSource('public/src/app-core.js');
  assert.equal(ctx.getNotificationCallStartedAt({ runtime: { callStartedAt: '12' }, callStartedAt: 30 }), 12);
  assert.equal(ctx.getNotificationCallStartedAt({ callStartedAt: 30 }), 30);
  for (const value of [null, -1, 0, 'bad', Infinity]) {
    assert.equal(ctx.getNotificationCallStartedAt({ callStartedAt: value }), 0);
  }
});

test('ESM adapter and classic owner share the original const Map', async () => {
  const ctx = createFrontendSandbox();
  ctx.loadSource('public/src/app-core.js');
  const original = ctx.run('_interruptSuppression');
  original.set('early', { callStartedAt: 10 });
  const previous = globalThis.window;
  globalThis.window = ctx;
  try {
    const { module } = await loadModuleOnce('public/src/modules/call-interrupt-host.js', { installGlobals: false });
    assert.equal(typeof ctx.isInterruptSuppressed, 'function', 'classic bridge key is the production owner');
    assert.equal(module.isInterruptSuppressed('early', 10), true);
    assert.equal(ctx.isInterruptSuppressed('early', 10), true, 'classic reads the same owner');
    ctx.run('_interruptSuppression.delete("early")');
    assert.equal(module.isInterruptSuppressed('early', 10), false);
    module.markInterruptPending('later', 20);
    assert.equal(original.get('later').callStartedAt, 20);
    assert.equal(ctx.isInterruptSuppressed('later', 20), true);
    assert.throws(() => ctx.run('_interruptSuppression = new Map()'), { name: 'TypeError' });
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});
