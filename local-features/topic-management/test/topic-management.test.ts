import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TopicManagementFeature } from '../src/index.js';

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
    const tools = feature.getTools();
    assert.deepEqual(tools.map(tool => tool.name), ['topic_list', 'topic_update']);
    const listed = await tools[0].execute({});
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

  it('updates one topic by topicId with only the provided fields', async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const feature = new TopicManagementFeature({
      fetchImpl: (async (url: string, init: { method?: string; body?: string } = {}) => {
        requests.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined });
        return response({ ok: true, topic: { id: 'relation_recent', title: '标题', summary: '', docs: [], commits: [], customTitle: true } });
      }),
    });
    const tools = feature.getTools();
    const updated: any = await tools[1].execute({ topicId: 'relation_recent', summary: '新的简介' });
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
    const tools = feature.getTools();
    await tools[1].execute({
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
    const tools = feature.getTools();
    assert.deepEqual(await tools[1].execute({}), { error: 'topicId 不能为空。' });
    assert.deepEqual(await tools[1].execute({ topicId: 'relation_recent' }), { error: '至少提供 title、summary、docs 或 commits 之一。' });
    assert.deepEqual(await tools[1].execute({ topicId: 'relation_recent', title: 42 }), { error: 'title 必须是字符串。' });
    assert.deepEqual(await tools[1].execute({ topicId: 'relation_recent', docs: 'docs/a.md' }), { error: 'docs 必须是字符串数组。' });
    assert.deepEqual(await tools[1].execute({ topicId: 'relation_recent', commits: [42] }), { error: 'commits 必须是字符串数组。' });
  });

  it('surfaces server errors without throwing', async () => {
    const feature = new TopicManagementFeature({
      fetchImpl: async () => response({ error: 'topic not found in current scope' }, false, 404),
    });
    const tools = feature.getTools();
    assert.deepEqual(await tools[1].execute({ topicId: 'relation_missing', title: 'x' }), {
      error: 'topic not found in current scope',
    });
  });
});
