import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';
import { loadModuleOnce } from './helpers/esm-module-loader.js';
import { createCallInterruptState, getNotificationCallStartedAt } from '../public/src/modules/call-interrupt-state.js';

test('interrupting never expires by time and only a known newer call releases it', () => {
  const pending = new Map();
  let now = 100;
  const policy = createCallInterruptState(pending, () => now);
  policy.markInterruptPending('one', 1000);
  now += 86400000;
  for (const observed of [undefined, 0, -1, NaN, 999, 1000]) {
    assert.equal(policy.isInterruptSuppressed('one', observed), true);
  }
  assert.equal(policy.isInterruptSuppressed('two', 2000), false);
  assert.equal(policy.isInterruptSuppressed('one', 1001), false);
  assert.equal(pending.has('one'), false);
  policy.markInterruptPending('one');
  assert.equal(policy.isInterruptSuppressed('one', 2000), true, 'unknown interrupted call cannot be compared');
  policy.clearInterruptSuppression('two');
  assert.equal(policy.isInterruptSuppressed('one'), true);
  policy.clearInterruptSuppression('one');
  assert.equal(policy.isInterruptSuppressed('one'), false);
});

test('notification call identity accepts positive timestamps and prioritizes runtime fields', () => {
  assert.equal(getNotificationCallStartedAt({ runtime: { callStartedAt: '12' }, callStartedAt: 30 }), 12);
  assert.equal(getNotificationCallStartedAt({ callStartedAt: 30 }), 30);
  for (const value of [null, -1, 0, 'bad', Infinity]) {
    assert.equal(getNotificationCallStartedAt({ callStartedAt: value }), 0);
  }
});

test('ESM bridge and classic pruning share the original const Map', async () => {
  const ctx = createFrontendSandbox();
  ctx.loadSource('public/src/app-core.js');
  const original = ctx.run('_interruptSuppression');
  original.set('early', { callStartedAt: 10 });
  const previous = globalThis.window;
  globalThis.window = ctx;
  try {
    const { module } = await loadModuleOnce('public/src/modules/call-interrupt-host.js', { installGlobals: false });
    assert.strictEqual(ctx.isInterruptSuppressed, module.isInterruptSuppressed);
    assert.equal(module.isInterruptSuppressed('early', 10), true);
    ctx.run('_interruptSuppression.delete("early")');
    assert.equal(module.isInterruptSuppressed('early', 10), false);
    module.markInterruptPending('later', 20);
    assert.equal(original.get('later').callStartedAt, 20);
    assert.throws(() => ctx.run('_interruptSuppression = new Map()'), { name: 'TypeError' });
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});
