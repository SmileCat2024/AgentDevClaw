/**
 * Rotation Registry 单元契约：进程内在办登记的配对与防御阀。
 *
 * 这是运行期幽灵挡板判定的唯一事实源（thread-succession.js 的
 * convergePhantomRotating）：登记在册 → 真实接续，扫描不碰；不在册 →
 * 幽灵投影，立即收敛。契约焦点：
 *   1. begin/isActive/end 的配对语义（幂等注销、重复 begin 刷新）；
 *   2. age 阀：泄漏登记（编排方漏 end）按超龄处理，把「永久跳过收敛」
 *      降级为「有界跳过」；
 *   3. 空 id 恒不活跃（挡板事实缺失时不制造在办假象）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { createRotationRegistry, getRotationRegistry } = await import('../server/thread-control/rotation-registry.js');

test('begin / isActive / end pairing: registered means in-flight, end is idempotent', () => {
  const registry = createRotationRegistry();
  assert.equal(registry.isActive('wt-1'), false, '未登记 = 无在办');

  registry.begin('wt-1', { reason: 'summary' });
  assert.equal(registry.isActive('wt-1'), true);
  assert.equal(registry.activeCount(), 1);

  registry.end('wt-1');
  assert.equal(registry.isActive('wt-1'), false, '终局注销');
  registry.end('wt-1'); // 幂等：commit 与 fail 的 finally 可能都触发
  assert.equal(registry.isActive('wt-1'), false);
  assert.equal(registry.activeCount(), 0);
});

test('age valve: leaked registration expires and self-clears instead of blocking convergence forever', () => {
  let now = 1_000;
  const registry = createRotationRegistry({ maxAgeMs: 100, now: () => now });

  registry.begin('wt-leak', { reason: 'manual' });
  now += 50;
  assert.equal(registry.isActive('wt-leak'), true, '阀内视为在办');

  now += 51; // 超过 maxAgeMs：模拟未来编排方走 fallback 路径漏 end
  assert.equal(registry.isActive('wt-leak'), false, '超龄登记按不存在处理');
  assert.equal(registry.activeCount(), 0, '顺手清除泄漏条目');
});

test('empty or blank threadId is never active', () => {
  const registry = createRotationRegistry();
  registry.begin('');
  registry.begin('   ');
  assert.equal(registry.isActive(''), false);
  assert.equal(registry.isActive(undefined), false);
  assert.equal(registry.activeCount(), 0, '空 id 不入册');
});

test('getRotationRegistry returns a shared per-process instance', () => {
  const a = getRotationRegistry();
  const b = getRotationRegistry();
  assert.equal(a, b);
  assert.equal(typeof a.isActive, 'function');
});
