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
  renderThreadOverview,
  isThreadId,
  SessionReferenceFeature,
  type VerifiedSessionReference,
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

  it('returns all messages of the requested turn unclipped within budget', () => {
    const detail = renderTurnDetail(messages as any, 1, { agentId: 'ph', sessionId: 's' });
    assert.equal(detail!.truncated, false);
    assert.match(detail!.text, /全量，共 2 条消息/);
    assert.match(detail!.text, /\[T1\] assistant: 第一轮回复/);
    assert.match(detail!.text, /→ 调用 read\(\{"filePath":"\/x"\}\)/);
    assert.match(detail!.text, /\[T1\] tool 结果\(c1\): 文件内容/);
  });

  it('keeps head and tail with an explicit marker when a turn exceeds the budget', () => {
    // 单轮正文超出预算：首尾各半保留、中段省略并明示，避免巨型工具结果直灌上下文。
    const head = '意图'.padEnd(200, '前');
    const tail = '结论'.padStart(200, '后');
    const long = `${head}${'x'.repeat(80_000)}${tail}`;
    const detail = renderTurnDetail(
      [{ role: 'tool', content: long, turn: 0, toolCallId: 'c1' }] as any,
      0,
      { agentId: 'a', sessionId: 's' },
    );
    assert.equal(detail!.truncated, true);
    assert.ok(detail!.omittedChars > 0);
    assert.match(detail!.text, /中段省略 \d+ 字符/);
    // 首部（用户意图侧）与尾部（结论侧）都在，中段巨型内容被省略：
    // 原文 80_000 个 x，保留的首尾合计不超过预算
    assert.ok(detail!.text.includes(head));
    assert.ok(detail!.text.includes(tail));
    const keptX = detail!.text.split('x').length - 1;
    assert.ok(keptX < 45_000, `保留的 x 数量应收敛到预算内，实际 ${keptX}`);
    // 正文体量收敛到预算附近，而不是原始 80K+
    assert.ok(detail!.text.length < 45_000);
  });

  it('returns null for an unknown turn', () => {
    assert.equal(renderTurnDetail(messages as any, 99, { agentId: 'a', sessionId: 's' }), null);
    assert.equal(renderTurnDetail([] as any, 0, { agentId: 'a', sessionId: 's' }), null);
  });
});

// ── renderReferenceReminder（引用注入 reminder） ─────────────────

