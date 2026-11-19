import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TopicManagementFeature, renderTopicReferenceReminder } from '../src/index.js';

function response(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

describe('TopicManagementFeature', () => {
  it('lists existing topic groups via topic_groups, trimmed to board fields', async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const feature = new TopicManagementFeature({
      agentId: 'programming-helper',
      serverOrigin: 'http://runtime.test',
      fetchImpl: (async (url: string, init: { method?: string; body?: string } = {}) => {
        requests.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined });
        return response({
          partial: false,
          groups: [
            {
              id: 'relation_recent', title: '自定义主题', summary: '一句话简介', customTitle: true,
              docs: ['docs/adr/0047-lease.md — 租约决策'], commits: ['55f981a6 标注技能'],
              memberCount: 3, updatedAt: '2026-11-15T10:00:00.000Z',
              threadIds: ['wt-a', 'wt-b'], threads: [{ threadId: 'wt-a' }],
            },
            // 存量条目（无 docs / commits 字段）映射为空数组，缺省不炸。
            {
              id: 'relation_legacy', title: '存量主题', summary: '', customTitle: false,
              memberCount: 1, updatedAt: '2026-11-10T10:00:00.000Z',
              threadIds: ['wt-c'], threads: [],
            },
          ],
        });
      }),
    });
    const tool = (name: string) => feature.getTools().find(t => t.name === name)!;
    assert.deepEqual(feature.getTools().map(t => t.name), ['topic_list', 'topic_get', 'topic_update']);
    const listed = await tool('topic_list').execute({});
    assert.equal(requests[0].url, 'http://runtime.test/protoclaw/topic_groups?agentId=programming-helper');
    assert.equal(requests[0].method, 'GET');
    assert.deepEqual(listed, {
      total: 2,
      partial: false,
      topics: [
        {
          topicId: 'relation_recent',
          title: '自定义主题',
          summary: '一句话简介',
          docs: ['docs/adr/0047-lease.md — 租约决策'],
          commits: ['55f981a6 标注技能'],
          customTitle: true,
          conversations: 3,
          updatedAt: '2026-11-15T10:00:00.000Z',
        },
        {
          topicId: 'relation_legacy',
          title: '存量主题',
          summary: '',
          docs: [],
          commits: [],
          customTitle: false,
          conversations: 1,
          updatedAt: '2026-11-10T10:00:00.000Z',
        },
      ],
    });
  });

  it('topic_get returns one topic structured: annotations + member threads detail', async () => {
    const feature = new TopicManagementFeature({
      serverOrigin: 'http://runtime.test',
      fetchImpl: async () => response({
        groups: [
          {
            id: 'relation_recent', title: '自定义主题', summary: '一句话简介', customTitle: true,
            docs: ['docs/adr/0047-lease.md — 租约决策'], commits: ['55f981a6 标注技能'],
            memberCount: 2, updatedAt: '2026-11-15T10:00:00.000Z',
            threads: [
              {
                threadId: 'wt-a', title: '线程A', agentId: 'programming-helper', generations: 3,
                sessionIds: ['s-1', 's-2', 's-3'], headSessionId: 's-3', updatedAt: '2026-11-15T10:00:00.000Z',
              },
              // 存量成员（字段缺省）映射为空值，不炸。
              { threadId: 'wt-b' },
            ],
          },
        ],
      }),
    });
    const tool = (name: string) => feature.getTools().find(t => t.name === name)!;
    const result: any = await tool('topic_get').execute({ topicId: 'relation_recent' });
    assert.equal(result.topic.topicId, 'relation_recent');
    assert.equal(result.topic.conversations, 2);
    assert.deepEqual(result.topic.docs, ['docs/adr/0047-lease.md — 租约决策']);
    assert.deepEqual(result.topic.threads, [
      {
        threadId: 'wt-a', title: '线程A', agentId: 'programming-helper', generations: 3,
        sessionCount: 3, headSessionId: 's-3', updatedAt: '2026-11-15T10:00:00.000Z',
      },
      {
        threadId: 'wt-b', title: '', agentId: '', generations: 0,
        sessionCount: 0, headSessionId: '', updatedAt: '',
      },
    ]);
  });

  it('topic_get rejects missing topicId, unknown topic, and degraded listing', async () => {
    // topic_groups 按 agentId 寻址（URL 不含 topicId），三种场景各用独立实例
    // 表达服务端形态，避免在 mock 里按 URL 猜路由。
    const makeTopicGet = (fetchImpl: any) => new TopicManagementFeature({
      serverOrigin: 'http://runtime.test',
      fetchImpl,
    }).getTools().find(t => t.name === 'topic_get')!;
    // 空参校验在请求发出前拦截（mock 会炸，证明没有网络面）
    assert.deepEqual(await makeTopicGet(async () => { throw new Error('must not fetch'); }).execute({}), { error: 'topicId 不能为空。' });
    const notFound: any = await makeTopicGet(async () => response({ groups: [{ id: 'relation_other' }] }))
      .execute({ topicId: 'relation_gone' });
    assert.match(notFound.error, /主题不存在或已被重组/);
    assert.match(notFound.error, /topic_list/);
    const degraded: any = await makeTopicGet(async () => { throw new Error('network down'); })
      .execute({ topicId: 'relation_recent' });
    assert.match(degraded.error, /读取失败/);
  });

  it('updates one topic by topicId with only the provided fields', async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const feature = new TopicManagementFeature({
      fetchImpl: (async (url: string, init: { method?: string; body?: string } = {}) => {
        requests.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined });
        return response({ ok: true, topic: { id: 'relation_recent', title: '标题', summary: '', docs: [], commits: [], customTitle: true } });
      }),
    });
    const tool = (name: string) => feature.getTools().find(t => t.name === name)!;
    const updated: any = await tool('topic_update').execute({ topicId: 'relation_recent', summary: '新的简介' });
    assert.equal(updated.ok, true);
    assert.equal(requests[0].method, 'PUT');
    assert.equal(requests[0].url, 'http://127.0.0.1:14200/protoclaw/topic_groups/relation_recent?agentId=programming-helper');
    assert.deepEqual(requests[0].body, { summary: '新的简介' });
  });

  it('sends docs and commits as cleaned string arrays (trim, blanks dropped)', async () => {
    const requests: Array<{ body?: unknown }> = [];
    const feature = new TopicManagementFeature({
      fetchImpl: (async (url: string, init: { body?: string } = {}) => {
        requests.push({ body: init.body ? JSON.parse(init.body) : undefined });
        return response({ ok: true });
      }),
    });
    const tool = (name: string) => feature.getTools().find(t => t.name === name)!;
    await tool('topic_update').execute({
      topicId: 'relation_recent',
      docs: ['  docs/plan.md — 计划  ', ''],
      commits: ['  ', '55f981a6 标注技能'],
    });
    assert.deepEqual(requests[0].body, {
      docs: ['docs/plan.md — 计划'],
      commits: ['55f981a6 标注技能'],
    });
  });

  it('rejects missing topicId, empty update payload, and wrong field types', async () => {
    const feature = new TopicManagementFeature({ fetchImpl: async () => response({ ok: true }) });
    const tool = (name: string) => feature.getTools().find(t => t.name === name)!;
    assert.deepEqual(await tool('topic_update').execute({}), { error: 'topicId 不能为空。' });
    assert.deepEqual(await tool('topic_update').execute({ topicId: 'relation_recent' }), { error: '至少提供 title、summary、docs 或 commits 之一。' });
    assert.deepEqual(await tool('topic_update').execute({ topicId: 'relation_recent', title: 42 }), { error: 'title 必须是字符串。' });
    assert.deepEqual(await tool('topic_update').execute({ topicId: 'relation_recent', docs: 'docs/a.md' }), { error: 'docs 必须是字符串数组。' });
    assert.deepEqual(await tool('topic_update').execute({ topicId: 'relation_recent', commits: [42] }), { error: 'commits 必须是字符串数组。' });
  });

  it('surfaces server errors without throwing', async () => {
    const feature = new TopicManagementFeature({
      fetchImpl: async () => response({ error: 'topic not found in current scope' }, false, 404),
    });
    const tool = (name: string) => feature.getTools().find(t => t.name === name)!;
    assert.deepEqual(await tool('topic_update').execute({ topicId: 'relation_missing', title: 'x' }), {
      error: 'topic not found in current scope',
    });
  });
});

