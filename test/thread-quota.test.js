// ADR-0027 修订一：per-workspace 线程配额（非终态线程计数 + 建线入口拦截）。
// 与初版 runtime-quota（存活进程计数 + spawn 漏斗拦截）的差异见 ADR-0027 修订记录。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  resolveThreadQuotaLimit,
  createThreadQuotaExceededError,
  countNonTerminalThreads,
  countNonTerminalThreadsByAgent,
  assertThreadQuotaAllowed,
} from '../server/routes/thread-quota.js';
import { buildLocalFailureResponse, LocalOperationError } from '../server/shared/operation-contract.js';
import { PERMISSION_ITEMS } from '../server/shared/permission-registry.js';
import { writeWorkspacePermissionValue } from '../server/routes/workspace-settings.js';

// 线程控制面替身：计数只消费 core.listThreads（真实 core 按 agentId 过滤，
// 替身保持同一契约）与 archive.list（归档索引），无需看板数据。
function makeControl(threads, archivedIds = []) {
  return {
    core: {
      listThreads: async ({ agentId } = {}) => (
        agentId ? threads.filter((thread) => thread.agentId === agentId) : threads
      ),
    },
    archive: { list: async () => Object.fromEntries(archivedIds.map((id) => [id, { archivedAt: 1 }])) },
  };
}

const T = (threadId, agentId, status = 'open') => ({ threadId, agentId, status });

describe('permission item: maxLiveThreads', () => {
  it('is registered as positive-integer and replaces maxLiveRuntimes', () => {
    assert.equal(PERMISSION_ITEMS.maxLiveThreads?.valueType, 'positive-integer');
    assert.equal(PERMISSION_ITEMS.maxLiveThreads.validate(3), true);
    assert.equal(PERMISSION_ITEMS.maxLiveThreads.validate(0), false);
    assert.equal(PERMISSION_ITEMS.maxLiveThreads.validate(true), false);
    assert.equal('maxLiveRuntimes' in PERMISSION_ITEMS, false);
  });
});

describe('resolveThreadQuotaLimit', () => {
  it('returns positive integers, null otherwise', () => {
    assert.equal(resolveThreadQuotaLimit({ maxLiveThreads: 3 }), 3);
    assert.equal(resolveThreadQuotaLimit({}), null);
    assert.equal(resolveThreadQuotaLimit(undefined), null);
    assert.equal(resolveThreadQuotaLimit({ maxLiveThreads: 0 }), null);
    assert.equal(resolveThreadQuotaLimit({ maxLiveThreads: -1 }), null);
    assert.equal(resolveThreadQuotaLimit({ maxLiveThreads: '3' }), null);
  });
  it('ignores the retired maxLiveRuntimes key', () => {
    assert.equal(resolveThreadQuotaLimit({ maxLiveRuntimes: 2 }), null);
  });
});

describe('countNonTerminalThreads', () => {
  it('counts open threads regardless of activity (idle included), excludes closed and archived', async () => {
    const control = makeControl(
      [T('wt-1', 'coder'), T('wt-2', 'coder'), T('wt-3', 'coder'), T('wt-4', 'coder', 'closed')],
      ['wt-2'],
    );
    // wt-1 idle 计数；wt-2 已归档不计；wt-3 计数；wt-4 closed 不计。
    assert.equal(await countNonTerminalThreads(control, 'coder'), 2);
  });

  it('filters by agentId and tolerates missing threads', async () => {
    const control = makeControl([T('wt-1', 'coder'), T('wt-2', 'memo')]);
    assert.equal(await countNonTerminalThreads(control, 'memo'), 1);
    assert.equal(await countNonTerminalThreads(control, 'programming-helper'), 0);
  });
});

describe('countNonTerminalThreadsByAgent', () => {
  it('projects per-agent non-terminal counts, skipping terminal and unattributed threads', async () => {
    const control = makeControl(
      [
        T('wt-1', 'coder'), T('wt-2', 'coder'), T('wt-3', 'coder', 'closed'),
        T('wt-4', 'memo'), T('wt-5', ''),
      ],
      ['wt-2'],
    );
    assert.deepEqual(await countNonTerminalThreadsByAgent(control), { coder: 1, memo: 1 });
  });
});

