import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { loadModuleOnce } from './helpers/esm-module-loader.js';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const KERNEL_STATE_SOURCE = fs.readFileSync(
  path.join(ROOT, 'public/src/modules/kernel-state.js'),
  'utf8',
);
const MODULE_PATH = 'public/src/modules/session-view-storage.js';
const OVERVIEW_DATA_SOURCE = fs.readFileSync(
  path.join(ROOT, 'public/src/modules/overview-data.js'),
  'utf8',
);
const TODO_PLAN_SOURCE = fs.readFileSync(
  path.join(ROOT, 'public/src/modules/todo-plan.js'),
  'utf8',
);

const initial = () => ({
  currentMessages: [{ role: 'assistant', content: 'early' }],
  currentInputRequests: [{ id: 'early-input' }],
  toolRenderConfigs: { shell: { color: 'blue' } },
  TOOL_NAMES: { shell: 'Shell' },
  currentHookInspector: { lifecycleOrder: ['early'], features: [], hooks: [] },
  currentHookInspectorSignature: 'hook-early',
  currentOverviewSnapshot: { status: 'early' },
  currentOverviewSignature: 'overview-early',
  currentTodoPlan: { items: [{ id: 'early-todo' }] },
  currentTodoPlanSignature: 'todo-early',
});

function createKernelWindow(values = initial()) {
  const window = { console };
  window.window = window;
  window.document = { getElementById() { return null; } };
  window.featurePanelBody = { addEventListener() {} };
  window.selectedFeatureName = null;
  window.normalizeSessionModelState = () => ({});
  vm.createContext(window);
  vm.runInContext(KERNEL_STATE_SOURCE, window, { filename: 'kernel-state.js' });
  for (const [key, value] of Object.entries(values)) {
    window.KernelState.defineKey('session-view-storage', key, value);
  }
  return window;
}

function loadClassicSetters(window) {
  vm.runInContext(OVERVIEW_DATA_SOURCE, window, { filename: 'overview-data.js' });
  vm.runInContext(TODO_PLAN_SOURCE, window, { filename: 'todo-plan.js' });
}

