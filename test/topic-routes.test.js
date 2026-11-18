/**
 * 主题簇管理路由集成测试：PUT /protoclaw/topic_groups/:topicId 的全链路
 * （真实 express app + HTTP），覆盖写入、部分更新、标注清除与错误分支。
 * 跑在隔离临时数据根上，不读真实用户数据目录。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { setupSessionRelationsRoutes } from '../server/session-relations/routes.js';
import { resetRelationsMemo } from '../server/session-relations/projection.js';

const REF_HEADER = '[会话引用] 用户在本条消息中引用了以下会话（标题由 AI 自动生成，仅供参考）：';

let dataRoot;
let server;
let baseUrl;
let clusterId;

async function writeFixture() {
  const sessionsDir = path.join(dataRoot, 'workspaces', 'programming-helper', 'sessions');
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.mkdir(path.join(dataRoot, 'threads'), { recursive: true });
  await fs.writeFile(path.join(sessionsDir, 'index.json'), JSON.stringify({ sessions: [
    { id: 's-a', title: '会话甲', updatedAt: '2026-11-15T10:00:00.000Z' },
    { id: 's-b', title: '会话乙', updatedAt: '2026-11-15T09:00:00.000Z' },
  ] }));
  await fs.writeFile(path.join(sessionsDir, 's-a.json'), JSON.stringify({
    runtime: { context: { messages: [
      { role: 'system', source: 'session-reference', content: `${REF_HEADER}\n- s-b「会话乙」 — agentId: programming-helper（身份: main）` },
    ] } },
  }));
  await fs.writeFile(path.join(sessionsDir, 's-b.json'), JSON.stringify({ runtime: { context: { messages: [] } } }));
  await fs.writeFile(path.join(dataRoot, 'threads', 'index.json'), JSON.stringify({ threads: [
    { threadId: 'wt-a', workspaceId: 'programming-helper', title: '', sessionIds: ['s-a'] },
    { threadId: 'wt-b', workspaceId: 'programming-helper', title: '', sessionIds: ['s-b'] },
  ] }));
}

before(async () => {
  dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claw-topic-routes-'));
  await writeFixture();
  const app = express();
  setupSessionRelationsRoutes(app, { dataRoot });
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const initial = await (await fetch(`${baseUrl}/protoclaw/topic_groups?agentId=programming-helper`)).json();
  clusterId = initial.groups[0].id;
});

after(async () => {
  resetRelationsMemo();
  await new Promise(resolve => server.close(resolve));
  await fs.rm(dataRoot, { recursive: true, force: true }).catch(() => {});
});

describe('PUT /protoclaw/topic_groups/:topicId', () => {
  it('writes title and summary, then GET serves the merged board fields', async () => {
    const put = await fetch(`${baseUrl}/protoclaw/topic_groups/${clusterId}?agentId=programming-helper`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '主题看板重构', summary: '会话引用连通分量看板的重设计' }),
    });
    assert.equal(put.status, 200);
    assert.deepEqual(await put.json(), {
      ok: true,
      topic: { id: clusterId, title: '主题看板重构', summary: '会话引用连通分量看板的重设计', docs: [], commits: [], customTitle: true },
    });
    const board = await (await fetch(`${baseUrl}/protoclaw/topic_groups?agentId=programming-helper`)).json();
    const group = board.groups.find(entry => entry.id === clusterId);
    assert.equal(group.title, '主题看板重构');
    assert.equal(group.summary, '会话引用连通分量看板的重设计');
    assert.equal(group.customTitle, true);
    assert.deepEqual(group.docs, []);
    assert.deepEqual(group.commits, []);
  });

  it('updates only summary and keeps the existing title', async () => {
    const put = await fetch(`${baseUrl}/protoclaw/topic_groups/${clusterId}?agentId=programming-helper`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: '只改简介' }),
    });
    assert.equal(put.status, 200);
    const payload = await put.json();
    assert.equal(payload.topic.title, '主题看板重构');
    assert.equal(payload.topic.summary, '只改简介');
  });

  it('rejects unknown topic ids, empty payloads and non-string fields', async () => {
    const unknown = await fetch(`${baseUrl}/protoclaw/topic_groups/relation_nope?agentId=programming-helper`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    });
    assert.equal(unknown.status, 404);
    const empty = await fetch(`${baseUrl}/protoclaw/topic_groups/${clusterId}?agentId=programming-helper`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(empty.status, 400);
    const badType = await fetch(`${baseUrl}/protoclaw/topic_groups/${clusterId}?agentId=programming-helper`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 42 }),
    });
    assert.equal(badType.status, 400);
  });

  it('clearing both fields removes the note and restores the fallback title', async () => {
    const put = await fetch(`${baseUrl}/protoclaw/topic_groups/${clusterId}?agentId=programming-helper`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '', summary: '' }),
    });
    assert.equal(put.status, 200);
    assert.equal((await put.json()).topic.customTitle, false);
    const board = await (await fetch(`${baseUrl}/protoclaw/topic_groups?agentId=programming-helper`)).json();
    const group = board.groups.find(entry => entry.id === clusterId);
    assert.equal(group.customTitle, false);
    assert.equal(group.title, '会话甲'); // head session 标题兜底
    assert.equal(group.summary, '');
  });

  it('writes docs and commits entries (trimmed, blanks dropped), keeps them across partial updates', async () => {
    const put = await fetch(`${baseUrl}/protoclaw/topic_groups/${clusterId}?agentId=programming-helper`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '标注字段扩展',
        docs: ['  docs/adr/0047-lease.md — 租约决策  ', '', 'https://example.com/plan'],
        commits: ['55f981a6 主题标注风格落成技能'],
      }),
    });
    assert.equal(put.status, 200);
    const payload = await put.json();
    assert.deepEqual(payload.topic.docs, ['docs/adr/0047-lease.md — 租约决策', 'https://example.com/plan']);
    assert.deepEqual(payload.topic.commits, ['55f981a6 主题标注风格落成技能']);
    // 只改 title：docs / commits 未提供，必须保留现值（部分更新不误伤）。
    const retitle = await fetch(`${baseUrl}/protoclaw/topic_groups/${clusterId}?agentId=programming-helper`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '标注字段扩展（改题）' }),
    });
    assert.equal(retitle.status, 200);
    const board = await (await fetch(`${baseUrl}/protoclaw/topic_groups?agentId=programming-helper`)).json();
    const group = board.groups.find(entry => entry.id === clusterId);
    assert.deepEqual(group.docs, ['docs/adr/0047-lease.md — 租约决策', 'https://example.com/plan']);
    assert.deepEqual(group.commits, ['55f981a6 主题标注风格落成技能']);
  });

  it('rejects non-string-array docs/commits without touching the stored note', async () => {
    const boardBefore = await (await fetch(`${baseUrl}/protoclaw/topic_groups?agentId=programming-helper`)).json();
    const before = boardBefore.groups.find(entry => entry.id === clusterId);
    const notArray = await fetch(`${baseUrl}/protoclaw/topic_groups/${clusterId}?agentId=programming-helper`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docs: 'docs/a.md' }),
    });
    assert.equal(notArray.status, 400);
    const badItem = await fetch(`${baseUrl}/protoclaw/topic_groups/${clusterId}?agentId=programming-helper`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commits: [42] }),
    });
    assert.equal(badItem.status, 400);
    const boardAfter = await (await fetch(`${baseUrl}/protoclaw/topic_groups?agentId=programming-helper`)).json();
    const after = boardAfter.groups.find(entry => entry.id === clusterId);
    assert.deepEqual(after.docs, before.docs, 'rejected writes must not touch stored docs');
    assert.deepEqual(after.commits, before.commits);
  });

  it('keeps the note while docs remain, then removes it when all four fields are cleared', async () => {
    // 删除条目的条件是四个内容字段全空：title/summary 清空但 docs 仍有
    // 条目时标注必须保留（旧实现只看 title+summary，此处锁住新契约）。
    const clearText = await fetch(`${baseUrl}/protoclaw/topic_groups/${clusterId}?agentId=programming-helper`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '', summary: '' }),
    });
    assert.equal(clearText.status, 200);
    const midBoard = await (await fetch(`${baseUrl}/protoclaw/topic_groups?agentId=programming-helper`)).json();
    const mid = midBoard.groups.find(entry => entry.id === clusterId);
    assert.equal(mid.customTitle, false);
    assert.deepEqual(mid.docs, ['docs/adr/0047-lease.md — 租约决策', 'https://example.com/plan'], 'docs keep the note alive');
    // 全部清空（数组空 = 清除字段）→ 条目删除，看板回退。
    const clearAll = await fetch(`${baseUrl}/protoclaw/topic_groups/${clusterId}?agentId=programming-helper`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '', summary: '', docs: [], commits: [] }),
    });
    assert.equal(clearAll.status, 200);
    const finalBoard = await (await fetch(`${baseUrl}/protoclaw/topic_groups?agentId=programming-helper`)).json();
    const finalGroup = finalBoard.groups.find(entry => entry.id === clusterId);
    assert.equal(finalGroup.title, '会话甲');
    assert.deepEqual(finalGroup.docs, []);
    assert.deepEqual(finalGroup.commits, []);
  });
});
