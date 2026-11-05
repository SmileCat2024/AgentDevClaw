/**
 * Tests for IM domain core data pipelines (extracted from server/routes/im.js).
 *
 * Covers 4 critical data pipelines guided by AGENT.md:
 *   1. Config normalization — data shape contract for all IM config
 *   2. Three-way exclusivity — the core routing invariant (line ↔ line ↔ portal)
 *   3. Serialized config mutation — prevents concurrent write corruption
 *   4. Token usage resolution — priority chain for routable targets
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeIMWorkspaceConfig,
  resolveLineTransferConflict,
  resolveCarrierConflicts,
  createConfigSerializer,
  getUsageContextTokens,
  findLine,
  operatorCarrierOf,
} from '../server/routes/im.js';

// ───────────────────────────────────────────────────────────────────
// Pipeline 1: Config Normalization
// ───────────────────────────────────────────────────────────────────

describe('normalizeIMWorkspaceConfig', () => {
  it('creates 5 default channels and 2 default lines from empty input', () => {
    const config = normalizeIMWorkspaceConfig();

    assert.deepEqual(Object.keys(config.channels).sort(), ['feishu', 'qq', 'rokid', 'wecom', 'weixin']);
    assert.equal(config.channels.qq.label, 'QQ');
    assert.equal(config.channels.weixin.label, '微信');
    assert.equal(config.channels.feishu.label, '飞书');
    assert.equal(config.channels.wecom.label, '企业微信');
    assert.equal(config.channels.rokid.label, 'Rokid 眼镜');
    assert.equal(config.lines.length, 2);
    // ADR-0042：selectedChannel 已并入线路模型（归一不再输出该字段）
    assert.equal(config.operatorThreadId, '');
    assert.equal(config.receptionistSessionId, '');
  });

  it('preserves existing channels and supplements missing ones', () => {
    const config = normalizeIMWorkspaceConfig({
      channels: {
        qq: { label: 'Custom QQ', note: 'main account' },
      },
    });

    assert.equal(config.channels.qq.label, 'Custom QQ');
    assert.equal(config.channels.qq.note, 'main account');
    assert.ok(config.channels.weixin);
    assert.ok(config.channels.feishu);
    assert.ok(config.channels.wecom);
  });

  it('normalizes operatorThreadId (trim) and drops legacy selectedChannel', () => {
    // ADR-0042 决策 5：接线员线程引用；决策 6：selectedChannel 读到即丢弃
    assert.equal(
      normalizeIMWorkspaceConfig({ operatorThreadId: '  wt-abc  ' }).operatorThreadId,
      'wt-abc',
    );
    assert.equal(
      normalizeIMWorkspaceConfig({ selectedChannel: 'qq' }).selectedChannel,
      undefined,
    );
    assert.equal(
      normalizeIMWorkspaceConfig({ operatorThreadId: 42 }).operatorThreadId,
      '',
    );
  });

  it('sanitizes receptionistSessionId via filesystem-safe slug', () => {
    const config = normalizeIMWorkspaceConfig({
      receptionistSessionId: '  my custom session!@#  ',
    });
    // sanitizeSessionFragment replaces non-alphanumeric with '-', trims edges
    assert.equal(config.receptionistSessionId, 'my-custom-session');
  });

  // 空值必须保持空：sanitizeSessionFragment 对空串兜底成 'default'，而升级
  // 迁移会把非空的 receptionistSessionId 当作真实旧会话去归档。兜底成
  // 'default' 会指向一个不存在的会话（端到端实测踩到）。
  it('keeps an absent receptionistSessionId empty instead of the slug fallback', () => {
    assert.equal(normalizeIMWorkspaceConfig({}).receptionistSessionId, '');
    assert.equal(normalizeIMWorkspaceConfig({ receptionistSessionId: '' }).receptionistSessionId, '');
    assert.equal(normalizeIMWorkspaceConfig({ receptionistSessionId: '   ' }).receptionistSessionId, '');
  });

  it('normalizes existing lines (boundTarget 线程寻址，boundSession 读到即丢弃)', () => {
    const config = normalizeIMWorkspaceConfig({
      lines: [
        { id: 'line-a', label: 'Hotline', carrier: 'qq',
          boundSession: { agentId: 'helper', sessionId: 'sess-1' },
          boundTarget: { agentId: 'helper', threadId: 'wt-1' } },
        { id: 'line-b', label: '', carrier: '', boundTarget: null },
        { id: 'line-c', label: 'Legacy', carrier: 'feishu',
          boundSession: { agentId: 'helper', sessionId: 'sess-2' } },
      ],
    });

    assert.equal(config.lines.length, 3);
    assert.equal(config.lines[0].id, 'line-a');
    assert.equal(config.lines[0].label, 'Hotline');
    assert.equal(config.lines[0].carrier, 'qq');
    assert.equal(config.lines[0].boundTarget.agentId, 'helper');
    assert.equal(config.lines[0].boundTarget.threadId, 'wt-1');
    assert.equal(config.lines[0].boundSession, undefined);
    // empty label → default label
    assert.ok(config.lines[1].label);
    assert.equal(config.lines[1].carrier, '');
    assert.equal(config.lines[1].boundTarget, null);
    // 旧 boundSession 绑定被清空不迁移（ADR-0042 决策 6），boundTarget 缺省 null
    assert.equal(config.lines[2].boundTarget, null);
    assert.equal(config.lines[2].boundSession, undefined);
  });

  it('handles non-object / array input gracefully', () => {
    // Note: null is not handled (default param doesn't apply to explicit null);
    // callers always pass {} from readJson catch. Strings and arrays work because
    // property access returns undefined for unknown props.
    const c2 = normalizeIMWorkspaceConfig('garbage');
    assert.equal(c2.lines.length, 2);

    const c3 = normalizeIMWorkspaceConfig([1, 2, 3]);
    assert.equal(c3.lines.length, 2);
  });

  /**
   * 里程碑 2 的回归锚：前端保存走「整份 PUT → normalizeIMWorkspaceConfig」。
   * 归一化若丢弃 PUT 载荷里的字段，用户点一次保存就等于解绑。
   *
   * 覆盖范围说明：本用例验证**服务端**归一不丢弃这两项（前端 draft 是否
   * 携带它们由 test/frontend-im-thread-shape.test.js 验证）。两段合起来才
   * 是完整往返；单看任何一侧都发现不了另一半的丢失。
   */
  it('服务端归一保真：PUT 载荷里的 operatorThreadId 与 boundTarget 不被丢弃', () => {
    const bundlePayload = {
      operatorThreadId: 'wt-operator-1',
      channels: { qq: { label: 'QQ', note: '' } },
      lines: [
        { id: 'line1', label: '通道 1', carrier: 'qq', boundTarget: { agentId: 'qqbot', threadId: 'wt-operator-1' } },
        { id: 'line2', label: '通道 2', carrier: 'feishu', boundTarget: { agentId: 'coder', threadId: 'wt-coder-9' } },
      ],
    };
    const roundTripped = normalizeIMWorkspaceConfig(bundlePayload);

    assert.equal(roundTripped.operatorThreadId, 'wt-operator-1');
    assert.deepEqual(roundTripped.lines[0].boundTarget,
      { agentId: 'qqbot', threadId: 'wt-operator-1' });
    assert.deepEqual(roundTripped.lines[1].boundTarget,
      { agentId: 'coder', threadId: 'wt-coder-9' });
    assert.equal(operatorCarrierOf(roundTripped), 'qq',
      '门户渠道在往返后仍应解析为接线员线路的 carrier');
  });

  it('往返保真：线路 carrier 变更时带上原 boundTarget 不会被清空', () => {
    // 对应前端 handleLineCarrierChange：传 carrier + 既有 agentId/threadId，
    // 服务端只改 carrier，绑定保留（旧实现只传 carrier，绑定被清成 null）
    const config = normalizeIMWorkspaceConfig({
      operatorThreadId: 'wt-op',
      lines: [{ id: 'line1', carrier: 'qq', boundTarget: { agentId: 'qqbot', threadId: 'wt-op' } }],
    });
    const line = config.lines.find((l) => l.id === 'line1');
    assert.equal(line.carrier, 'qq');
    assert.deepEqual(line.boundTarget, { agentId: 'qqbot', threadId: 'wt-op' });
  });
});