describe('assertThreadQuotaAllowed', () => {
  it('passes when the workspace does not declare the permission (no settings read)', async () => {
    // control 缺失也不被触碰：未声明 = 不治理，热路径零额外行为。
    await assert.doesNotReject(assertThreadQuotaAllowed({
      agentId: 'coder', permissions: [], control: undefined,
    }));
  });

  it('passes when unconfigured (default unlimited)', async () => {
    const control = makeControl([T('wt-1', 'coder'), T('wt-2', 'coder')]);
    await assert.doesNotReject(assertThreadQuotaAllowed({
      agentId: 'coder', permissions: ['maxLiveThreads'], control,
    }));
  });

  it('passes below the limit, rejects at the limit with structured 429 payload', async () => {
    const low = await writePolicy({ coder: { maxLiveThreads: 2 } });
    const control = makeControl([T('wt-1', 'coder')]);
    const full = makeControl([T('wt-1', 'coder'), T('wt-2', 'coder')]);
    try {
      await assert.doesNotReject(assertThreadQuotaAllowed({
        agentId: 'coder', permissions: ['maxLiveThreads'], control, settingsPath: low.settingsPath,
      }));
      await assert.rejects(
        assertThreadQuotaAllowed({
          agentId: 'coder', permissions: ['maxLiveThreads'], control: full, settingsPath: low.settingsPath,
        }),
        (error) => {
          assert.equal(error.code, 'thread_quota_exceeded');
          assert.equal(error.status, 429);
          assert.deepEqual(error.threadQuota, {
            agentId: 'coder', limit: 2, liveThreads: 2,
            actions: ['archive_thread', 'raise_quota', 'abandon'],
          });
          return true;
        },
      );
    } finally {
      await low.cleanup();
    }
  });

  it('passes when the configured value is invalid (treated as unlimited)', async () => {
    const bad = await writePolicy({ coder: { maxLiveThreads: 0 } });
    const control = makeControl([T('wt-1', 'coder')]);
    try {
      await assert.doesNotReject(assertThreadQuotaAllowed({
        agentId: 'coder', permissions: ['maxLiveThreads'], control, settingsPath: bad.settingsPath,
      }));
    } finally {
      await bad.cleanup();
    }
  });

  it('pass below limit uses the settings file written by the permission API', async () => {
    // 端到端最小链：writeWorkspacePermissionValue 落盘 → assertThreadQuotaAllowed 读取。
    const dir = await mkdtemp(path.join(tmpdir(), 'thread-quota-'));
    try {
      const settingsPath = path.join(dir, 'workspace-settings.json');
      await writeWorkspacePermissionValue('coder', 'maxLiveThreads', 2, { settingsPath });
      const control = makeControl([T('wt-1', 'coder')]);
      await assert.doesNotReject(assertThreadQuotaAllowed({
        agentId: 'coder', permissions: ['maxLiveThreads'], control, settingsPath,
      }));
      const full = makeControl([T('wt-1', 'coder'), T('wt-2', 'coder')]);
      await assert.rejects(
        assertThreadQuotaAllowed({
          agentId: 'coder', permissions: ['maxLiveThreads'], control: full, settingsPath,
        }),
        (error) => error.code === 'thread_quota_exceeded',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('buildLocalFailureResponse threadQuota passthrough', () => {
  it('normalizes code to operation_rejected and passes through the structured payload', () => {
    const error = createThreadQuotaExceededError({ agentId: 'coder', limit: 2, liveThreads: 2 });
    const response = buildLocalFailureResponse(error);
    assert.equal(response.code, 'operation_rejected');
    assert.equal(response.legacyCode, 'thread_quota_exceeded');
    assert.equal(response.retryable, false);
    assert.deepEqual(response.threadQuota, {
      agentId: 'coder', limit: 2, liveThreads: 2,
      actions: ['archive_thread', 'raise_quota', 'abandon'],
    });
  });

  it('omits threadQuota for errors without the payload', () => {
    const response = buildLocalFailureResponse(new LocalOperationError('nope', { code: 'invalid_input', status: 400 }));
    assert.equal('threadQuota' in response, false);
  });
});

/** 写 resourcePolicy 临时设置文件，返回 { settingsPath, cleanup }；用例 finally 清理。 */
async function writePolicy(policies) {
  const dir = await mkdtemp(path.join(tmpdir(), 'thread-quota-'));
  const settingsPath = path.join(dir, 'workspace-settings.json');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(settingsPath, JSON.stringify({ resourcePolicy: policies }), 'utf8');
  return { settingsPath, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
