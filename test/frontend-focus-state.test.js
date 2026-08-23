import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const sidebarSource = fs.readFileSync(
  new URL('../public/src/modules/sidebar-render.js', import.meta.url),
  'utf8',
);
const contextMenuSource = fs.readFileSync(
  new URL('../public/src/modules/ctx-menu-handlers.js', import.meta.url),
  'utf8',
);

function extractFunction(source, signature, nextMarker) {
  const start = source.indexOf(signature);
  const end = source.indexOf(nextMarker, start);
  assert.notEqual(start, -1, `missing function: ${signature}`);
  assert.notEqual(end, -1, `missing function end marker: ${nextMarker}`);
  return source.slice(start, end);
}

function createFocusSandbox(storage = {}) {
  const sandbox = {
    localStorage: {
      getItem(key) { return storage[key] ?? null; },
    },
    normalizeAgentIdentity: (value) => String(value || '').trim(),
    getAgentRuntimeId: (agent) => agent.runtimeId || agent.id || '',
    getRuntimeId: (agent) => agent.runtimeId || agent.runtime_session_id || agent.id || null,
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${extractFunction(sidebarSource, 'function resolveFocusedAgentAfterRefresh(', '\r\n\r\nasync function loadAgents')}`
      + `${extractFunction(contextMenuSource, 'function isDeletedAgentFocused(', '\r\n\r\ndeleteAgentAction')}`
      + '\nglobalThis.__restoreFocus = resolveFocusedAgentAfterRefresh;'
      + '\nglobalThis.__isDeletedAgentFocused = isDeletedAgentFocused;',
    sandbox,
  );
  return sandbox;
}

test('refresh restores remembered page focus when no input request has priority', () => {
  const ctx = createFocusSandbox({ 'claw:lastFocusedRuntimeId': 'runtime-b' });
  const restored = ctx.__restoreFocus([
    { id: 'host-a', runtimeId: 'runtime-a', connected: true },
    { id: 'host-b', runtimeId: 'runtime-b', connected: true },
  ]);

  assert.equal(restored.id, 'host-b');
});

test('refresh prefers a connected pending-input agent over remembered focus', () => {
  const ctx = createFocusSandbox({ 'claw:lastFocusedRuntimeId': 'runtime-b' });
  const restored = ctx.__restoreFocus([
    { id: 'host-a', runtimeId: 'runtime-a', connected: true, pendingInputCount: 1 },
    { id: 'host-b', runtimeId: 'runtime-b', connected: true },
  ]);

  assert.equal(restored.id, 'host-a');
});

test('refresh falls back to the first connected agent when remembered focus is unavailable', () => {
  const ctx = createFocusSandbox({ 'claw:lastFocusedRuntimeId': 'missing-runtime' });
  const restored = ctx.__restoreFocus([
    { id: 'stopped', runtimeId: 'runtime-stopped', connected: false },
    { id: 'host-c', runtimeId: 'runtime-c', connected: true },
  ]);

  assert.equal(restored.id, 'host-c');
});

test('deleting the focused Agent is distinguished from deleting a non-focused Agent', () => {
  const ctx = createFocusSandbox();

  assert.equal(ctx.__isDeletedAgentFocused('host-a', 'host-a', 'runtime-a'), true);
  assert.equal(ctx.__isDeletedAgentFocused('runtime-a', 'host-a', 'runtime-a'), true);
  assert.equal(ctx.__isDeletedAgentFocused('host-b', 'host-a', 'runtime-a'), false);
});
