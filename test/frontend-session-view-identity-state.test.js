/**
 * session-view-identity-state（identity 域 owner）的认领 / 活绑定契约。
 *
 * 迁移前本文件还覆盖「classic session-view-state 经 window 访问器写、owner 认领后
 * 吸收同一份值」——P4 T2 批次把 session-view-state 迁成 ESM 后，那 5 条
 * `session-view-identity-state` 域注册已注销（唯一生产消费方 session-view-commit-host
 * 改具名 import），classic 访问器面不存在了，因此该覆盖点改为两个真实出口：
 *   1. 认领语义本身：classic 相 `defineKey` 注册的初值被 claim 一次性吸收（同一引用，
 *      不复制）——这是 kernel-state 契约在 identity 域上的实例；
 *   2. setter ↔ 活绑定 ↔ window 访问器三者同一份状态（生产里 classic 消费方仍按
 *      访问器读，owner 内部按活绑定读写）。
 * session-view-state 侧的写入 / 代次守卫由 frontend-session-view-commit.test.js 与
 * frontend-session-view-matrix.test.js 经桥键（applySessionViewPatch /
 * captureSessionViewToken / commitSessionViewPatch）覆盖。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';

const MODULE_PATH = 'public/src/modules/session-view-identity-state.js';

test('identity owner absorbs pre-claim registered values without copying', async () => {
  const meta = Object.freeze({ sessionId: 'session-a' });
  await withP2EsmCase({
    label: 'identity-claim-absorb',
    classic: (sandbox) => {
      sandbox.KernelState.defineKey('session-view-identity-state', '_sessionMeta', meta);
      sandbox.KernelState.defineKey('session-view-identity-state', '_sessionViewGeneration', 7);
      sandbox.KernelState.defineKey('session-view-identity-state', '_sessionViewModelRuntimeId', 'runtime-a');
    },
  }, async (c) => {
    const identity = await c.load(MODULE_PATH);
    assert.strictEqual(identity._sessionMeta, meta, '认领吸收的是同一引用，不是副本');
    assert.equal(identity._sessionViewGeneration, 7);
    assert.equal(identity._sessionViewModelRuntimeId, 'runtime-a');
    // 认领后 classic 侧访问器与活绑定仍是同一份状态
    assert.strictEqual(c.read('_sessionMeta'), meta);
    assert.equal(c.read('_sessionViewGeneration'), 7);
  });
});

test('identity owner setters update the claimed binding and the classic accessor reads the same value', async () => {
  await withP2EsmCase({
    label: 'identity-setter-liveness',
    classic: (sandbox) => {
      sandbox.KernelState.defineKey('session-view-identity-state', '_sessionViewGeneration', 0);
      sandbox.KernelState.defineKey('session-view-identity-state', '_sessionViewModelRuntimeId', '');
    },
  }, async (c) => {
    const identity = await c.load(MODULE_PATH);
    identity.setSessionViewGeneration(42);
    identity.setSessionViewModelRuntimeId('runtime-z');
    assert.equal(identity._sessionViewGeneration, 42);
    assert.equal(identity._sessionViewModelRuntimeId, 'runtime-z');
    assert.equal(c.read('_sessionViewGeneration'), 42);
    assert.equal(c.read('_sessionViewModelRuntimeId'), 'runtime-z');
  });
});
