/**
 * Tests for isRuntimeItemActive — sidebar runtime highlight predicate.
 *
 * Bug (fixed): when a workspace surface is selected, selectWorkspaceSurface()
 * clears currentRuntimeAgentId (null). The fallback comparison in
 * isRuntimeItemActive then evaluated normalizeAgentIdentity(undefined) === ''
 * against the empty current id, which is symmetrically true for every LOCAL
 * runtime (resolveRuntimeRef misses → null → ''), so all running local
 * sessions rendered with the 'active' class.
 *
 * The fix returns false early when nothing is selected as a runtime and
 * requires resolveRuntimeRef to actually hit (truthy) before the fallback
 * comparison.
 *
 * Loads the real normalizeAgentIdentity and isRuntimeItemActive sources from
 * app-main.js into a vm sandbox, mirroring the harness style of
 * frontend-chat-scroll-restore.test.js.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const mainSource = fs.readFileSync(new URL('../public/src/app-main.js', import.meta.url), 'utf8');

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `${startMarker} marker should exist`);
  assert.notEqual(end, -1, `${endMarker} marker should exist`);
  return source.slice(start, end);
}

function createHarness({
  currentRuntimeAgentId = null,
  focusedAgentId = null,
  resolveRuntimeRef = null,
  getActiveThreadInputTarget = null,
} = {}) {
  const normalizeSource = sourceBetween(
    mainSource,
    'function normalizeAgentIdentity(value) {',
    'function getCurrentHostAgentRecord',
  );
  const activeSource = sourceBetween(
    mainSource,
    'function isRuntimeItemActive(runtimeId, entry = null) {',
    'function toEpochMs(value) {',
  );
  const agentActiveSource = sourceBetween(
    mainSource,
    'function isAgentActive(agent) {',
    'function getCurrentAgentRecord() {',
  );
  const sandbox = {
    currentRuntimeAgentId,
    focusedAgentId,
    window: {
      ...(resolveRuntimeRef ? { RemoteConnections: { resolveRuntimeRef } } : {}),
      ...(getActiveThreadInputTarget ? { getActiveThreadInputTarget } : {}),
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${normalizeSource}\n${agentActiveSource}\n${activeSource}`, sandbox);
  return sandbox;
}

test('workspace surface selected (no runtime) → no local runtime highlights', () => {
  // resolveRuntimeRef misses for local ids, returning null.
  const { isRuntimeItemActive } = createHarness({ currentRuntimeAgentId: null });
  assert.equal(isRuntimeItemActive('ph-1-1740000000001'), false);
  assert.equal(isRuntimeItemActive('qqbot-1-1740000000002'), false);
});

test('workspace surface selected → no remote runtime highlights either', () => {
  const { isRuntimeItemActive } = createHarness({
    currentRuntimeAgentId: null,
    resolveRuntimeRef: (id) => (id === 'remote:lab-b:rt-1' ? 'remote:lab-b:rt-1' : null),
  });
  assert.equal(isRuntimeItemActive('remote:lab-b:rt-1'), false);
  assert.equal(isRuntimeItemActive('ph-1-1740000000001'), false);
});

test('selected local runtime highlights itself only', () => {
  const { isRuntimeItemActive } = createHarness({ currentRuntimeAgentId: 'ph-1-1740000000001' });
  assert.equal(isRuntimeItemActive('ph-1-1740000000001'), true);
  assert.equal(isRuntimeItemActive('ph-1-1740000000002'), false);
  assert.equal(isRuntimeItemActive('remote:lab-b:rt-1'), false);
});

test('selected remote runtime resolves through the remote catalog', () => {
  const { isRuntimeItemActive } = createHarness({
    currentRuntimeAgentId: 'remote:lab-b:rt-1',
    resolveRuntimeRef: (id) => (id === 'remote:lab-b:rt-1' ? 'remote:lab-b:rt-1' : null),
  });
  assert.equal(isRuntimeItemActive('remote:lab-b:rt-1'), true);
  assert.equal(isRuntimeItemActive('ph-1-1740000000001'), false);
});

test('empty runtimeId never highlights regardless of selection', () => {
  const { isRuntimeItemActive } = createHarness({ currentRuntimeAgentId: 'ph-1-1740000000001' });
  assert.equal(isRuntimeItemActive(''), false);
  assert.equal(isRuntimeItemActive(undefined), false);
  assert.equal(isRuntimeItemActive(null), false);
});

// ── 接续等待表面（ADR-0026）：无 runtime 态下按会话身份高亮 ──────────────
// 点击接续占位条目 / 接续退役窗口后 currentRuntimeAgentId 为空，视图身份
// 挂在等待会话上（getActiveThreadInputTarget 的一致性校验形态）。

test('await surface: placeholder entry of the awaited session highlights', () => {
  const { isRuntimeItemActive } = createHarness({
    currentRuntimeAgentId: null,
    getActiveThreadInputTarget: () => ({ threadId: 'wt-1', agentId: 'coder', sessionId: 'session-await-1' }),
  });
  // 占位条目（thread-relay）：runtimeId 是合成 thread: 前缀，sessionId 对齐。
  assert.equal(isRuntimeItemActive('thread:wt-1', {
    ownerId: 'coder', sessionId: 'session-await-1',
  }), true);
  // 缓存条目（原 head runtime 形状）同样按 sessionId 对齐。
  assert.equal(isRuntimeItemActive('coder-1-1740000000001', {
    ownerId: 'coder', sessionId: 'session-await-1',
  }), true);
});

test('await surface: other sessions and foreign-owner entries stay dark', () => {
  const { isRuntimeItemActive } = createHarness({
    currentRuntimeAgentId: null,
    getActiveThreadInputTarget: () => ({ threadId: 'wt-1', agentId: 'coder', sessionId: 'session-await-1' }),
  });
  // 同宿主、别的会话：不高亮。
  assert.equal(isRuntimeItemActive('coder-1-1740000000002', {
    ownerId: 'coder', sessionId: 'session-other',
  }), false);
  // sessionId 巧合相同但归属别的宿主（如远程条目）：不高亮。
  assert.equal(isRuntimeItemActive('remote:lab-b:rt-9', {
    ownerId: 'remote:lab-b:programming-helper', sessionId: 'session-await-1',
  }), false);
  // 无 entry（旧调用形态）：无会话身份可比，不高亮。
  assert.equal(isRuntimeItemActive('thread:wt-1'), false);
});

test('await surface: no await target (真 workspace surface) → nothing highlights', () => {
  const { isRuntimeItemActive } = createHarness({
    currentRuntimeAgentId: null,
    getActiveThreadInputTarget: () => null,
  });
  assert.equal(isRuntimeItemActive('thread:wt-1', {
    ownerId: 'coder', sessionId: 'session-await-1',
  }), false);
});

test('runtime selected: await target is not consulted', () => {
  const { isRuntimeItemActive } = createHarness({
    currentRuntimeAgentId: 'coder-1-1740000000009',
    getActiveThreadInputTarget: () => ({ threadId: 'wt-1', agentId: 'coder', sessionId: 'session-await-1' }),
  });
  // runtime 态走原比较：选中 runtime 自身高亮，等待会话条目不高亮。
  assert.equal(isRuntimeItemActive('coder-1-1740000000009', {
    ownerId: 'coder', sessionId: 'session-x',
  }), true);
  assert.equal(isRuntimeItemActive('coder-1-1740000000008', {
    ownerId: 'coder', sessionId: 'session-await-1',
  }), false);
});

test('await surface: host APP node yields to the awaited conversation entry', () => {
  // 等待表面挂载：宿主 coder APP 节点不再高亮（让位给会话条目）
  const yielding = createHarness({
    currentRuntimeAgentId: null,
    focusedAgentId: 'coder',
    getActiveThreadInputTarget: () => ({ threadId: 'wt-1', agentId: 'coder', sessionId: 'session-await-1' }),
  });
  assert.equal(yielding.isAgentActive({ id: 'coder', source: 'prebuilt' }), false);
  // 其他工作空间节点不受影响（无等待目标归属时按焦点判定）
  assert.equal(yielding.isAgentActive({ id: 'programming-helper', source: 'prebuilt' }), false);
  // 真正停在 workspace 首页（无等待会话）：宿主节点照常高亮
  const home = createHarness({
    currentRuntimeAgentId: null,
    focusedAgentId: 'coder',
    getActiveThreadInputTarget: () => null,
  });
  assert.equal(home.isAgentActive({ id: 'coder', source: 'prebuilt' }), true);
});