describe('renderReferenceReminder', () => {
  it('renders id + title + agentId(verbatim)/sessionType with the AI-title disclaimer', () => {
    const references: VerifiedSessionReference[] = [
      { agentId: 'programming-helper', sessionId: 'session-1789456315259-15c389', title: '修复登录超时', sessionType: 'main', availability: 'ok' },
      { agentId: 'agent-studio', sessionId: 'session-1789431188614-41ceab', title: '重构导出逻辑', sessionType: 'main', availability: 'ok' },
    ];
    const text = renderReferenceReminder(references);
    assert.match(text, /^\[会话引用\] 用户在本条消息中引用了以下会话/);
    assert.match(text, /标题由 AI 自动生成，仅供参考，不能代表会话真实内容与方向/);
    assert.match(text, /- session-1789456315259-15c389「修复登录超时」 — agentId: programming-helper（身份: main）/);
    assert.match(text, /- session-1789431188614-41ceab「重构导出逻辑」 — agentId: agent-studio（身份: main）/);
    assert.match(text, /session_read_overview/);
    assert.match(text, /session_read_turn/);
    // 契约：agentId 标注必须是可原样填参的纯值，禁止复合 token（历史 bug：
    // `agent: xxx/main` 被 AI 整串当 agentId 传入导致下游 404）
    for (const ref of references) {
      assert.ok(text.includes(`agentId: ${ref.agentId}（`), `agentId 标注应原样包含纯 agentId: ${ref.agentId}`);
    }
    assert.doesNotMatch(text, /agent: /);
    assert.doesNotMatch(text, /agentId: [^（\s]+\/[^\s）]/);
  });

  it('marks missing sessions explicitly instead of silently dropping them', () => {
    const text = renderReferenceReminder([
      { agentId: 'a', sessionId: 's-1', title: '', sessionType: 'main', availability: 'missing' },
    ]);
    assert.match(text, /- s-1 — agentId: a（身份: main） — 已不存在/);
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
      assert.match(injected[0].content, /s-1「修复登录超时」 — agentId: programming-helper（身份: main）/);
      assert.match(injected[0].content, /s-2 — agentId: agent-studio（身份: main）/);
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

  it('onTurnMetadata injects the reminder at the in-call dispatch point (same shape as CallStart)', async () => {
    // call 内注入入口（agent 忙时排队的消息经 dispatchTurnMetadata 派发）：
    // 注入产物与 CallStart 路径完全一致，两个入口共享同一注入逻辑。
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ messages: [] }) })) as any;
    try {
      const feature = new SessionReferenceFeature({ serverOrigin: 'http://server.test' });
      const injected: Array<{ content: string; turn: number; source?: string; tag?: string }> = [];
      const context: any = {
        addSystemMessage(content: string, turn: number, source?: string, tag?: string) {
          injected.push({ content, turn, source, tag });
        },
      };

      await feature.onTurnMetadata(
        [{ agentId: 'programming-helper', sessionId: 's-1', title: '运行中追加', sessionType: 'main' }],
        { context, agent: { _callIndex: 5 } },
      );

      assert.equal(injected.length, 1);
      assert.equal(injected[0].turn, 5);
      assert.equal(injected[0].source, 'session-reference');
      assert.equal(injected[0].tag, 'reminder');
      assert.match(injected[0].content, /s-1「运行中追加」/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('onTurnMetadata is a no-op for non-array payloads', async () => {
    const feature = new SessionReferenceFeature({ serverOrigin: 'http://server.test' });
    let added = 0;
    const context: any = { addSystemMessage() { added += 1; } };
    await feature.onTurnMetadata('not-an-array', { context });
    await feature.onTurnMetadata(null, { context });
    assert.equal(added, 0);
  });
});

// ── 读取工具契约：双模寻址（sessionId 必填；agentId 仅会话输入必填） ──

describe('read tools address sessions by the (agentId, sessionId) pair', () => {
  const realFetch = globalThis.fetch;

  it('requires sessionId in the schema; agentId is runtime-checked per input mode', () => {
    const feature = new SessionReferenceFeature({ serverOrigin: 'http://server.test' });
    const tools = new Map(feature.getTools().map((tool) => [tool.name, tool]));
    // 双模后 agentId 从 schema 必填降为运行时校验：sessionId 输入必填
    // （下方用例覆盖），threadId 输入无需提供（线程全局唯一）。
    assert.deepEqual(tools.get('session_read_overview')!.parameters!.required, ['sessionId']);
    assert.deepEqual(tools.get('session_read_turn')!.parameters!.required, ['sessionId', 'turn', 'agentId']);
  });

  it('rejects reads without an explicit agentId before any request goes out', async () => {
    const feature = new SessionReferenceFeature({ serverOrigin: 'http://server.test' });
    const tools = new Map(feature.getTools().map((tool) => [tool.name, tool]));
    let fetched = 0;
    globalThis.fetch = (async () => {
      fetched += 1;
      return { ok: true, status: 200, json: async () => ({ messages: [] }) } as any;
    }) as any;
    try {
      const overview = await (tools.get('session_read_overview')!.execute as any)({ sessionId: 's-1' });
      assert.match(String(overview?.error), /agentId is required/);
      const turn = await (tools.get('session_read_turn')!.execute as any)({ sessionId: 's-1', turn: 1 });
      assert.match(String(turn?.error), /agentId is required/);
      assert.equal(fetched, 0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// ── 读取工具执行层：按轮取回、空结果回退、翻页 ─────────────────────

describe('read tools transport and paging', () => {
  const realFetch = globalThis.fetch;

  function makeTools() {
    const feature = new SessionReferenceFeature({ serverOrigin: 'http://server.test' });
    return new Map(feature.getTools().map((tool) => [tool.name, tool]));
  }

  it('read_turn requests the turn-scoped endpoint and returns that turn only', async () => {
    const tools = makeTools();
    const urls: string[] = [];
    globalThis.fetch = (async (url: any) => {
      urls.push(String(url));
      return {
        ok: true,
        status: 200,
        json: async () => ({ messages: [{ role: 'assistant', content: 'T2 回复', turn: 2 }] }),
      } as any;
    }) as any;
    try {
      const result = await (tools.get('session_read_turn')!.execute as any)({
        agentId: 'ph', sessionId: 's-1', turn: 2,
      });
      assert.equal(urls.length, 1);
      assert.match(urls[0], /session_record\?agentId=ph&sessionId=s-1&turn=2/);
      assert.match(result.text, /T2 回复/);
      assert.equal(result.messageCount, 1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('read_turn falls back to a full fetch once when the turn is missing (keeps availableTurns)', async () => {
    const tools = makeTools();
    const urls: string[] = [];
    globalThis.fetch = (async (url: any) => {
      urls.push(String(url));
      // 首次（按轮取回）为空 → 回退全量；全量里也没有 T9
      if (String(url).includes('turn=9')) {
        return { ok: true, status: 200, json: async () => ({ messages: [] }) } as any;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          messages: [
            { role: 'user', content: 'q', turn: 0 },
            { role: 'assistant', content: 'a', turn: 1 },
          ],
        }),
      } as any;
    }) as any;
    try {
      const result = await (tools.get('session_read_turn')!.execute as any)({
        agentId: 'ph', sessionId: 's-1', turn: 9,
      });
      assert.equal(urls.length, 2);
      assert.match(urls[0], /turn=9/);
      assert.ok(!urls[1].includes('turn='));
      assert.match(String(result.error), /轮次 9 不存在/);
      assert.deepEqual(result.availableTurns, [0, 1]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('session_list passes offset through and marks the range in the text', async () => {
    const tools = makeTools();
    const urls: string[] = [];
    globalThis.fetch = (async (url: any) => {
      urls.push(String(url));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sessions: [{ agentId: 'ph', sessionId: 's-9', title: 't', updatedAt: '2026-10-08T00:00:00Z', messageCount: 1 }],
        }),
      } as any;
    }) as any;
    try {
      const result = await (tools.get('session_list')!.execute as any)({ limit: 5, offset: 10 });
      assert.equal(urls.length, 1);
      assert.match(urls[0], /session_directory\?limit=5&offset=10/);
      assert.match(result.text, /第 11 条起/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// ── 线程双模：threadId 输入 → 代际导航索引 ─────────────────────────

describe('thread navigation (dual-mode session_read_overview)', () => {
  const realFetch = globalThis.fetch;

  function makeTools() {
    const feature = new SessionReferenceFeature({ serverOrigin: 'http://server.test' });
    return new Map(feature.getTools().map((tool) => [tool.name, tool]));
  }

  it('isThreadId distinguishes thread ids from session ids by the wt- prefix', () => {
    assert.equal(isThreadId('wt-4fbff1b4-d88a-4285-8bcd-78b23fee35a8'), true);
    assert.equal(isThreadId('session-1791714788565-3ec628'), false);
    assert.equal(isThreadId(''), false);
  });

  it('renders the generation chain with head/root marks and verbatim agentId labels', () => {
    const thread = {
      threadId: 'wt-x',
      agentId: 'coder',
      title: '审查最近更改',
      lifeState: 'archived',
      rootSessionId: 's-1',
      headSessionId: 's-3',
      createdAt: 1791714788613,
      updatedAt: 1791718001021,
    };
    // sessionChainMeta 契约：服务端按代倒序（最新在前），每代合并索引元数据
    const chainMeta = [
      { sessionId: 's-3', title: 'head 代标题', startedAt: 1791716209735, endedAt: null, endKind: null, messageCount: 12, archived: false },
      { sessionId: 's-2', title: '第 2 代标题', startedAt: 1791716138277, endedAt: 1791716209735, endKind: 'trim', messageCount: 8, archived: false },
      { sessionId: 's-1', title: '起始代标题', startedAt: 1791714788565, endedAt: 1791716138277, endKind: 'trim', messageCount: 20, archived: true },
    ];
    const text = renderThreadOverview(thread as any, chainMeta as any);
    assert.match(text, /\[线程导航\] wt-x「审查最近更改」/);
    assert.match(text, /agent: coder ｜ 状态: 已归档/);
    assert.match(text, /共 3 代/);
    // head 代：最新标记 + 进行中（无 endedAt）+ agentId 纯值可原样填参
    assert.match(text, /- \[第 3 代·最新\] s-3「head 代标题」 \(12 条消息, [^)]+~ 进行中\) — agentId: coder/);
    // 中间代：接续方式透出
    assert.match(text, /- \[第 2 代\] s-2「第 2 代标题」 \([^)]*接续: trim[^)]*\)/);
    // 起始代：root 标记 + 归档态
    assert.match(text, /- \[第 1 代·起始\] s-1「起始代标题」 \([^)]*会话已归档[^)]*\) — agentId: coder/);
    assert.match(text, /阅读策略：最新代承载当前结论/);
  });

  it('falls back to the thread record sessionChain (reversed) when sessionChainMeta is absent', () => {
    const thread = {
      threadId: 'wt-y',
      agentId: 'coder',
      title: '接力线程',
      headSessionId: 's-b',
      // 线程记录的 sessionChain 为正序（最老在前），导航视图必须倒序呈现
      sessionChain: [
        { sessionId: 's-a', role: 'predecessor', startedAt: 1, endedAt: 2, endKind: 'trim' },
        { sessionId: 's-b', role: 'head', startedAt: 2, endedAt: null, endKind: null },
      ],
    };
    const text = renderThreadOverview(thread as any);
    assert.match(text, /共 2 代/);
    assert.match(text, /- \[第 2 代·最新\] s-b \(/);
    assert.ok(text.indexOf('s-b') < text.indexOf('s-a'), '最新代应排在最老代之前');
  });

  it('renders an explicit empty note when the chain has no entries', () => {
    const text = renderThreadOverview({ threadId: 'wt-z', agentId: 'a' } as any, []);
    assert.match(text, /无线程代际记录/);
  });

  it('routes wt- input to the thread detail endpoint without requiring agentId', async () => {
    const tools = makeTools();
    const urls: string[] = [];
    globalThis.fetch = (async (url: any) => {
      urls.push(String(url));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          thread: { threadId: 'wt-live', agentId: 'coder', title: 'T', headSessionId: 's-9' },
          sessionChainMeta: [
            { sessionId: 's-9', title: 'head', startedAt: 5, endedAt: null, messageCount: 3 },
          ],
        }),
      } as any;
    }) as any;
    try {
      const result = await (tools.get('session_read_overview')!.execute as any)({ sessionId: 'wt-live' });
      assert.equal(urls.length, 1);
      assert.match(urls[0], /\/protoclaw\/threads\/wt-live$/);
      assert.match(result.text, /\[线程导航\] wt-live/);
      assert.equal(result.threadId, 'wt-live');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('turns a thread 404 into a readable error that guides back to session ids', async () => {
    const tools = makeTools();
    globalThis.fetch = (async () => ({
      ok: false,
      status: 404,
      json: async () => ({ message: 'Thread not found' }),
    })) as any;
    try {
      const result = await (tools.get('session_read_overview')!.execute as any)({ sessionId: 'wt-none' });
      assert.match(String(result.error), /线程不存在: wt-none/);
      assert.match(String(result.error), /sessionId/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('session_list annotates thread ownership per entry and leaves plain sessions unannotated', async () => {
    const tools = makeTools();
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        sessions: [
          { agentId: 'coder', sessionId: 's-3', title: 'head 代', updatedAt: '2026-10-11T20:00:00Z', messageCount: 5, threadId: 'wt-abc', threadTitle: '审查最近更改' },
          { agentId: 'ph', sessionId: 's-7', title: '普通会话', updatedAt: '2026-10-10T10:00:00Z', messageCount: 2 },
        ],
      }),
    })) as any;
    try {
      const result = await (tools.get('session_list')!.execute as any)({});
      assert.match(result.text, /— 线程 wt-abc「审查最近更改」/);
      const plainLine = result.text.split('\n').find((line: string) => line.includes('s-7'))!;
      assert.ok(plainLine, '普通会话条目应存在');
      assert.doesNotMatch(plainLine, /— 线程/, '无线程归属的条目不应带线程标注');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
