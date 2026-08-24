import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  managedAgents,
  computeProcessGroupKey,
  findSharedProcessRuntime,
  listRuntimesByProcess,
  isManagedRuntimeRunning,
} from '../server/shared/agent-access.js';
import { sendIPCToRuntime } from '../server/shared/ipc.js';

// ── Helpers ────────────────────────────────────────────────

function createFakeProcess(pid) {
  return { pid, exitCode: null, signalCode: null };
}

function createRuntime(overrides = {}) {
  return {
    key: 'test::session',
    agentId: 'test',
    id: 'test',
    process: createFakeProcess(1000),
    startedAt: new Date().toISOString(),
    exitCode: null,
    stopped: false,
    viewerAgentId: 'agent-1-1000',
    selectedSessionId: 'session-1',
    ready: true,
    processGroupKey: null,
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────

describe('computeProcessGroupKey', () => {
  it('returns null for empty projectDir', () => {
    assert.equal(computeProcessGroupKey('agent-1', ''), null);
    assert.equal(computeProcessGroupKey('agent-1', null), null);
    assert.equal(computeProcessGroupKey('agent-1', undefined), null);
    assert.equal(computeProcessGroupKey('agent-1', '  '), null);
  });

  it('normalizes backslashes and case', () => {
    const key1 = computeProcessGroupKey('agent-1', 'D:\\Code\\Project');
    const key2 = computeProcessGroupKey('agent-1', 'd:/code/project');
    if (process.platform === 'win32') {
      assert.equal(key1, key2);
    } else {
      assert.notEqual(key1, key2);
    }
  });

  it('produces different keys for different agents', () => {
    const key1 = computeProcessGroupKey('agent-1', '/proj');
    const key2 = computeProcessGroupKey('agent-2', '/proj');
    assert.notEqual(key1, key2);
  });

  it('produces different keys for different projects', () => {
    const key1 = computeProcessGroupKey('agent-1', '/proj-a');
    const key2 = computeProcessGroupKey('agent-1', '/proj-b');
    assert.notEqual(key1, key2);
  });

  it('includes agentId and normalized path in the key', () => {
    const key = computeProcessGroupKey('ph', 'D:\\Code\\MyProject');
    assert.ok(key.startsWith('ph::'));
    if (process.platform === 'win32') {
      // Windows folds drive-letter path casing
      assert.ok(key.includes('d:/code/myproject'));
    } else {
      // Non-Windows keeps original casing (see computeProcessGroupKey impl)
      assert.ok(key.includes('D:/Code/MyProject'));
    }
  });

  it('handles trailing slashes consistently', () => {
    const key1 = computeProcessGroupKey('a', '/proj');
    const key2 = computeProcessGroupKey('a', '/proj/');
    assert.equal(key1, key2);
  });

  it('splits process groups by non-main sessionType within one agent', () => {
    const main = computeProcessGroupKey('programming-helper', '/proj');
    const coder = computeProcessGroupKey('programming-helper', '/proj', 'shared-by-project', 'coder');
    const mainExplicit = computeProcessGroupKey('programming-helper', '/proj', 'shared-by-project', 'main');
    const mainNull = computeProcessGroupKey('programming-helper', '/proj', 'shared-by-project', null);
    assert.notEqual(main, coder);
    assert.equal(main, mainExplicit);
    assert.equal(main, mainNull);
  });

  it('uses one stable key for shared-global across different projects', () => {
    const keyA = computeProcessGroupKey('programming-helper', 'D:/code/project-a', 'shared-global');
    const keyB = computeProcessGroupKey('programming-helper', 'D:/code/project-b', 'shared-global');
    assert.equal(keyA, 'programming-helper::__global__');
    assert.equal(keyA, keyB);
  });

  it('still requires an explicit project directory for shared-global', () => {
    assert.equal(computeProcessGroupKey('programming-helper', '', 'shared-global'), null);
    assert.equal(computeProcessGroupKey('programming-helper', null, 'shared-global'), null);
  });
});

describe('findSharedProcessRuntime', () => {
  beforeEach(() => {
    managedAgents.clear();
  });

  it('returns null when processGroupKey is null', () => {
    assert.equal(findSharedProcessRuntime(null), null);
  });

  it('returns null when no matching runtime exists', () => {
    assert.equal(findSharedProcessRuntime('agent-1::/proj'), null);
  });

  it('finds a running runtime with matching group key', () => {
    const rt = createRuntime({
      key: 'a::s1',
      agentId: 'a',
      processGroupKey: 'a::/proj',
    });
    managedAgents.set(rt.key, rt);

    const found = findSharedProcessRuntime('a::/proj');
    assert.equal(found, rt);
  });

  it('skips stopped runtimes', () => {
    const rt = createRuntime({
      key: 'a::s1',
      agentId: 'a',
      processGroupKey: 'a::/proj',
      stopped: true,
    });
    managedAgents.set(rt.key, rt);

    assert.equal(findSharedProcessRuntime('a::/proj'), null);
  });

  it('skips runtimes with exited process', () => {
    const proc = createFakeProcess(1000);
    proc.exitCode = 1;
    const rt = createRuntime({
      key: 'a::s1',
      agentId: 'a',
      processGroupKey: 'a::/proj',
      process: proc,
    });
    managedAgents.set(rt.key, rt);

    assert.equal(findSharedProcessRuntime('a::/proj'), null);
  });

  it('finds a shared-global runtime regardless of another session project', () => {
    const rt = createRuntime({
      key: 'programming-helper::project-a-session',
      agentId: 'programming-helper',
      processGroupKey: 'programming-helper::__global__',
    });
    managedAgents.set(rt.key, rt);

    assert.equal(findSharedProcessRuntime('programming-helper::__global__'), rt);
  });

  it('finds runtime among multiple entries', () => {
    const rt1 = createRuntime({
      key: 'a::s1',
      agentId: 'a',
      processGroupKey: 'a::/proj-a',
      process: createFakeProcess(1001),
    });
    const rt2 = createRuntime({
      key: 'a::s2',
      agentId: 'a',
      processGroupKey: 'a::/proj-b',
      process: createFakeProcess(1002),
    });
    managedAgents.set(rt1.key, rt1);
    managedAgents.set(rt2.key, rt2);

    assert.equal(findSharedProcessRuntime('a::/proj-b'), rt2);
  });
});

describe('listRuntimesByProcess', () => {
  beforeEach(() => {
    managedAgents.clear();
  });

  it('returns empty array for null process', () => {
    assert.deepEqual(listRuntimesByProcess(null), []);
  });

  it('finds single runtime by process reference', () => {
    const proc = createFakeProcess(5000);
    const rt = createRuntime({
      key: 'a::s1',
      process: proc,
    });
    managedAgents.set(rt.key, rt);

    const found = listRuntimesByProcess(proc);
    assert.equal(found.length, 1);
    assert.equal(found[0], rt);
  });

  it('finds multiple runtimes sharing the same process', () => {
    const proc = createFakeProcess(5000);
    const rt1 = createRuntime({
      key: 'a::s1',
      agentId: 'a',
      selectedSessionId: 's1',
      process: proc,
    });
    const rt2 = createRuntime({
      key: 'a::s2',
      agentId: 'a',
      selectedSessionId: 's2',
      process: proc,
      viewerAgentId: 'agent-2-5000',
    });
    managedAgents.set(rt1.key, rt1);
    managedAgents.set(rt2.key, rt2);

    const found = listRuntimesByProcess(proc);
    assert.equal(found.length, 2);
    assert.ok(found.includes(rt1));
    assert.ok(found.includes(rt2));
  });

  it('excludes runtimes with different process', () => {
    const proc1 = createFakeProcess(5000);
    const proc2 = createFakeProcess(6000);
    const rt1 = createRuntime({ key: 'a::s1', process: proc1 });
    const rt2 = createRuntime({ key: 'a::s2', process: proc2 });
    managedAgents.set(rt1.key, rt1);
    managedAgents.set(rt2.key, rt2);

    assert.equal(listRuntimesByProcess(proc1).length, 1);
    assert.equal(listRuntimesByProcess(proc2).length, 1);
  });
});

describe('isManagedRuntimeRunning with shared process', () => {
  it('returns true for shared runtime with running process', () => {
    const proc = createFakeProcess(7000);
    const rt = createRuntime({
      process: proc,
      processGroupKey: 'a::/proj',
    });
    assert.equal(isManagedRuntimeRunning(rt), true);
  });

  it('returns false when shared process has exited', () => {
    const proc = createFakeProcess(7000);
    proc.exitCode = 1;
    const rt = createRuntime({
      process: proc,
      processGroupKey: 'a::/proj',
    });
    assert.equal(isManagedRuntimeRunning(rt), false);
  });

  it('returns false while a shared session is disposing without stopping siblings', () => {
    const rt = createRuntime({
      processGroupKey: 'a::/proj',
      stopping: true,
    });
    assert.equal(isManagedRuntimeRunning(rt), false);
  });
});

describe('sendIPCToRuntime', () => {
  it('attaches the runtime session id before sending to a shared child', () => {
    const child = new EventEmitter();
    child.exitCode = null;
    let sent = null;
    child.send = (message) => { sent = message; };
    const runtime = createRuntime({ process: child, selectedSessionId: 'session-B' });

    assert.equal(sendIPCToRuntime(runtime, { type: 'swap-model', presetName: 'fast' }), true);
    assert.deepEqual(sent, {
      type: 'swap-model',
      presetName: 'fast',
      __targetSessionId: 'session-B',
    });
  });
});
