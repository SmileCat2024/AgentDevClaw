import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { GroupAdminFeature } from '../local-features/dist/group-admin/src/index.js';

describe('GroupAdminFeature', () => {
  const origEnv = { ...process.env };
  const ORIGIN = 'http://127.0.0.1:9999';
  const CHAT_ID = 'test-chat-123';

  function createFeature() {
    process.env.PROTOCLAW_GC_CHAT_ID = CHAT_ID;
    process.env.PROTOCLAW_SERVER_ORIGIN = ORIGIN;
    return new GroupAdminFeature();
  }

  function mockFetch(handler) {
    const orig = global.fetch;
    global.fetch = async (url, opts) => handler(url, opts);
    return () => { global.fetch = orig; };
  }

  after(() => {
    process.env = origEnv;
  });

  // ── statusLabel ──────────────────────────────────────────

  describe('statusLabel', () => {
    const feature = createFeature();

    it('maps running to 运行中', () => {
      assert.equal(feature.statusLabel('running'), '运行中');
    });
    it('maps queued to 排队中', () => {
      assert.equal(feature.statusLabel('queued'), '排队中');
    });
    it('maps idle to 空闲', () => {
      assert.equal(feature.statusLabel('idle'), '空闲');
    });
    it('maps unknown status to 离线', () => {
      assert.equal(feature.statusLabel('foo'), '离线');
      assert.equal(feature.statusLabel(''), '离线');
      assert.equal(feature.statusLabel(undefined), '离线');
    });
  });

  // ── formatNumber ─────────────────────────────────────────

  describe('formatNumber', () => {
    const feature = createFeature();

    it('formats integers with zh-CN locale', () => {
      assert.equal(feature.formatNumber(1234), '1,234');
    });
    it('formats large numbers', () => {
      assert.equal(feature.formatNumber(1000000), '1,000,000');
    });
    it('returns ? for non-finite values', () => {
      assert.equal(feature.formatNumber(NaN), '?');
      assert.equal(feature.formatNumber(Infinity), '?');
    });
    it('returns ? for non-numeric strings', () => {
      assert.equal(feature.formatNumber('abc'), '?');
    });
    it('handles numeric strings', () => {
      assert.equal(feature.formatNumber('1234'), '1,234');
    });
  });

  // ── formatSessionLine ────────────────────────────────────

  describe('formatSessionLine', () => {
    const feature = createFeature();

    it('formats a running session with context info', () => {
      const line = feature.formatSessionLine({
        title: 'My Session',
        sessionId: 'sess-abc',
        runtimeStatus: 'running',
        modelName: 'gpt-4',
        contextTokens: 1000,
        contextLength: 8000,
        contextUsagePct: 12,
        compressRatio: 80,
      });
      assert.ok(line.includes('运行中'));
      assert.ok(line.includes('My Session'));
      assert.ok(line.includes('sess-abc'));
      assert.ok(line.includes('gpt-4'));
    });

    it('shows compress threshold warning when usage >= ratio', () => {
      const line = feature.formatSessionLine({
        title: 'Big Session',
        sessionId: 'sess-big',
        runtimeStatus: 'running',
        modelName: 'claude-3',
        contextTokens: 7000,
        contextLength: 8000,
        contextUsagePct: 90,
        compressRatio: 80,
      });
      assert.ok(line.includes('已到压缩阈值'));
    });

    it('marks active session', () => {
      const line = feature.formatSessionLine({
        title: 'Active',
        sessionId: 's1',
        runtimeStatus: 'idle',
        modelName: 'model',
        isActive: true,
      });
      assert.ok(line.includes('当前会话'));
    });

    it('handles missing context info gracefully', () => {
      const line = feature.formatSessionLine({
        title: 'Sparse',
        sessionId: 's2',
      });
      assert.ok(line.includes('Sparse'));
      assert.ok(line.includes('离线') || line.includes('?'));
    });
  });

  // ── formatAwarenessText ──────────────────────────────────

  describe('formatAwarenessText', () => {
    const feature = createFeature();

    it('builds totals summary line', () => {
      const text = feature.formatAwarenessText({
        totals: { sessions: 3, running: 1, queued: 0, idle: 1, offline: 1 },
        identities: [],
      });
      assert.ok(text.includes('会话 3'));
      assert.ok(text.includes('运行中 1'));
      assert.ok(text.includes('空闲 1'));
      assert.ok(text.includes('离线 1'));
    });

    it('includes route counts when present', () => {
      const text = feature.formatAwarenessText({
        totals: { sessions: 1, running: 1, pendingRoutes: 2, deliveredRoutes: 1 },
        identities: [],
      });
      assert.ok(text.includes('pending 2'));
      assert.ok(text.includes('delivered 1'));
    });

    it('formats identity blocks with sessions', () => {
      const text = feature.formatAwarenessText({
        totals: { sessions: 1, running: 1 },
        identities: [{
          identityRef: 'programming-helper:main',
          displayName: '编程助手',
          aggregateStatus: 'running',
          sessions: [{
            title: 'Bug Fix',
            sessionId: 's-1',
            runtimeStatus: 'running',
            modelName: 'gpt-4',
          }],
        }],
      });
      assert.ok(text.includes('编程助手'));
      assert.ok(text.includes('programming-helper:main'));
      assert.ok(text.includes('Bug Fix'));
      assert.ok(text.includes('运行中'));
    });

    it('filters by focusIdentityRef', () => {
      const text = feature.formatAwarenessText({
        totals: { sessions: 2, running: 1, idle: 1 },
        identities: [
          { identityRef: 'a:main', displayName: 'A', aggregateStatus: 'running', sessions: [{ title: 'sa', sessionId: 's-a', runtimeStatus: 'running', modelName: 'm' }] },
          { identityRef: 'b:main', displayName: 'B', aggregateStatus: 'idle', sessions: [{ title: 'sb', sessionId: 's-b', runtimeStatus: 'idle', modelName: 'm' }] },
        ],
      }, { focusIdentityRef: 'a:main' });
      assert.ok(text.includes('A'));
      assert.ok(!text.includes('B'));
    });

    it('shows no-session placeholder when focusSessionId has no match', () => {
      const text = feature.formatAwarenessText({
        totals: { sessions: 1 },
        identities: [{
          identityRef: 'a:main',
          displayName: 'A',
          aggregateStatus: 'running',
          sessions: [{ title: 'sa', sessionId: 's-a', runtimeStatus: 'running', modelName: 'm' }],
        }],
      }, { focusIdentityRef: 'a:main', focusSessionId: 'nonexistent' });
      assert.ok(text.includes('暂无群内会话'));
    });
  });

  // ── Tool definitions ─────────────────────────────────────

  describe('getTools', () => {
    const feature = createFeature();
    const tools = feature.getTools();

    it('returns expected tool names', () => {
      const names = tools.map(t => t.name);
      assert.ok(names.includes('gc_overview'));
      assert.ok(names.includes('gc_messages'));
      assert.ok(names.includes('gc_dispatch'));
      assert.ok(names.includes('gc_reply'));
      assert.ok(names.includes('gc_sessions'));
      assert.ok(names.includes('gc_status'));
      assert.ok(names.includes('gc_scan_workdir'));
      assert.ok(names.includes('gc_save_group_md'));
      assert.ok(names.includes('gc_interrupt'));
    });

    it('gc_dispatch rejects self-dispatch', async () => {
      const tool = tools.find(t => t.name === 'gc_dispatch');
      const result = await tool.execute({ text: 'hello', identityRef: 'work-group:admin', title: 'test' });
      assert.ok(result.error);
      assert.ok(result.error.includes('不能向管理员自身派发'));
    });

    it('gc_dispatch validates required fields', async () => {
      const tool = tools.find(t => t.name === 'gc_dispatch');
      const result = await tool.execute({ text: 'hello', identityRef: 'a:b' });
      assert.ok(result.error);
      assert.ok(result.error.includes('title'));
    });

    it('gc_reply validates text is required', async () => {
      const tool = tools.find(t => t.name === 'gc_reply');
      const result = await tool.execute({});
      assert.ok(result.error);
      assert.ok(result.error.includes('text'));
    });

    it('gc_sessions validates identityRef is required', async () => {
      const tool = tools.find(t => t.name === 'gc_sessions');
      const result = await tool.execute({});
      assert.ok(result.error);
      assert.ok(result.error.includes('identityRef'));
    });

    it('gc_save_group_md validates content is required', async () => {
      const tool = tools.find(t => t.name === 'gc_save_group_md');
      const result = await tool.execute({ content: 42 });
      assert.ok(result.error);
      assert.ok(result.error.includes('content'));
    });

    it('gc_interrupt validates identityRef is required', async () => {
      const tool = tools.find(t => t.name === 'gc_interrupt');
      const result = await tool.execute({});
      assert.ok(result.error);
      assert.ok(result.error.includes('identityRef'));
    });
  });

  // ── Tool execute with mocked fetch ───────────────────────

  describe('gc_reply executes via mocked API', () => {
    it('sends a message and returns success', async () => {
      const feature = createFeature();
      const tool = feature.getTools().find(t => t.name === 'gc_reply');
      const restore = mockFetch((url, opts) => {
        assert.ok(url.includes('/messages'));
        assert.ok(url.includes(CHAT_ID));
        return Promise.resolve({
          ok: true,
          json: async () => ({ id: 'msg-001' }),
        });
      });
      try {
        const result = await tool.execute({ text: 'hello group' });
        assert.equal(result.success, true);
        assert.ok(result.text.includes('msg-001'));
      } finally {
        restore();
      }
    });

    it('returns error when API fails', async () => {
      const feature = createFeature();
      const tool = feature.getTools().find(t => t.name === 'gc_reply');
      const restore = mockFetch(() => Promise.resolve({
        ok: false,
        status: 500,
        json: async () => ({ error: 'internal error' }),
      }));
      try {
        await assert.rejects(
          () => tool.execute({ text: 'hello' }),
          /internal error/,
        );
      } finally {
        restore();
      }
    });
  });

  describe('gc_overview executes via mocked API', () => {
    it('returns formatted chat overview', async () => {
      const feature = createFeature();
      const tool = feature.getTools().find(t => t.name === 'gc_overview');

      let callCount = 0;
      const restore = mockFetch((url) => {
        callCount++;
        if (url.includes('/awareness')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              totals: { sessions: 2, running: 1, idle: 1 },
              identities: [],
            }),
          });
        }
        // chat detail
        return Promise.resolve({
          ok: true,
          json: async () => ({
            name: 'Test Group',
            messages: [
              { kind: 'message', from: 'user', text: 'hello', timestamp: '2026-01-01T00:00:00Z' },
            ],
            members: [
              { identityRef: 'user', role: 'admin' },
              { identityRef: 'programming-helper:main', role: 'member' },
            ],
          }),
        });
      });

      try {
        const result = await tool.execute({});
        assert.equal(result.success, true);
        assert.ok(result.text.includes('Test Group'));
        assert.ok(result.text.includes('用户'));
        assert.ok(result.text.includes('programming-helper:main'));
        assert.ok(result.text.includes('消息数: 1'));
      } finally {
        restore();
      }
    });
  });

  describe('gc_dispatch executes via mocked API', () => {
    it('dispatches to new session and returns session info', async () => {
      const feature = createFeature();
      const tool = feature.getTools().find(t => t.name === 'gc_dispatch');

      const restore = mockFetch((url, opts) => {
        const body = JSON.parse(opts.body);
        assert.equal(body.kind, 'dispatch');
        assert.equal(body.from, 'work-group:admin');
        assert.equal(body.text, 'do something');
        assert.ok(body.mentions[0].title);
        return Promise.resolve({
          ok: true,
          json: async () => ({
            id: 'msg-dispatch-1',
            resolvedSession: {
              sessionId: 'sess-new',
              sessionTitle: 'New Task',
              isNew: true,
            },
          }),
        });
      });

      try {
        const result = await tool.execute({
          text: 'do something',
          identityRef: 'programming-helper:main',
          title: 'My Task',
        });
        assert.equal(result.success, true);
        assert.equal(result.sessionId, 'sess-new');
        assert.equal(result.sessionTitle, 'New Task');
        assert.equal(result.isNew, true);
        assert.ok(result.text.includes('编程助手') || result.text.includes('programming-helper') || result.text.includes('派发'));
      } finally {
        restore();
      }
    });

    it('handles pendingApproval response', async () => {
      const feature = createFeature();
      const tool = feature.getTools().find(t => t.name === 'gc_dispatch');

      const restore = mockFetch(() => Promise.resolve({
        ok: true,
        json: async () => ({
          id: 'msg-pending',
          pendingApproval: true,
        }),
      }));

      try {
        const result = await tool.execute({
          text: 'task',
          identityRef: 'programming-helper:main',
          title: 'Title',
        });
        assert.equal(result.pendingApproval, true);
        assert.ok(result.text.includes('审批'));
      } finally {
        restore();
      }
    });
  });
});