async function loadOwner(window) {
  const previousWindow = globalThis.window;
  globalThis.window = window;
  try {
    return await loadModuleOnce(MODULE_PATH, { installGlobals: false });
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
}

test('real session patch preserves early data through claim and rejects stale commits afterward', async () => {
  const ctx = createFrontendSandbox();
  ctx.loadSource('public/src/app-core.js');
  ctx.loadSource('public/src/modules/session-view-state.js');
  ctx.run("currentRuntimeAgentId = 'runtime-a'; focusedAgentId = 'agent-a'; currentRuntimeConnected = true;");
  const messages = [{ role: 'user', content: 'before claim' }];
  ctx.earlyMessages = messages;
  ctx.run('applySessionViewPatch({ messages: earlyMessages });');
  const { module, cleanup } = await loadOwner(ctx);
  try {
    assert.strictEqual(module.currentMessages, messages);
    const token = ctx.run('captureSessionViewToken()');
    ctx.oldToken = token;
    ctx.nextMessages = [{ role: 'assistant', content: 'after claim' }];
    assert.equal(ctx.run('commitSessionViewPatch(oldToken, { messages: nextMessages })'), true);
    assert.strictEqual(module.currentMessages, ctx.nextMessages);
    ctx.run("currentRuntimeAgentId = 'runtime-b'; _switchEpoch += 1;");
    assert.equal(ctx.run("commitSessionViewPatch(oldToken, { messages: [{ content: 'stale' }] })"), false);
    assert.strictEqual(module.currentMessages, ctx.nextMessages, 'a stale response cannot overwrite the new transcript');
  } finally {
    cleanup();
  }
});

test('session-view-storage claim absorbs pre-claim values without copying or losing references', async () => {
  const expected = initial();
  const window = createKernelWindow(expected);
  const beforeClaim = {
    currentMessages: [{ role: 'user', content: 'written before claim' }],
    currentInputRequests: [{ id: 'written-before-claim' }],
  };
  window.currentMessages = beforeClaim.currentMessages;
  window.currentInputRequests = beforeClaim.currentInputRequests;
  expected.currentMessages = beforeClaim.currentMessages;
  expected.currentInputRequests = beforeClaim.currentInputRequests;

  const { module, cleanup } = await loadOwner(window);
  try {
    for (const [key, value] of Object.entries(expected)) {
      assert.strictEqual(module[key], value, `${key} keeps its initial reference/value`);
      assert.strictEqual(window[key], value, `${key} window accessor reads the claimed value`);
    }
    assert.strictEqual(module.currentMessages, beforeClaim.currentMessages);
    assert.strictEqual(module.currentInputRequests, beforeClaim.currentInputRequests);

    module.currentMessages.push({ role: 'assistant', content: 'in-place mutation' });
    assert.strictEqual(window.currentMessages, module.currentMessages);
    assert.equal(window.currentMessages[1].content, 'in-place mutation');
  } finally {
    cleanup();
  }
});

test('session-view-storage named live bindings and classic accessors stay bidirectional after claim', async () => {
  const window = createKernelWindow();
  const { module, cleanup } = await loadOwner(window);
  try {
    const classicMessages = [{ role: 'user', content: 'classic replacement' }];
    window.currentMessages = classicMessages;
    assert.strictEqual(module.currentMessages, classicMessages);

    const esmInputRequests = [{ id: 'esm replacement' }];
    module.setCurrentInputRequests(esmInputRequests);
    assert.strictEqual(window.currentInputRequests, esmInputRequests);
    assert.strictEqual(module.currentInputRequests, esmInputRequests);

    for (const key of Object.keys(initial())) {
      assert.ok(Object.prototype.hasOwnProperty.call(module, key), `${key} is a named export`);
    }
  } finally {
    cleanup();
  }
});

test('storage bridge and real classic setters keep overview/todo snapshot-signature pairs across claim', async () => {
  const window = createKernelWindow();
  loadClassicSetters(window);

  // Real classic setters can write before the ESM owner claims their storage.
  window.setCurrentHookInspector({ features: [{ name: 'before-claim-hook' }] });
  window.setCurrentOverviewSnapshot({ updatedAt: 11, context: { messageCount: 4 } });
  window.setCurrentTodoPlan({ tasks: [{ id: 'before-claim-todo', status: 'pending' }] });
  const beforeClaim = {
    hook: window.currentHookInspector,
    hookSignature: window.currentHookInspectorSignature,
    overview: window.currentOverviewSnapshot,
    overviewSignature: window.currentOverviewSignature,
    todo: window.currentTodoPlan,
    todoSignature: window.currentTodoPlanSignature,
  };
  assert.ok(beforeClaim.hookSignature);
  assert.ok(beforeClaim.overviewSignature);
  assert.ok(beforeClaim.todoSignature);

  const { module, cleanup } = await loadOwner(window);
  try {
    assert.strictEqual(module.currentHookInspector, beforeClaim.hook);
    assert.equal(module.currentHookInspectorSignature, beforeClaim.hookSignature);
    assert.strictEqual(module.currentOverviewSnapshot, beforeClaim.overview);
    assert.equal(module.currentOverviewSignature, beforeClaim.overviewSignature);
    assert.strictEqual(module.currentTodoPlan, beforeClaim.todo);
    assert.equal(module.currentTodoPlanSignature, beforeClaim.todoSignature);

    // Invoke those same real classic setters after claim; each must update both
    // halves of its pair in the ESM-owned storage, not a shadow binding.
    window.setCurrentHookInspector({ features: [{ name: 'after-claim-hook' }] });
    window.setCurrentOverviewSnapshot({ updatedAt: 22, context: { messageCount: 9 } });
    window.setCurrentTodoPlan({ tasks: [{ id: 'after-claim-todo', status: 'completed' }] });

    assert.equal(module.currentHookInspector.features[0].name, 'after-claim-hook');
    assert.ok(module.currentHookInspectorSignature);
    assert.notEqual(module.currentHookInspectorSignature, beforeClaim.hookSignature);
    assert.equal(window.currentHookInspectorSignature, module.currentHookInspectorSignature);

    assert.equal(module.currentOverviewSnapshot.updatedAt, 22);
    assert.equal(module.currentOverviewSnapshot.context.messageCount, 9);
    assert.ok(module.currentOverviewSignature);
    assert.notEqual(module.currentOverviewSignature, beforeClaim.overviewSignature);
    assert.equal(window.currentOverviewSignature, module.currentOverviewSignature);

    assert.equal(module.currentTodoPlan.tasks[0].id, 'after-claim-todo');
    assert.ok(module.currentTodoPlanSignature);
    assert.notEqual(module.currentTodoPlanSignature, beforeClaim.todoSignature);
    assert.equal(window.currentTodoPlanSignature, module.currentTodoPlanSignature);
  } finally {
    cleanup();
  }
});
