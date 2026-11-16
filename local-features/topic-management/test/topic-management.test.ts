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
              memberCount: 3, updatedAt: '2026-11-15T10:00:00.000Z',
              threadIds: ['wt-a', 'wt-b'], threads: [{ threadId: 'wt-a' }],
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
      total: 1,
      partial: false,
      topics: [{
        topicId: 'relation_recent',
        title: '自定义主题',
        summary: '一句话简介',
        customTitle: true,
        conversations: 3,
        updatedAt: '2026-11-15T10:00:00.000Z',
      }],
    });
  });

  it('updates one topic by topicId with only the provided fields', async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const feature = new TopicManagementFeature({
      fetchImpl: (async (url: string, init: { method?: string; body?: string } = {}) => {
        requests.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined });
        return response({ ok: true, topic: { id: 'relation_recent', title: '标题', summary: '', customTitle: true } });
      }),
    });
    const tools = feature.getTools();
    const updated: any = await tools[1].execute({ topicId: 'relation_recent', summary: '新的简介' });
    assert.equal(updated.ok, true);
    assert.equal(requests[0].method, 'PUT');
    assert.equal(requests[0].url, 'http://127.0.0.1:14200/protoclaw/topic_groups/relation_recent?agentId=programming-helper');
    assert.deepEqual(requests[0].body, { summary: '新的简介' });
  });

  it('rejects missing topicId, empty update payload, and non-string fields', async () => {
    const feature = new TopicManagementFeature({ fetchImpl: async () => response({ ok: true }) });
    const tools = feature.getTools();
    assert.deepEqual(await tools[1].execute({}), { error: 'topicId 不能为空。' });
    assert.deepEqual(await tools[1].execute({ topicId: 'relation_recent' }), { error: '至少提供 title 或 summary 之一。' });
    assert.deepEqual(await tools[1].execute({ topicId: 'relation_recent', title: 42 }), { error: 'title 必须是字符串。' });
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