// ───────────────────────────────────────────────────────────────────
// Pipeline 2A: Carrier Exclusivity — Line Transfer Direction
// ───────────────────────────────────────────────────────────────────

describe('resolveLineTransferConflict', () => {
  it('clears other lines holding the same carrier (claim 者清占线)', () => {
    const config = {
      lines: [
        { id: 'line-0', carrier: 'qq', boundTarget: { agentId: 'a', threadId: 'wt-1' } },
        { id: 'line-1', carrier: 'qq', boundTarget: { agentId: 'b', threadId: 'wt-2' } },
      ],
    };

    const changed = resolveLineTransferConflict(config, { lineId: 'line-0', carrier: 'qq' });

    assert.equal(changed, true);
    assert.equal(config.lines[0].carrier, 'qq');       // the claiming line keeps its carrier
    assert.equal(config.lines[0].boundTarget.threadId, 'wt-1');
    assert.equal(config.lines[1].carrier, '');          // conflicting line cleared
    assert.equal(config.lines[1].boundTarget, null);
  });

  it('接线员线路与其他线路同为线路：claim 者清占线，无门户让路方向', () => {
    // ADR-0042：selectedChannel 并入线路模型后，接线员线路（绑定接线员线程的
    // 线路）不再有特殊优先级——carrier 冲突统一由 claim 方向解决。
    // 调用序列同 transfer 端点：先写 claim 者的 carrier/boundTarget，再解析冲突。
    const config = {
      lines: [
        { id: 'line-operator', carrier: '', boundTarget: null },
        { id: 'line-1', carrier: 'weixin', boundTarget: { agentId: 'x', threadId: 'wt-9' } },
      ],
    };
    config.lines[0].carrier = 'weixin';
    config.lines[0].boundTarget = { agentId: 'qqbot', threadId: 'wt-op' };

    const changed = resolveLineTransferConflict(config, { lineId: 'line-operator', carrier: 'weixin' });

    assert.equal(changed, true);
    assert.equal(config.lines[0].carrier, 'weixin');
    assert.equal(config.lines[0].boundTarget.threadId, 'wt-op');
    assert.equal(config.lines[1].carrier, '');
    assert.equal(config.lines[1].boundTarget, null);
  });

  it('returns false when no conflicts exist', () => {
    const config = {
      lines: [
        { id: 'line-0', carrier: 'qq', boundTarget: null },
        { id: 'line-1', carrier: '', boundTarget: null },
      ],
    };

    const changed = resolveLineTransferConflict(config, { lineId: 'line-0', carrier: 'qq' });
    assert.equal(changed, false);
  });

  it('handles empty carrier (no-op when carrier is empty string)', () => {
    const config = {
      lines: [
        { id: 'line-0', carrier: 'qq', boundTarget: null },
        { id: 'line-1', carrier: 'feishu', boundTarget: null },
      ],
    };

    // When carrier is empty, no line should match empty carrier
    const changed = resolveLineTransferConflict(config, { lineId: 'line-0', carrier: '' });
    assert.equal(changed, false);
  });
});

