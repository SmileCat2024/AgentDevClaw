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

function createHarness({ currentRuntimeAgentId = null, resolveRuntimeRef = null } = {}) {
  const normalizeSource = sourceBetween(
    mainSource,
    'function normalizeAgentIdentity(value) {',
    'function getCurrentHostAgentRecord',
  );
  const activeSource = sourceBetween(
    mainSource,
    'function isRuntimeItemActive(runtimeId) {',
    'function toEpochMs(value) {',
  );
  const sandbox = {
    currentRuntimeAgentId,
    window: resolveRuntimeRef
      ? { RemoteConnections: { resolveRuntimeRef } }
      : {},
  };
  vm.createContext(sandbox);
  vm.runInContext(`${normalizeSource}\n${activeSource}`, sandbox);
  return sandbox.isRuntimeItemActive;
}

test('workspace surface selected (no runtime) → no local runtime highlights', () => {
  // resolveRuntimeRef misses for local ids, returning null.
  const isRuntimeItemActive = createHarness({ currentRuntimeAgentId: null });
  assert.equal(isRuntimeItemActive('ph-1-1740000000001'), false);
  assert.equal(isRuntimeItemActive('qqbot-1-1740000000002'), false);
});

test('workspace surface selected → no remote runtime highlights either', () => {
  const isRuntimeItemActive = createHarness({
    currentRuntimeAgentId: null,
    resolveRuntimeRef: (id) => (id === 'remote:lab-b:rt-1' ? 'remote:lab-b:rt-1' : null),
  });
  assert.equal(isRuntimeItemActive('remote:lab-b:rt-1'), false);
  assert.equal(isRuntimeItemActive('ph-1-1740000000001'), false);
});

test('selected local runtime highlights itself only', () => {
  const isRuntimeItemActive = createHarness({ currentRuntimeAgentId: 'ph-1-1740000000001' });
  assert.equal(isRuntimeItemActive('ph-1-1740000000001'), true);
  assert.equal(isRuntimeItemActive('ph-1-1740000000002'), false);
  assert.equal(isRuntimeItemActive('remote:lab-b:rt-1'), false);
});

test('selected remote runtime resolves through the remote catalog', () => {
  const isRuntimeItemActive = createHarness({
    currentRuntimeAgentId: 'remote:lab-b:rt-1',
    resolveRuntimeRef: (id) => (id === 'remote:lab-b:rt-1' ? 'remote:lab-b:rt-1' : null),
  });
  assert.equal(isRuntimeItemActive('remote:lab-b:rt-1'), true);
  assert.equal(isRuntimeItemActive('ph-1-1740000000001'), false);
});

test('empty runtimeId never highlights regardless of selection', () => {
  const isRuntimeItemActive = createHarness({ currentRuntimeAgentId: 'ph-1-1740000000001' });
  assert.equal(isRuntimeItemActive(''), false);
  assert.equal(isRuntimeItemActive(undefined), false);
  assert.equal(isRuntimeItemActive(null), false);
});
