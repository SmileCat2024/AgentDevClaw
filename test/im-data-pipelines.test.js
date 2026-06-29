/**
 * Tests for IM domain core data pipelines (extracted from server/routes/im.js).
 *
 * Covers 4 critical data pipelines guided by CLAUDE.md:
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
  resolvePortalChannelConflict,
  createConfigSerializer,
  getUsageContextTokens,
  findLine,
} from '../server/routes/im.js';

// ───────────────────────────────────────────────────────────────────
// Pipeline 1: Config Normalization
// ───────────────────────────────────────────────────────────────────

describe('normalizeIMWorkspaceConfig', () => {
  it('creates 4 default channels and 2 default lines from empty input', () => {
    const config = normalizeIMWorkspaceConfig();

    assert.deepEqual(Object.keys(config.channels).sort(), ['feishu', 'qq', 'wecom', 'weixin']);
    assert.equal(config.channels.qq.label, 'QQ');
    assert.equal(config.channels.weixin.label, '微信');
    assert.equal(config.channels.feishu.label, '飞书');
    assert.equal(config.channels.wecom.label, '企业微信');
    assert.equal(config.lines.length, 2);
    assert.equal(config.selectedChannel, '');
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

  it('validates selectedChannel against known channels', () => {
    assert.equal(
      normalizeIMWorkspaceConfig({ selectedChannel: 'qq' }).selectedChannel,
      'qq',
    );
    assert.equal(
      normalizeIMWorkspaceConfig({ selectedChannel: 'telegram' }).selectedChannel,
      '',
    );
    assert.equal(
      normalizeIMWorkspaceConfig({ selectedChannel: '  weixin  ' }).selectedChannel,
      'weixin',
    );
  });

  it('sanitizes receptionistSessionId via filesystem-safe slug', () => {
    const config = normalizeIMWorkspaceConfig({
      receptionistSessionId: '  my custom session!@#  ',
    });
    // sanitizeSessionFragment replaces non-alphanumeric with '-', trims edges
    assert.equal(config.receptionistSessionId, 'my-custom-session');
  });

  it('normalizes existing lines', () => {
    const config = normalizeIMWorkspaceConfig({
      lines: [
        { id: 'line-a', label: 'Hotline', carrier: 'qq',
          boundSession: { agentId: 'helper', sessionId: 'sess-1', sessionTitle: 'Helper' } },
        { id: 'line-b', label: '', carrier: '', boundSession: null },
      ],
    });

    assert.equal(config.lines.length, 2);
    assert.equal(config.lines[0].id, 'line-a');
    assert.equal(config.lines[0].label, 'Hotline');
    assert.equal(config.lines[0].carrier, 'qq');
    assert.equal(config.lines[0].boundSession.agentId, 'helper');
    assert.equal(config.lines[0].boundSession.sessionId, 'sess-1');
    // empty label → default label
    assert.ok(config.lines[1].label);
    assert.equal(config.lines[1].carrier, '');
    assert.equal(config.lines[1].boundSession, null);
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
});

// ───────────────────────────────────────────────────────────────────
// Pipeline 2A: Three-Way Exclusivity — Line Transfer Direction
// ───────────────────────────────────────────────────────────────────

describe('resolveLineTransferConflict', () => {
  it('clears other lines holding the same carrier', () => {
    const config = {
      selectedChannel: 'feishu',
      lines: [
        { id: 'line-0', carrier: 'qq', boundSession: { agentId: 'a', sessionId: 's1' } },
        { id: 'line-1', carrier: 'qq', boundSession: { agentId: 'b', sessionId: 's2' } },
      ],
    };

    const changed = resolveLineTransferConflict(config, { lineId: 'line-0', carrier: 'qq' });

    assert.equal(changed, true);
    assert.equal(config.lines[0].carrier, 'qq');       // the claiming line keeps its carrier
    assert.equal(config.lines[1].carrier, '');          // conflicting line cleared
    assert.equal(config.lines[1].boundSession, null);
  });

  it('re-assigns portal selectedChannel when it conflicts', () => {
    const config = {
      selectedChannel: 'qq',
      lines: [
        { id: 'line-0', carrier: '', boundSession: null },
        { id: 'line-1', carrier: 'weixin', boundSession: null },
      ],
    };

    const changed = resolveLineTransferConflict(config, { lineId: 'line-0', carrier: 'qq' });

    assert.equal(changed, true);
    assert.notEqual(config.selectedChannel, 'qq');       // portal kicked off 'qq'
    assert.notEqual(config.selectedChannel, 'weixin');   // can't take 'weixin' either (line-1 holds it)
    // Should fall back to feishu or wecom (first available)
    assert.ok(['feishu', 'wecom'].includes(config.selectedChannel));
  });

  it('sets portal selectedChannel to empty when all carriers are taken', () => {
    const config = {
      selectedChannel: 'qq',
      lines: [
        { id: 'line-0', carrier: '', boundSession: null },
        { id: 'line-1', carrier: 'weixin', boundSession: null },
        { id: 'line-extra-1', carrier: 'feishu', boundSession: null },
        { id: 'line-extra-2', carrier: 'wecom', boundSession: null },
      ],
    };

    resolveLineTransferConflict(config, { lineId: 'line-0', carrier: 'qq' });

    assert.equal(config.selectedChannel, '');  // all other carriers taken
  });

  it('returns false when no conflicts exist', () => {
    const config = {
      selectedChannel: 'feishu',
      lines: [
        { id: 'line-0', carrier: 'qq', boundSession: null },
        { id: 'line-1', carrier: '', boundSession: null },
      ],
    };

    const changed = resolveLineTransferConflict(config, { lineId: 'line-0', carrier: 'qq' });
    assert.equal(changed, false);
  });

  it('handles empty carrier (no-op when carrier is empty string)', () => {
    const config = {
      selectedChannel: 'qq',
      lines: [
        { id: 'line-0', carrier: 'qq', boundSession: null },
        { id: 'line-1', carrier: 'feishu', boundSession: null },
      ],
    };

    // When carrier is empty, no line should match empty carrier
    const changed = resolveLineTransferConflict(config, { lineId: 'line-0', carrier: '' });
    // line-1.carrier ('feishu') !== '' so no clearing; selectedChannel !== '' so no portal change
    assert.equal(changed, false);
  });
});

// ───────────────────────────────────────────────────────────────────
// Pipeline 2B: Three-Way Exclusivity — Portal Channel Direction
// ───────────────────────────────────────────────────────────────────

describe('resolvePortalChannelConflict', () => {
  it('clears lines holding the same carrier as the portal new channel', () => {
    const config = {
      lines: [
        { id: 'line-0', carrier: 'qq', boundSession: { agentId: 'a', sessionId: 's1' } },
        { id: 'line-1', carrier: 'qq', boundSession: { agentId: 'b', sessionId: 's2' } },
        { id: 'line-2', carrier: 'feishu', boundSession: null },
      ],
    };

    const changed = resolvePortalChannelConflict(config, 'qq');

    assert.equal(changed, true);
    assert.equal(config.lines[0].carrier, '');
    assert.equal(config.lines[0].boundSession, null);
    assert.equal(config.lines[1].carrier, '');
    assert.equal(config.lines[1].boundSession, null);
    assert.equal(config.lines[2].carrier, 'feishu');   // untouched
  });

  it('returns false when no line conflicts', () => {
    const config = {
      lines: [
        { id: 'line-0', carrier: 'feishu', boundSession: null },
        { id: 'line-1', carrier: '', boundSession: null },
      ],
    };

    const changed = resolvePortalChannelConflict(config, 'qq');
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

    await p1.catch(() => {});  // expect rejection
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