// ───────────────────────────────────────────────────────────────────
// Pipeline 2B: Carrier Exclusivity — Bundle PUT Direction
// ───────────────────────────────────────────────────────────────────

describe('resolveCarrierConflicts', () => {
  it('clears duplicate carriers keeping the first occurrence', () => {
    const config = {
      lines: [
        { id: 'line-0', carrier: 'qq', boundTarget: { agentId: 'a', threadId: 'wt-1' } },
        { id: 'line-1', carrier: 'qq', boundTarget: { agentId: 'b', threadId: 'wt-2' } },
        { id: 'line-2', carrier: 'feishu', boundTarget: null },
      ],
    };

    const changed = resolveCarrierConflicts(config);

    assert.equal(changed, true);
    assert.equal(config.lines[0].carrier, 'qq');        // first occurrence keeps
    assert.equal(config.lines[0].boundTarget.threadId, 'wt-1');
    assert.equal(config.lines[1].carrier, '');           // duplicate cleared with binding
    assert.equal(config.lines[1].boundTarget, null);
    assert.equal(config.lines[2].carrier, 'feishu');   // untouched
  });

  it('returns false when no line conflicts', () => {
    const config = {
      lines: [
        { id: 'line-0', carrier: 'feishu', boundTarget: null },
        { id: 'line-1', carrier: '', boundTarget: null },
      ],
    };

    const changed = resolveCarrierConflicts(config);
    assert.equal(changed, false);
  });
});

// ───────────────────────────────────────────────────────────────────
// Pipeline 3: Serialized Config Mutation Queue
// ───────────────────────────────────────────────────────────────────

