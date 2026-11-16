// ADR-0027：maxLiveThreads 限制同时运行的 Coder runtime 进程数。
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  resolveRuntimeQuotaLimit,
  createRuntimeQuotaExceededError,
  acquireRuntimeSpawnSlot,
  countLiveRuntimesByAgent,
  countLiveRuntimesByAgentMap,
} from '../server/routes/runtime-quota.js';
import { buildLocalFailureResponse, LocalOperationError } from '../server/shared/operation-contract.js';
import { PERMISSION_ITEMS } from '../server/shared/permission-registry.js';
import { managedAgents } from '../server/shared/agent-access.js';

const processOf = (pid) => ({ pid, exitCode: null, signalCode: null });

function installRuntime(key, agentId, process, extra = {}) {
  managedAgents.set(key, {
    key,
    agentId,
    id: agentId,
    process,
    stopped: false,
    stopping: false,
    ...extra,
  });
}

async function withSettings(resourcePolicy, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'runtime-quota-'));
  const settingsPath = path.join(dir, 'workspace-settings.json');
  await writeFile(settingsPath, JSON.stringify({ resourcePolicy }), 'utf8');
  try {
    return await fn(settingsPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

beforeEach(() => {
  managedAgents.clear();
});

describe('permission item: maxLiveThreads', () => {
  it('remains a positive-integer permission and replaces maxLiveRuntimes', () => {
    assert.equal(PERMISSION_ITEMS.maxLiveThreads?.valueType, 'positive-integer');
    assert.equal(PERMISSION_ITEMS.maxLiveThreads.validate(3), true);
    assert.equal(PERMISSION_ITEMS.maxLiveThreads.validate(0), false);
    assert.equal(PERMISSION_ITEMS.maxLiveThreads.validate(true), false);
    assert.equal('maxLiveRuntimes' in PERMISSION_ITEMS, false);
  });
});

describe('resolveRuntimeQuotaLimit', () => {
  it('accepts only positive integer maxLiveThreads values', () => {
    assert.equal(resolveRuntimeQuotaLimit({ maxLiveThreads: 3 }), 3);
    assert.equal(resolveRuntimeQuotaLimit({}), null);
    assert.equal(resolveRuntimeQuotaLimit(undefined), null);
    assert.equal(resolveRuntimeQuotaLimit({ maxLiveThreads: 0 }), null);
    assert.equal(resolveRuntimeQuotaLimit({ maxLiveThreads: '3' }), null);
    assert.equal(resolveRuntimeQuotaLimit({ maxLiveRuntimes: 2 }), null);
  });
});

describe('countLiveRuntimesByAgent', () => {
  it('counts running processes once when several sessions share one runtime', () => {
    const shared = processOf(101);
    installRuntime('coder::session-a', 'coder', shared);
    installRuntime('coder::session-b', 'coder', shared);
    installRuntime('coder::session-c', 'coder', processOf(102));
    installRuntime('coder::stopped', 'coder', { pid: 103, exitCode: 0, signalCode: null });
    installRuntime('memo::session-a', 'memo', processOf(104));

    assert.equal(countLiveRuntimesByAgent('coder'), 2);
    assert.deepEqual(countLiveRuntimesByAgentMap(), { coder: 2, memo: 1 });
  });

  it('does not count stopped runtime entries left after a thread is archived', () => {
    installRuntime('coder::archived', 'coder', { pid: 105, exitCode: null, signalCode: null }, { stopped: true });
    assert.equal(countLiveRuntimesByAgent('coder'), 0);
  });
});

describe('acquireRuntimeSpawnSlot', () => {
  it('allows a spawn when idle or archived thread records are irrelevant', async () => {
    installRuntime('coder::running', 'coder', processOf(201));
    await withSettings({ coder: { maxLiveThreads: 2 } }, async (settingsPath) => {
      const release = await acquireRuntimeSpawnSlot({
        agentId: 'coder',
        permissions: ['maxLiveThreads'],
        settingsPath,
      });
      assert.equal(typeof release, 'function');
      release();
    });
  });

  it('rejects only a new runtime when the running process count reaches the limit', async () => {
    installRuntime('coder::running-a', 'coder', processOf(202));
    installRuntime('coder::running-b', 'coder', processOf(203));
    await withSettings({ coder: { maxLiveThreads: 2 } }, async (settingsPath) => {
      await assert.rejects(
        acquireRuntimeSpawnSlot({ agentId: 'coder', permissions: ['maxLiveThreads'], settingsPath }),
        (error) => {
          assert.equal(error.code, 'runtime_quota_exceeded');
          assert.equal(error.status, 429);
          assert.deepEqual(error.runtimeQuota, {
            agentId: 'coder',
            limit: 2,
            liveRuntimes: 2,
            actions: ['wait_for_runtime', 'raise_quota', 'abandon'],
          });
          return true;
        },
      );
    });
  });

  it('reserves concurrent spawn slots and releases a failed or completed reservation', async () => {
    await withSettings({ coder: { maxLiveThreads: 1 } }, async (settingsPath) => {
      const release = await acquireRuntimeSpawnSlot({
        agentId: 'coder',
        permissions: ['maxLiveThreads'],
        settingsPath,
      });
      await assert.rejects(
        acquireRuntimeSpawnSlot({ agentId: 'coder', permissions: ['maxLiveThreads'], settingsPath }),
        (error) => error.code === 'runtime_quota_exceeded',
      );
      release();
      const nextRelease = await acquireRuntimeSpawnSlot({
        agentId: 'coder',
        permissions: ['maxLiveThreads'],
        settingsPath,
      });
      nextRelease();
    });
  });

  it('does not enforce an undeclared or unlimited permission', async () => {
    await withSettings({ coder: { maxLiveThreads: 1 } }, async (settingsPath) => {
      assert.equal(await acquireRuntimeSpawnSlot({ agentId: 'coder', permissions: [], settingsPath }), null);
    });
    await withSettings({}, async (settingsPath) => {
      assert.equal(await acquireRuntimeSpawnSlot({ agentId: 'coder', permissions: ['maxLiveThreads'], settingsPath }), null);
    });
  });
});

describe('buildLocalFailureResponse runtimeQuota passthrough', () => {
  it('passes the structured runtime quota payload through the operation contract', () => {
    const error = createRuntimeQuotaExceededError({ agentId: 'coder', limit: 2, liveRuntimes: 2 });
    const response = buildLocalFailureResponse(error);
    assert.equal(response.code, 'operation_rejected');
    assert.equal(response.legacyCode, 'runtime_quota_exceeded');
    assert.equal(response.retryable, false);
    assert.deepEqual(response.runtimeQuota, {
      agentId: 'coder',
      limit: 2,
      liveRuntimes: 2,
      actions: ['wait_for_runtime', 'raise_quota', 'abandon'],
    });
  });

  it('omits runtimeQuota for unrelated errors', () => {
    const response = buildLocalFailureResponse(new LocalOperationError('nope', { code: 'invalid_input', status: 400 }));
    assert.equal('runtimeQuota' in response, false);
  });
});