// ── 主题引用注入（CallStart hook / onTurnMetadata 双入口行为） ──────────

describe('injectTopicReferences', () => {
  it('injects one pointer-style reminder with topic meta info and consumes once per turn', async () => {
    const urls: string[] = [];
    const feature = new TopicManagementFeature({
      serverOrigin: 'http://server.test',
      fetchImpl: (async (url: string) => {
        urls.push(String(url));
        return response({
          groups: [
            {
              id: 'relation_a', title: '前端 ESM 绞杀者迁移', summary: '现象 → 做法 → 结果锚点',
              docs: ['docs/adr/0051-frontend-esm-strangler-migration.md'], commits: ['55f981a6 迁移批次'],
              memberCount: 5,
            },
          ],
        });
      }),
    });
    const injected: Array<{ content: string; turn: number; source?: string; tag?: string }> = [];
    const ctx: any = {
      metadata: {
        'topic-management': [
          { agentId: 'programming-helper', topicId: 'relation_a', title: '拖拽时的旧标题' },
          { agentId: 'programming-helper', topicId: 'relation_b' },
        ],
      },
      agent: { _callIndex: 3 },
      context: {
        addSystemMessage(content: string, turn: number, source?: string, tag?: string) {
          injected.push({ content, turn, source, tag });
        },
      },
    };

    await feature.injectTopicReferences(ctx);

    assert.equal(injected.length, 1);
    assert.equal(injected[0].turn, 3);
    assert.equal(injected[0].source, 'topic-management');
    assert.equal(injected[0].tag, 'reminder');
    // 服务端标注优先于拖拽快照标题；元信息（简介/参考文档/相关提交/对话数）随引用注入
    assert.match(injected[0].content, /relation_a「前端 ESM 绞杀者迁移」 — agentId: programming-helper（5 个对话）/);
    assert.match(injected[0].content, /简介: 现象 → 做法 → 结果锚点/);
    assert.match(injected[0].content, /参考文档: docs\/adr\/0051-frontend-esm-strangler-migration\.md/);
    assert.match(injected[0].content, /相关提交: 55f981a6 迁移批次/);
    // 列表有但 id 缺席 → missing 明示，不静默丢弃
    assert.match(injected[0].content, /relation_b — agentId: programming-helper（0 个对话） — 主题已不存在/);
    // 尾行指引 topic_get（成员明细不随引用注入）
    assert.match(injected[0].content, /topic_get/);
    // 同一 agentId 的两个条目共享一次 topic_groups 拉取（Promise 去重）
    assert.equal(urls.filter(url => url.includes('topic_groups')).length, 1);
  });

  it('is a no-op when the turn carries no topic references', async () => {
    const feature = new TopicManagementFeature({
      serverOrigin: 'http://server.test',
      fetchImpl: async () => { throw new Error('must not fetch'); },
    });
    let added = 0;
    const ctx: any = {
      metadata: { 'session-reference': [{ agentId: 'a', sessionId: 's-1' }] },
      agent: {},
      context: { addSystemMessage() { added += 1; } },
    };
    await feature.injectTopicReferences(ctx);
    assert.equal(added, 0);
  });

  it('marks fetch failure as unknown (not missing) and still injects', async () => {
    const feature = new TopicManagementFeature({
      serverOrigin: 'http://server.test',
      fetchImpl: async () => { throw new Error('network down'); },
    });
    const injected: string[] = [];
    const ctx: any = {
      metadata: { 'topic-management': [{ topicId: 'relation_a', title: '快照标题' }] },
      agent: {},
      context: { addSystemMessage(content: string) { injected.push(content); } },
    };
    await feature.injectTopicReferences(ctx);
    assert.equal(injected.length, 1);
    assert.match(injected[0], /relation_a「快照标题」/);
    assert.match(injected[0], /主题详情暂不可用/);
  });

  it('onTurnMetadata injects the same shape as CallStart (busy-queue dispatch path)', async () => {
    const feature = new TopicManagementFeature({
      serverOrigin: 'http://server.test',
      fetchImpl: async () => response({ groups: [{ id: 'relation_a', title: '运行中追加', memberCount: 1 }] }),
    });
    const injected: Array<{ content: string; turn: number; source?: string; tag?: string }> = [];
    const context: any = {
      addSystemMessage(content: string, turn: number, source?: string, tag?: string) {
        injected.push({ content, turn, source, tag });
      },
    };

    await feature.onTurnMetadata(
      [{ agentId: 'programming-helper', topicId: 'relation_a' }],
      { context, agent: { _callIndex: 5 } },
    );

    assert.equal(injected.length, 1);
    assert.equal(injected[0].turn, 5);
    assert.equal(injected[0].source, 'topic-management');
    assert.equal(injected[0].tag, 'reminder');
    assert.match(injected[0].content, /relation_a「运行中追加」/);
  });

  it('onTurnMetadata drops non-array payloads and entries without topicId', async () => {
    const feature = new TopicManagementFeature({
      serverOrigin: 'http://server.test',
      fetchImpl: async () => { throw new Error('must not fetch'); },
    });
    let added = 0;
    const context: any = { addSystemMessage() { added += 1; } };
    await feature.onTurnMetadata('not-an-array', { context });
    await feature.onTurnMetadata(null, { context });
    await feature.onTurnMetadata([{ title: 'no topicId' }], { context });
    assert.equal(added, 0);
  });
});

describe('renderTopicReferenceReminder', () => {
  it('clips long list fields with an overflow marker instead of dumping everything', () => {
    const docs = Array.from({ length: 12 }, (_, i) => `docs/adr/00${i}.md`);
    const text = renderTopicReferenceReminder([{
      agentId: 'programming-helper', topicId: 'relation_a', title: '标题', summary: '简介',
      docs, commits: [], conversations: 2, availability: 'ok',
    }]);
    assert.match(text, /docs\/adr\/000\.md、docs\/adr\/001\.md/);
    assert.match(text, /等 12 条/);
  });
});