describe('createConfigSerializer', () => {
  it('executes mutators sequentially in submission order', async () => {
    const order = [];
    let stored = { value: 0 };

    const serializer = createConfigSerializer({
      read: async () => ({ ...stored }),
      write: async (config) => { stored = config; },
    });

    // Submit 3 mutators that each increment by 1
    const p1 = serializer((config) => { order.push('m1-start'); config.value++; return true; });
    const p2 = serializer((config) => { order.push('m2-start'); config.value++; return true; });
    const p3 = serializer((config) => { order.push('m3-start'); config.value++; return true; });

    await Promise.all([p1, p2, p3]);

    // Each mutator read AFTER the previous one wrote, so value = 0+1+1+1 = 3
    assert.equal(stored.value, 3);
    assert.deepEqual(order, ['m1-start', 'm2-start', 'm3-start']);
  });

  it('skips write when mutator returns falsy', async () => {
    let stored = { value: 42 };
    let writeCount = 0;

    const serializer = createConfigSerializer({
      read: async () => ({ ...stored }),
      write: async (config) => { writeCount++; stored = config; },
    });

    await serializer((config) => {
      config.value = 999;
      return false;  // no write
    });

    assert.equal(writeCount, 0);
    assert.equal(stored.value, 42);
  });

  it('a rejected mutator does not break the chain', async () => {
    let stored = { value: 0 };

    const serializer = createConfigSerializer({
      read: async () => ({ ...stored }),
      write: async (config) => { stored = config; },
    });

    // First mutator throws
    const p1 = serializer(() => { throw new Error('boom'); });
    // Second mutator should still execute
    const p2 = serializer((config) => { config.value = 77; return true; });

    await p1.catch(e => console.warn(e));  // expect rejection
    await p2;

    assert.equal(stored.value, 77);
  });

  it('handles async mutator with await inside', async () => {
    let stored = { items: [] };

    const serializer = createConfigSerializer({
      read: async () => ({ items: [...stored.items] }),
      write: async (config) => { stored = config; },
    });

    await serializer(async (config) => {
      await new Promise(r => setTimeout(r, 10));
      config.items.push('a');
      return true;
    });

    await serializer(async (config) => {
      await new Promise(r => setTimeout(r, 5));
      config.items.push('b');
      return true;
    });

    assert.deepEqual(stored.items, ['a', 'b']);
  });
});

// ───────────────────────────────────────────────────────────────────
// Pipeline 4: Token Usage Resolution
// ───────────────────────────────────────────────────────────────────

describe('getUsageContextTokens', () => {
  it('prefers lastRequestUsage.inputTokens', () => {
    assert.equal(
      getUsageContextTokens({
        lastRequestUsage: { inputTokens: 100, totalTokens: 200 },
        totalTokens: 500,
      }),
      100,
    );
  });

  it('falls back to lastRequestUsage.totalTokens when inputTokens is 0', () => {
    assert.equal(
      getUsageContextTokens({
        lastRequestUsage: { inputTokens: 0, totalTokens: 300 },
        totalTokens: 500,
      }),
      300,
    );
  });

  it('falls back to top-level totalTokens when no lastRequestUsage', () => {
    assert.equal(
      getUsageContextTokens({ totalTokens: 500 }),
      500,
    );
  });

  it('returns null when no token data available', () => {
    assert.equal(getUsageContextTokens(null), null);
    assert.equal(getUsageContextTokens({}), null);
    assert.equal(getUsageContextTokens(undefined), null);
  });

  it('ignores negative or NaN values', () => {
    assert.equal(
      getUsageContextTokens({
        lastRequestUsage: { inputTokens: -1, totalTokens: NaN },
        totalTokens: 0,
      }),
      null,
    );
  });
});

// ───────────────────────────────────────────────────────────────────
// Helper: findLine
// ───────────────────────────────────────────────────────────────────

describe('findLine', () => {
  it('finds a line by id', () => {
    const config = {
      lines: [
        { id: 'line-0', carrier: 'qq' },
        { id: 'line-1', carrier: '' },
      ],
    };

    assert.deepEqual(findLine(config, 'line-1'), { id: 'line-1', carrier: '' });
  });

  it('returns null for unknown id', () => {
    assert.equal(findLine({ lines: [] }, 'nope'), null);
    assert.equal(findLine({}, 'nope'), null);
  });
});
