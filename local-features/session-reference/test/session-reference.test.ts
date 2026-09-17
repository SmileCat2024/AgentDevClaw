/**
 * SessionReferenceFeature 单测：概览渲染（call 边界截断 / todo 语义锚点）、
 * 某轮全量渲染、引用注入 reminder（纯函数 + hook 行为，HTTP 面 mock fetch）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderSeedOverview,
  extractTodoEvents,
  renderTurnDetail,
  renderReferenceReminder,
  SessionReferenceFeature,
} from '../src/index.js';

// ── renderSeedOverview（trim 视图概览） ───────────────────────────

describe('renderSeedOverview', () => {
  it('renders dialogue lines with turn tags and folded tool notes in one line', () => {
    const seedMessages = [
      { role: 'user', content: '帮我修一个 bug', turn: 1 },
      { role: 'assistant', content: '我先看一下目录结构。', turn: 2 },
      {
        role: 'system',
        content: '[Folded tool activity]\nassistant tool calls: Read(a.ts); Bash(npm test) ×2',
        turn: 3,
        tag: 'folded-tool-activity',
      },
      { role: 'user', content: '测试过了吗', turn: 4 },
    ];
    const { text, truncated } = renderSeedOverview(seedMessages as any, seedMessages as any, {
      agentId: 'programming-helper',
      sessionId: 'session-1',
    });
    assert.equal(truncated, false);
    assert.match(text, /\[会话转录概览\] programming-helper\/session-1/);
    assert.match(text, /\[T1\] user: 帮我修一个 bug/);
    assert.match(text, /\[T2\] assistant: 我先看一下目录结构。/);
    // 折叠注记压成单行，保留去重后的工具摘要
    assert.match(text, /\[T3\] \(工具活动\) assistant tool calls: Read\(a\.ts\); Bash\(npm test\) ×2/);
    assert.match(text, /\[T4\] user: 测试过了吗/);
    assert.doesNotMatch(text, /\[Folded tool activity\]/);
    assert.doesNotMatch(text, /任务事件/);
  });

  it('renders todo semantic anchors from raw messages when present', () => {
    const rawMessages = [
      { role: 'user', content: '开工', turn: 0 },
      { role: 'assistant', content: '', turn: 0, toolCalls: [{ id: 'c1', name: 'task_create', args: { subject: '勘察链路' } }] },
      { role: 'tool', content: JSON.stringify({ ok: true, taskId: '1', status: 'pending' }), turn: 0, toolCallId: 'c1' },
      { role: 'assistant', content: '', turn: 2, toolCalls: [{ id: 'c2', name: 'task_update', args: { taskId: '1', status: 'in_progress' } }] },
      { role: 'assistant', content: 'done', turn: 6, toolCalls: [{ id: 'c3', name: 'task_update', args: { taskId: '1', status: 'completed' } }] },
    ];
    const { text } = renderSeedOverview(rawMessages as any, rawMessages as any, {
      agentId: 'a', sessionId: 's',
    });
    assert.match(text, /## 任务事件（todo 语义锚点/);
    assert.match(text, /「勘察链路」 创建 T0 → 开始执行 T2 → 完成 T6/);
  });

  it('covers all calls: overflow calls degrade to one-liner, never dropped', () => {
    // 40 个 call × 3 step（每 step 约 920 字符）——正文只装得下前几个，
    // 其余必须降级为单行速览；全部 40 个 turn 必须出现在概览里（无静默丢轮）。
    const seedMessages: any[] = [];
    for (let turn = 0; turn < 40; turn++) {
      for (let step = 0; step < 3; step++) {
        seedMessages.push({ role: 'user', content: `c${turn} step${step} ${'x'.repeat(900)}`, turn });
      }
    }
    const { text, truncated } = renderSeedOverview(seedMessages as any, seedMessages as any, {
      agentId: 'a', sessionId: 's',
    });
    assert.equal(truncated, true);
    assert.match(text, /前段轮次（单行速览/);
    // 每个已收录 call 的 step 行数完整（3 行），未被收录的为 0——不存在半轮
    const includedCounts = new Map<number, number>();
    for (const line of text.split('\n')) {
      const match = line.match(/^\[T(\d+)\]/);
      if (match) includedCounts.set(Number(match[1]), (includedCounts.get(Number(match[1])) ?? 0) + 1);
    }
    assert.ok(includedCounts.size > 0, '至少收录一个完整 call');
    // 正文档的 turn = 3 行完整；速览档 = 1 行；不存在半轮
    for (const [turn, count] of includedCounts) {
      assert.ok(count === 3 || count === 1, `T${turn} 行数 ${count}`);
    }
    // 全部 40 个 turn 都必须出现在概览里（无静默丢轮）
    for (let turn = 0; turn < 40; turn++) {
      assert.ok(includedCounts.has(turn), `T${turn} 缺失于概览`);
    }
  });

  it('skips messages without role gracefully', () => {
    const messages = [{ role: '', content: 'x', turn: 1 }, { role: 'user', content: 'hi', turn: 1 }];
    const { text } = renderSeedOverview(messages as any, messages as any, { agentId: 'a', sessionId: 's' });
    assert.match(text, /\[T1\] unknown: /);
  });
});

// ── extractTodoEvents ─────────────────────────────────────────────

describe('extractTodoEvents', () => {
  const rawMessages = [
    { role: 'user', content: '开工', turn: 0 },
    {
      role: 'assistant', content: '', turn: 0,
      toolCalls: [{ id: 'c1', name: 'task_create', args: { subject: '勘察链路' } }],
    },
    { role: 'tool', content: JSON.stringify({ ok: true, taskId: '1', status: 'pending' }), turn: 0, toolCallId: 'c1' },
    { role: 'assistant', content: '', turn: 2, toolCalls: [{ id: 'c2', name: 'task_update', args: { taskId: '1', status: 'in_progress' } }] },
    { role: 'assistant', content: 'done', turn: 6, toolCalls: [{ id: 'c3', name: 'task_update', args: { taskId: '1', status: 'completed' } }] },
    // 无关工具不产生事件
    { role: 'assistant', content: '', turn: 6, toolCalls: [{ id: 'c4', name: 'bash', args: { command: 'ls' } }] },
  ];

  it('aggregates lifecycle events per taskId across calls', () => {
    const events = extractTodoEvents(rawMessages as any);
    assert.equal(events.length, 1);
    assert.equal(events[0].subject, '勘察链路');
    assert.deepEqual(
      events[0].timeline.map((step) => `${step.verb} T${step.turn}`),
      ['创建 T0', '开始执行 T2', '完成 T6'],
    );
  });

  it('falls back to subject key when create result lacks taskId', () => {
    const messages = [
      { role: 'assistant', content: '', turn: 0, toolCalls: [{ id: 'c1', name: 'task_create', args: { subject: '写报告' } }] },
      { role: 'assistant', content: '', turn: 1, toolCalls: [{ id: 'c2', name: 'task_update', args: { taskId: '9', status: 'completed' } }] },
    ];
    const events = extractTodoEvents(messages as any);
    // update 在 create 之前到达（taskId 无法关联）时各自独立成条
    assert.equal(events.length, 2);
  });

  it('maps deleted to cancellation and bare updates to placeholder subjects', () => {
    const messages = [
      { role: 'assistant', content: '', turn: 1, toolCalls: [{ id: 'c1', name: 'task_update', args: { taskId: '7', status: 'deleted' } }] },
    ];
    const events = extractTodoEvents(messages as any);
    assert.equal(events.length, 1);
    assert.equal(events[0].subject, '任务 7');
    assert.equal(events[0].timeline[0].verb, '取消');
  });
});

// ── renderTurnDetail（某轮全量展开） ──────────────────────────────

describe('renderTurnDetail', () => {
  const messages = [
    { role: 'user', content: '第一轮', turn: 0 },
    { role: 'assistant', content: '第一轮回复', turn: 1, toolCalls: [{ id: 'c1', name: 'read', args: { filePath: '/x' } }] },
    { role: 'tool', content: '文件内容全文', turn: 1, toolCallId: 'c1' },
    { role: 'assistant', content: '第二轮回复', turn: 2 },
  ];

  it('returns all messages of the requested turn unclipped', () => {
    const text = renderTurnDetail(messages as any, 1, { agentId: 'ph', sessionId: 's' });
    assert.match(text, /全量，共 2 条消息/);
    assert.match(text, /\[T1\] assistant: 第一轮回复/);
    assert.match(text, /→ 调用 read\({"filePath":"\/x"}\)/);
    assert.match(text, /\[T1\] tool 结果\(c1\): 文件内容/);
  });

  it('renders long tool results in full (no truncation)', () => {
    const long = 'x'.repeat(50_000);
    const text = renderTurnDetail(
      [{ role: 'tool', content: long, turn: 0, toolCallId: 'c1' }] as any,
      0,
      { agentId: 'a', sessionId: 's' },
    );
    assert.ok(text.includes('x'.repeat(50_000)));
  });

  it('returns null for an unknown turn', () => {
    assert.equal(renderTurnDetail(messages as any, 99, { agentId: 'a', sessionId: 's' }), null);
    assert.equal(renderTurnDetail([] as any, 0, { agentId: 'a', sessionId: 's' }), null);
  });
});

// ── renderReferenceReminder（引用注入 reminder） ─────────────────

describe('renderReferenceReminder', () => {
  it('renders id + title + agent/sessionType with the AI-title disclaimer', () => {
    const text = renderReferenceReminder([
      { agentId: 'programming-helper', sessionId: 'session-1789456315259-15c389', title: '修复登录超时', sessionType: 'main', availability: 'ok' },
      { agentId: 'agent-studio', sessionId: 'session-1789431188614-41ceab', title: '重构导出逻辑', sessionType: 'main', availability: 'ok' },
    ]);
    assert.match(text, /^\[会话引用\] 用户在本条消息中引用了以下会话/);
    assert.match(text, /标题由 AI 自动生成，仅供参考，不能代表会话真实内容与方向/);
    assert.match(text, /- session-1789456315259-15c389「修复登录超时」 \(programming-helper\/main\)/);
    assert.match(text, /- session-1789431188614-41ceab「重构导出逻辑」 \(agent-studio\/main\)/);
    assert.match(text, /session_read_overview/);
    assert.match(text, /session_read_turn/);
  });

  it('marks missing sessions explicitly instead of silently dropping them', () => {
    const text = renderReferenceReminder([
      { agentId: 'a', sessionId: 's-1', title: '', sessionType: 'main', availability: 'missing' },
    ]);
    assert.match(text, /- s-1 \(a\/main\) — 已不存在/);
  });

  it('distinguishes unverified availability from missing', () => {
    const text = renderReferenceReminder([
      { agentId: 'a', sessionId: 's-2', title: 't', sessionType: 'main', availability: 'unknown' },
    ]);
    assert.match(text, /读取入口暂不可用/);
    assert.doesNotMatch(text, /已不存在/);
  });
});

// ── injectSessionReferences（CallStart hook 行为） ────────────────

describe('injectSessionReferences', () => {
  const realFetch = globalThis.fetch;

  it('injects one reminder for metadata references and consumes them once', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: any) => {
      calls.push(String(url));
      return { ok: true, status: 200, json: async () => ({ messages: [] }) } as any;
    }) as any;
    try {
      const feature = new SessionReferenceFeature({ serverOrigin: 'http://server.test' });
      const injected: Array<{ content: string; turn: number; source?: string; tag?: string }> = [];
      const ctx: any = {
        metadata: {
          'session-reference': [
            { agentId: 'programming-helper', sessionId: 's-1', title: '修复登录超时', sessionType: 'main' },
            { agentId: 'agent-studio', sessionId: 's-2' },
          ],
        },
        agent: { _callIndex: 3 },
        context: {
          addSystemMessage(content: string, turn: number, source?: string, tag?: string) {
            injected.push({ content, turn, source, tag });
          },
        },
      };

      await feature.injectSessionReferences(ctx);

      assert.equal(injected.length, 1);
      assert.equal(injected[0].turn, 3);
      assert.equal(injected[0].source, 'session-reference');
      assert.equal(injected[0].tag, 'reminder');
      assert.match(injected[0].content, /s-1「修复登录超时」 \(programming-helper\/main\)/);
      assert.match(injected[0].content, /s-2 \(agent-studio\/main\)/);
      // 每个引用验证一次存在性
      assert.equal(calls.filter((url) => url.includes('session_record')).length, 2);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('is a no-op when the turn carries no references', async () => {
    const feature = new SessionReferenceFeature({ serverOrigin: 'http://server.test' });
    let added = 0;
    const ctx: any = {
      metadata: { 'something-else': [1, 2] },
      agent: {},
      context: { addSystemMessage() { added += 1; } },
    };
    await feature.injectSessionReferences(ctx);
    assert.equal(added, 0);
  });

  it('marks 404 references as missing and tolerates fetch failures', async () => {
    globalThis.fetch = (async (url: any) => {
      if (String(url).includes('s-gone')) {
        return { ok: false, status: 404, json: async () => ({ error: 'not found' }) } as any;
      }
      throw new Error('network down');
    }) as any;
    try {
      const feature = new SessionReferenceFeature({ serverOrigin: 'http://server.test' });
      const injected: string[] = [];
      const ctx: any = {
        metadata: {
          'session-reference': [
            { agentId: 'a', sessionId: 's-gone' },
            { agentId: 'a', sessionId: 's-net' },
            { agentId: 'a' },
          ],
        },
        agent: {},
        context: { addSystemMessage(content: string) { injected.push(content); } },
      };

      await feature.injectSessionReferences(ctx);

      assert.equal(injected.length, 1);
      assert.match(injected[0], /s-gone.*已不存在/);
      assert.match(injected[0], /s-net.*读取入口暂不可用/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
