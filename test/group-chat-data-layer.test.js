/**
 * Tests for Group Chat data layer + dispatch prompt composition.
 *
 * Imports REAL functions from server/routes/group-chat.js and
 * server/routes/session-helpers.js — no inline mirror.
 *
 * Covers:
 * 1. composeDispatchPrompt — prompt building with text + links
 * 2. searchInText — snippet extraction, role detection, edge cases
 * 3. Group Chat CRUD — write/read/list/append/updateMessageRouting round-trip
 * 4. aggregateSessionPool — session pool aggregation from 3 sources
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';

import {
  composeDispatchPrompt,
  aggregateSessionPool,
  buildSessionContextUsage,
  buildSessionLatestMessage,
  buildThreadTaskSummary,
  deriveThreadWorkStatus,
  groupByLineage,
  createGroupChatDataLayer,
  normalizeGroupChatMembers,
} from '../server/routes/group-chat.js';
import { searchInTextPure as searchInText } from '../server/routes/session-helpers.js';

// ── Tests: composeDispatchPrompt ──

describe('composeDispatchPrompt', () => {
  it('returns just the message text when no links', () => {
    const prompt = composeDispatchPrompt({ text: '请检查这段代码' });
    assert.equal(prompt, '请检查这段代码');
  });

  it('uses empty string when message.text is missing', () => {
    const prompt = composeDispatchPrompt({});
    assert.equal(prompt, '');
  });

  it('appends links section when links present', () => {
    const prompt = composeDispatchPrompt({
      text: '看下这个',
      links: [
        { url: 'https://example.com/1', description: '文档' },
        { url: 'https://example.com/2' },
      ],
    });
    assert.ok(prompt.includes('参考链接：'));
    assert.ok(prompt.includes('- https://example.com/1 — 文档'));
    assert.ok(prompt.includes('- https://example.com/2'));
  });

  it('omits links section when links empty', () => {
    const prompt = composeDispatchPrompt({ text: 'hi', links: [] });
    assert.ok(!prompt.includes('参考链接'));
  });

  it('omits links section when links missing', () => {
    const prompt = composeDispatchPrompt({ text: 'hi' });
    assert.ok(!prompt.includes('参考链接'));
  });

  it('handles empty message text gracefully', () => {
    const prompt = composeDispatchPrompt({});
    assert.equal(prompt, '');
  });

  it('renders all provided links', () => {
    const prompt = composeDispatchPrompt({
      text: 'test',
      links: [{ url: 'https://valid.com', description: 'desc' }],
    });
    assert.ok(prompt.includes('https://valid.com — desc'));
  });

  it('does not prepend chat name header (injected via system block)', () => {
    const prompt = composeDispatchPrompt({ text: 'hello' });
    assert.ok(!prompt.includes('群聊'));
  });
});

// ── Tests: searchInText ──

describe('searchInText', () => {
  it('returns null when query not found', () => {
    const result = searchInText('hello world', 'missing');
    assert.equal(result, null);
  });

  it('finds match and returns snippet with context', () => {
    const text = '[user] please help me debug this issue with authentication';
    const result = searchInText(text, 'debug');
    assert.ok(result);
    assert.equal(result.matchIndex, text.toLowerCase().indexOf('debug'));
    assert.ok(result.snippet.includes('debug'));
  });

  it('detects user role when match is in user message', () => {
    const text = '[user] how to fix authentication\n[assistant] try this';
    const result = searchInText(text, 'authentication');
    assert.equal(result.matchRole, 'user');
  });

  it('detects assistant role when match is in assistant message', () => {
    const text = '[user] question\n[assistant] the authentication module needs fixing';
    const result = searchInText(text, 'authentication');
    assert.equal(result.matchRole, 'assistant');
  });

  it('returns empty matchRole when no role prefix before match', () => {
    const text = 'just some random text without role tags';
    const result = searchInText(text, 'random');
    assert.equal(result.matchRole, '');
  });

  it('is case-insensitive', () => {
    const text = '[user] Please HELP me';
    const result = searchInText(text, 'help');
    assert.ok(result);
    assert.ok(result.snippet.toLowerCase().includes('help'));
  });

  it('handles match at beginning of text', () => {
    const text = 'searchterm at the start';
    const result = searchInText(text, 'searchterm');
    assert.ok(result);
    assert.equal(result.matchIndex, 0);
  });

  it('handles match at end of text', () => {
    const text = 'some text ending with searchterm';
    const result = searchInText(text, 'searchterm');
    assert.ok(result);
    assert.ok(result.snippet.includes('searchterm'));
  });

  it('respects snippet radius', () => {
    const padding = 'x'.repeat(100);
    const text = `${padding}TARGET${padding}`;
    const result = searchInText(text, 'target');
    assert.ok(result);
    assert.ok(result.snippet.length < text.length);
    assert.ok(result.snippet.includes('TARGET'));
  });
});

// ── Tests: Group Chat data layer (using real createGroupChatDataLayer) ──

describe('Group Chat data layer', () => {
  let tmpDir;
  let store;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'gc-test-'));
    store = createGroupChatDataLayer(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('writeGroupChat / readGroupChat round-trip', () => {
    it('writes and reads back a chat', async () => {
      const chat = {
        id: 'chat-test-1',
        name: 'Test Chat',
        goal: 'fix bugs',
        createdAt: 1000,
        members: [{ identityRef: 'user', role: 'human' }],
        messages: [],
        sessions: {},
      };
      await store.writeGroupChat(chat);
      const read = await store.readGroupChat('chat-test-1');
      assert.equal(read.name, 'Test Chat');
      assert.equal(read.goal, 'fix bugs');
      // readGroupChat normalizes members (injects user + admin)
      const refs = read.members.map((m) => m.identityRef);
      assert.ok(refs.includes('user'));
      assert.ok(refs.includes('work-group:admin'));
    });

    it('returns null for non-existent chat', async () => {
      const read = await store.readGroupChat('nonexistent');
      assert.equal(read, null);
    });

    it('sets updatedAt on write', async () => {
      const before = Date.now();
      await store.writeGroupChat({ id: 'c1', name: 'C1', createdAt: 0, messages: [] });
      const read = await store.readGroupChat('c1');
      assert.ok(read.updatedAt >= before);
    });

    it('sanitizes chatId for filename', async () => {
      const chat = { id: 'chat-with/special chars!', name: 'X', createdAt: 0, messages: [] };
      await store.writeGroupChat(chat);
      const read = await store.readGroupChat('chat-with/special chars!');
      assert.ok(read, 'should read back despite special chars in id');
    });
  });

  describe('listGroupChats', () => {
    it('returns empty array when no chats exist', async () => {
      const chats = await store.listGroupChats();
      assert.deepEqual(chats, []);
    });

    it('returns summary without messages', async () => {
      await store.writeGroupChat({
        id: 'c1',
        name: 'Chat One',
        goal: 'goal1',
        createdAt: 1000,
        members: [{ identityRef: 'helper:main' }],
        messages: [
          { id: 'm1', text: 'hello', from: 'user', timestamp: 5000 },
          { id: 'm2', text: 'world', from: 'helper:main', timestamp: 6000 },
        ],
      });
      const chats = await store.listGroupChats();
      assert.equal(chats.length, 1);
      assert.equal(chats[0].id, 'c1');
      assert.equal(chats[0].name, 'Chat One');
      // memberCount includes auto-injected user + admin + helper:main = 3
      assert.equal(chats[0].memberCount, 3);
      assert.equal(chats[0].messageCount, 2);
      assert.equal(chats[0].lastMessage.text, 'world');
      assert.equal(chats[0].lastMessage.from, 'helper:main');
      assert.equal(chats[0].messages, undefined);
    });

    it('sorts by updatedAt descending', async () => {
      await store.writeGroupChat({ id: 'old', name: 'Old', createdAt: 100, messages: [] });
      await new Promise(r => setTimeout(r, 10));
      await store.writeGroupChat({ id: 'new', name: 'New', createdAt: 200, messages: [] });
      const chats = await store.listGroupChats();
      assert.equal(chats[0].id, 'new');
      assert.equal(chats[1].id, 'old');
    });

    it('handles lastMessage text truncation at 100 chars', async () => {
      const longText = 'A'.repeat(150);
      await store.writeGroupChat({
        id: 'c1', name: 'C', createdAt: 0,
        messages: [{ id: 'm1', text: longText, from: 'user', timestamp: 0 }],
      });
      const chats = await store.listGroupChats();
      assert.equal(chats[0].lastMessage.text.length, 100);
    });

    it('returns null lastMessage when no messages', async () => {
      await store.writeGroupChat({ id: 'c1', name: 'C', createdAt: 0, messages: [] });
      const chats = await store.listGroupChats();
      assert.equal(chats[0].lastMessage, null);
      assert.equal(chats[0].messageCount, 0);
    });

    it('skips non-JSON files', async () => {
      const { promises: fs } = await import('fs');
      await fs.writeFile(join(tmpDir, 'readme.txt'), 'not json');
      await store.writeGroupChat({ id: 'c1', name: 'C', createdAt: 0, messages: [] });
      const chats = await store.listGroupChats();
      assert.equal(chats.length, 1);
    });

    it('skips annotations.json files', async () => {
      const { promises: fs } = await import('fs');
      await store.writeGroupChat({ id: 'c1', name: 'C', createdAt: 0, messages: [] });
      await fs.writeFile(join(tmpDir, 'c1.annotations.json'), '{}');
      const chats = await store.listGroupChats();
      assert.equal(chats.length, 1);
    });
  });

  describe('appendGroupChatMessage', () => {
    it('appends message to existing chat', async () => {
      await store.writeGroupChat({ id: 'c1', name: 'C', createdAt: 0, messages: [] });
      const chat = await store.appendGroupChatMessage('c1', {
        id: 'm1', text: 'hello', from: 'user', timestamp: 1000,
      });
      assert.equal(chat.messages.length, 1);
      assert.equal(chat.messages[0].text, 'hello');
    });

    it('returns null for non-existent chat', async () => {
      const result = await store.appendGroupChatMessage('nope', { id: 'm1', text: 'x' });
      assert.equal(result, null);
    });

    it('preserves existing messages when appending', async () => {
      await store.writeGroupChat({
        id: 'c1', name: 'C', createdAt: 0,
        messages: [{ id: 'm0', text: 'first', from: 'user', timestamp: 0 }],
      });
      await store.appendGroupChatMessage('c1', { id: 'm1', text: 'second', from: 'user', timestamp: 1000 });
      const read = await store.readGroupChat('c1');
      assert.equal(read.messages.length, 2);
      assert.equal(read.messages[0].text, 'first');
      assert.equal(read.messages[1].text, 'second');
    });

    it('serializes concurrent appends for the same chat', async () => {
      await store.writeGroupChat({ id: 'c1', name: 'C', createdAt: 0, messages: [] });

      await Promise.all([
        store.appendGroupChatMessage('c1', { id: 'm1', text: 'first', from: 'user', timestamp: 1000 }),
        store.appendGroupChatMessage('c1', { id: 'm2', text: 'second', from: 'user', timestamp: 1001 }),
      ]);

      const read = await store.readGroupChat('c1');
      assert.deepEqual(read.messages.map((message) => message.id), ['m1', 'm2']);
    });

    it('rejects a stale direct write instead of overwriting newer data', async () => {
      await store.writeGroupChat({ id: 'c1', name: 'C', createdAt: 0, messages: [] });
      const stale = await store.readGroupChat('c1');
      await store.appendGroupChatMessage('c1', { id: 'm1', text: 'newer', from: 'user', timestamp: 1000 });

      stale.name = 'stale overwrite';
      await assert.rejects(store.writeGroupChat(stale), /Stale group chat write rejected/);

      const read = await store.readGroupChat('c1');
      assert.equal(read.name, 'C');
      assert.equal(read.messages[0].id, 'm1');
    });

    it('initializes messages array if missing', async () => {
      await store.writeGroupChat({ id: 'c1', name: 'C', createdAt: 0 });
      const chat = await store.appendGroupChatMessage('c1', { id: 'm1', text: 'x', from: 'user' });
      assert.ok(Array.isArray(chat.messages));
      assert.equal(chat.messages.length, 1);
    });
  });

  describe('updateMessageRouting', () => {
    it('updates routing for existing message', async () => {
      await store.writeGroupChat({
        id: 'c1', name: 'C', createdAt: 0,
        messages: [{ id: 'm1', text: 'task', from: 'user', routing: { status: 'pending' } }],
      });
      const msg = await store.updateMessageRouting('c1', 'm1', { status: 'delivered', dispatchedAt: 12345 });
      assert.equal(msg.routing.status, 'delivered');
      assert.equal(msg.routing.dispatchedAt, 12345);
    });

    it('merges routing update with existing routing (not replace)', async () => {
      await store.writeGroupChat({
        id: 'c1', name: 'C', createdAt: 0,
        messages: [{
          id: 'm1', text: 'task', from: 'user',
          routing: { status: 'pending', targetIdentityRef: 'helper:main' },
        }],
      });
      await store.updateMessageRouting('c1', 'm1', { status: 'delivered' });
      const read = await store.readGroupChat('c1');
      assert.equal(read.messages[0].routing.status, 'delivered');
      assert.equal(read.messages[0].routing.targetIdentityRef, 'helper:main');
    });

    it('returns null for non-existent message', async () => {
      await store.writeGroupChat({ id: 'c1', name: 'C', createdAt: 0, messages: [] });
      const result = await store.updateMessageRouting('c1', 'nonexistent', { status: 'x' });
      assert.equal(result, null);
    });

    it('returns null for non-existent chat', async () => {
      const result = await store.updateMessageRouting('nope', 'm1', { status: 'x' });
      assert.equal(result, null);
    });

    it('handles message with no existing routing', async () => {
      await store.writeGroupChat({
        id: 'c1', name: 'C', createdAt: 0,
        messages: [{ id: 'm1', text: 'task', from: 'user' }],
      });
      const msg = await store.updateMessageRouting('c1', 'm1', { status: 'pending' });
      assert.equal(msg.routing.status, 'pending');
    });
  });

  describe('deleteGroupChatFile', () => {
    it('deletes existing chat', async () => {
      await store.writeGroupChat({ id: 'c1', name: 'C', createdAt: 0, messages: [] });
      const deleted = await store.deleteGroupChatFile('c1');
      assert.equal(deleted, true);
      const read = await store.readGroupChat('c1');
      assert.equal(read, null);
    });

    it('returns false for non-existent chat', async () => {
      const deleted = await store.deleteGroupChatFile('nope');
      assert.equal(deleted, false);
    });
  });
});

// ── Tests: aggregateSessionPool ──

describe('aggregateSessionPool', () => {
  const mockIdentities = [
    { identityRef: 'programming-helper:main', displayName: '编程小助手' },
    { identityRef: 'flow-workspace:main', displayName: 'Flow工作空间' },
    { identityRef: 'work-group:admin', displayName: '管理员' },
  ];

  it('returns empty array for a brand-new chat with no sessions or messages', () => {
    const chat = {
      id: 'chat-new',
      name: '新群',
      members: [{ identityRef: 'user', role: 'human' }],
      messages: [],
      sessions: {},
    };
    const pool = aggregateSessionPool(chat, mockIdentities);
    assert.deepEqual(pool, []);
  });

  it('collects persistent sessions from chat.sessions mapping', () => {
    const chat = {
      id: 'chat-1',
      sessions: { 'programming-helper:main': 'sess-aaa' },
      messages: [],
    };
    const pool = aggregateSessionPool(chat, mockIdentities);
    assert.equal(pool.length, 1);
    assert.equal(pool[0].sessionId, 'sess-aaa');
    assert.equal(pool[0].identityRef, 'programming-helper:main');
    assert.equal(pool[0].displayName, '编程小助手');
    assert.equal(pool[0].workspaceId, 'programming-helper');
  });

  it('includes completed sessions from message routing', () => {
    const chat = {
      id: 'chat-1',
      sessions: {},
      messages: [
        {
          id: 'm1',
          routing: {
            status: 'completed',
            targetIdentityRef: 'programming-helper:main',
            targetSessionId: 'sess-bbb',
            targetWorkspaceId: 'programming-helper',
          },
          timestamp: 1000,
        },
      ],
    };
    const pool = aggregateSessionPool(chat, mockIdentities);
    assert.equal(pool.length, 1, 'completed session should remain in pool');
    assert.equal(pool[0].sessionId, 'sess-bbb');
  });

  it('includes failed routing entries (behavior: no longer excluded)', () => {
    // Real code comment: "不再排除 failed，因为 routing.status 经常误标 failed"
    const chat = {
      id: 'chat-1',
      sessions: {},
      messages: [
        {
          id: 'm1',
          routing: {
            status: 'failed',
            targetIdentityRef: 'programming-helper:main',
            targetSessionId: 'sess-fail',
            targetWorkspaceId: 'programming-helper',
          },
          timestamp: 1000,
        },
      ],
    };
    const pool = aggregateSessionPool(chat, mockIdentities);
    assert.equal(pool.length, 1, 'failed sessions are NOT excluded (real behavior)');
  });

  it('excludes work-group:admin sessions from all sources', () => {
    const chat = {
      id: 'chat-1',
      sessions: { 'work-group:admin': 'sess-admin' },
      messages: [
        {
          id: 'm1',
          routing: {
            status: 'delivered',
            targetIdentityRef: 'work-group:admin',
            targetSessionId: 'sess-admin',
            targetWorkspaceId: 'work-group',
          },
          timestamp: 1000,
        },
      ],
    };
    const pool = aggregateSessionPool(chat, mockIdentities);
    assert.equal(pool.length, 0);
  });

  it('deduplicates same session appearing in both chat.sessions and message routing', () => {
    const chat = {
      id: 'chat-1',
      sessions: { 'programming-helper:main': 'sess-aaa' },
      messages: [
        {
          id: 'm1',
          routing: {
            status: 'completed',
            targetIdentityRef: 'programming-helper:main',
            targetSessionId: 'sess-aaa',
            targetWorkspaceId: 'programming-helper',
          },
          timestamp: 5000,
        },
      ],
    };
    const pool = aggregateSessionPool(chat, mockIdentities);
    assert.equal(pool.length, 1, 'same session from two sources should be deduplicated');
    assert.equal(pool[0].lastActivity, 5000, 'lastActivity should come from the message routing (newer)');
  });

  it('collects imported external sessions', () => {
    const chat = {
      id: 'chat-1',
      sessions: {},
      messages: [],
      members: [
        { identityRef: 'user', role: 'human' },
        { identityRef: 'flow-workspace:main', role: 'agent' },
      ],
      importedSessions: [
        { workspaceId: 'flow-workspace', sessionId: 'ext-111', workspaceName: 'Flow工作空间', importedAt: 3000 },
      ],
    };
    const pool = aggregateSessionPool(chat, mockIdentities);
    assert.equal(pool.length, 1);
    assert.equal(pool[0].sessionId, 'ext-111');
    assert.equal(pool[0].identityRef, 'flow-workspace:main');
    assert.equal(pool[0].workspaceId, 'flow-workspace');
  });

  it('resolves displayName from identities for routing-derived sessions', () => {
    const chat = {
      id: 'chat-1',
      sessions: {},
      messages: [
        {
          id: 'm1',
          routing: {
            status: 'delivered',
            targetIdentityRef: 'flow-workspace:main',
            targetSessionId: 'sess-xyz',
            targetWorkspaceId: 'flow-workspace',
          },
          timestamp: 1000,
        },
      ],
    };
    const pool = aggregateSessionPool(chat, mockIdentities);
    assert.equal(pool[0].displayName, 'Flow工作空间');
  });

  it('handles multiple distinct sessions across all three sources', () => {
    const chat = {
      id: 'chat-1',
      sessions: { 'programming-helper:main': 'sess-persistent' },
      messages: [
        {
          id: 'm1',
          routing: {
            status: 'delivered',
            targetIdentityRef: 'programming-helper:main',
            targetSessionId: 'sess-dispatched',
            targetWorkspaceId: 'programming-helper',
          },
          timestamp: 2000,
        },
      ],
      members: [
        { identityRef: 'user', role: 'human' },
        { identityRef: 'flow-workspace:main', role: 'agent' },
      ],
      importedSessions: [
        { workspaceId: 'flow-workspace', sessionId: 'sess-imported', importedAt: 3000 },
      ],
    };
    const pool = aggregateSessionPool(chat, mockIdentities);
    assert.equal(pool.length, 3);
    const sessionIds = pool.map((s) => s.sessionId).sort();
    assert.deepEqual(sessionIds, ['sess-dispatched', 'sess-imported', 'sess-persistent']);
  });

  it('handles chat with null/undefined optional fields gracefully', () => {
    const chat = { id: 'chat-1' };
    const pool = aggregateSessionPool(chat, mockIdentities);
    assert.deepEqual(pool, []);
  });

  it('uses workspaceId:main as fallback identityRef for imported sessions without matching member', () => {
    const chat = {
      id: 'chat-1',
      sessions: {},
      messages: [],
      members: [{ identityRef: 'user', role: 'human' }],
      importedSessions: [
        { workspaceId: 'some-workspace', sessionId: 'ext-222', importedAt: 1000 },
      ],
    };
    const pool = aggregateSessionPool(chat, mockIdentities);
    assert.equal(pool.length, 1);
    assert.equal(pool[0].identityRef, 'some-workspace:main');
  });
});

describe('buildSessionContextUsage', () => {
  it('prefers last request input tokens and persisted model limits', () => {
    const usage = buildSessionContextUsage({
      runtime: { usageStats: {
        lastRequestUsage: { inputTokens: 146942 },
        totalUsage: { totalTokens: 900000 },
      } },
    }, { contextLength: 1000000, compressRatio: 18, modelName: 'GLM-5.2' });
    assert.deepEqual(usage, {
      usedTokens: 146942,
      contextLength: 1000000,
      compressRatio: 18,
      percent: 15,
      modelName: 'GLM-5.2',
      source: 'last_request',
    });
  });

  it('falls back to cumulative usage and safe defaults', () => {
    const usage = buildSessionContextUsage({
      runtime: { usageStats: { totalUsage: { totalTokens: 50000 } } },
    }, null);
    assert.equal(usage.usedTokens, 50000);
    assert.equal(usage.contextLength, 200000);
    assert.equal(usage.compressRatio, 80);
    assert.equal(usage.percent, 25);
    assert.equal(usage.source, 'cumulative');
  });
});

describe('buildSessionLatestMessage', () => {
  it('returns the latest non-empty user or assistant message', () => {
    const latest = buildSessionLatestMessage({
      runtime: {
        context: {
          messages: [
            { role: 'user', content: '请修复登录问题', turn: 1 },
            { role: 'assistant', content: '', turn: 1 },
            { role: 'tool', content: '{"ok":true}', turn: 1 },
            { role: 'assistant', content: '修复已经完成，并补充了测试。', turn: 1 },
          ],
        },
      },
    });
    assert.deepEqual(latest, {
      role: 'assistant',
      text: '修复已经完成，并补充了测试。',
      turn: 1,
      timestamp: null,
    });
  });

  it('extracts text blocks and ignores non-conversation roles', () => {
    const latest = buildSessionLatestMessage({
      runtime: {
        context: {
          messages: [
            { role: 'system', content: '系统背景' },
            { role: 'user', content: [{ type: 'text', text: ' 继续完成剩余任务 ' }, { type: 'image', source: {} }] },
          ],
        },
      },
    });
    assert.equal(latest?.role, 'user');
    assert.equal(latest?.text, '继续完成剩余任务');
  });

  it('uses the message timestamp or session update time for the displayed latest message', () => {
    const direct = buildSessionLatestMessage({
      runtime: { context: { messages: [{ role: 'assistant', content: '刚刚完成', timestamp: 1234 }] } },
    }, { updatedAt: 999 });
    const fallback = buildSessionLatestMessage({
      runtime: { context: { messages: [{ role: 'assistant', content: '历史消息' }] } },
    }, { updatedAt: 5678 });
    assert.equal(direct.timestamp, 1234);
    assert.equal(fallback.timestamp, 5678);
  });
});

// ── Tests: work thread lineage projection ──

describe('groupByLineage', () => {
  const identities = [{ identityRef: 'programming-helper:main', displayName: '编程小助手' }];
  const readIndex = async () => ({
    sessions: [
      { id: 'root', title: '重构认证模块', updatedAt: 100 },
      { id: 'child-a', title: '实现登录流程', updatedAt: 200 },
      { id: 'child-b', title: '验证兼容性', updatedAt: 300 },
    ],
  });

  it('keeps archived continuation nodes that are absent from the flat session pool', async () => {
    const threads = await groupByLineage(
      [{ identityRef: 'programming-helper:main', sessionId: 'root', lastActivity: 100 }],
      [{ from: 'root', to: 'child-a', reason: 'trim', timestamp: 150, identityRef: 'programming-helper:main' }],
      identities,
      readIndex,
      {
        activeSessions: {},
        messages: [{
          timestamp: 250,
          event: { type: 'session_archived', sessionId: 'child-a', sessionTitle: '实现登录流程' },
        }],
      }
    );

    assert.equal(threads.length, 1);
    assert.deepEqual(threads[0].lineage.map((node) => node.sessionId), ['root', 'child-a']);
    assert.equal(threads[0].lifecycle, 'archived');
    assert.equal(threads[0].isCurrent, false);
    assert.equal(threads[0].lineage[1].reason, 'trim');
  });

  it('projects one work thread per leaf when a historical node has multiple continuations', async () => {
    const threads = await groupByLineage(
      [{ identityRef: 'programming-helper:main', sessionId: 'root', lastActivity: 100 }],
      [
        { from: 'root', to: 'child-a', reason: 'trim', timestamp: 150, identityRef: 'programming-helper:main' },
        { from: 'root', to: 'child-b', reason: 'trim', timestamp: 250, identityRef: 'programming-helper:main' },
      ],
      identities,
      readIndex,
      { activeSessions: { 'programming-helper:main': 'child-b' }, messages: [] }
    );

    assert.equal(threads.length, 2);
    assert.deepEqual(new Set(threads.map((thread) => thread.lineageHeadId)), new Set(['child-a', 'child-b']));
    assert.equal(threads[0].lineageHeadId, 'child-b');
    assert.equal(threads[0].lifecycle, 'current');
    assert.equal(threads[1].lifecycle, 'available');
    const originalThread = threads.find((thread) => thread.lineageHeadId === 'child-a');
    const revivedThread = threads.find((thread) => thread.lineageHeadId === 'child-b');
    assert.equal(originalThread.threadRef, 'programming-helper:main::root');
    assert.equal(originalThread.threadTitle, '重构认证模块');
    assert.equal(revivedThread.threadRef, 'programming-helper:main::child-b');
    assert.equal(revivedThread.threadTitle, '验证兼容性');
  });

  it('keeps the source thread and creates a stable new thread for branch', async () => {
    const threads = await groupByLineage(
      [{ identityRef: 'programming-helper:main', sessionId: 'root', lastActivity: 100 }],
      [{ from: 'root', to: 'child-a', reason: 'branch', timestamp: 150, identityRef: 'programming-helper:main' }],
      identities,
      readIndex,
      { activeSessions: { 'programming-helper:main': 'child-a' }, messages: [] }
    );

    assert.equal(threads.length, 2);
    const source = threads.find((thread) => thread.lineageHeadId === 'root');
    const branch = threads.find((thread) => thread.lineageHeadId === 'child-a');
    assert.equal(source.threadRef, 'programming-helper:main::root');
    assert.equal(branch.threadRef, 'programming-helper:main::child-a');
    assert.equal(branch.threadTitle, '实现登录流程');
    assert.deepEqual(branch.lineage.map((node) => node.sessionId), ['root', 'child-a']);
  });

  it('archives only the branch path whose head is archived', async () => {
    const branchIndex = async () => ({
      sessions: [
        { id: 'root', title: '原始工作', archived: true },
        { id: 'child-a', title: '方案 A', archived: true },
        { id: 'child-b', title: '方案 B', archived: false },
      ],
    });
    const threads = await groupByLineage(
      [{ identityRef: 'programming-helper:main', sessionId: 'root', lastActivity: 100 }],
      [
        { from: 'root', to: 'child-a', reason: 'trim', timestamp: 150, identityRef: 'programming-helper:main' },
        { from: 'root', to: 'child-b', reason: 'branch', timestamp: 160, identityRef: 'programming-helper:main' },
      ],
      identities,
      branchIndex,
      { activeSessions: { 'programming-helper:main': 'child-b' }, messages: [] },
    );

    assert.equal(threads.find((thread) => thread.lineageHeadId === 'child-a')?.lifecycle, 'archived');
    assert.equal(threads.find((thread) => thread.lineageHeadId === 'child-b')?.lifecycle, 'current');
  });

  it('revives an archived thread when the head is unarchived in the session index', async () => {
    const liveIndex = async () => ({
      sessions: [
        { id: 'root', title: '重构认证模块', archived: true },
        { id: 'child-a', title: '实现登录流程', archived: false },
      ],
    });
    const threads = await groupByLineage(
      [{ identityRef: 'programming-helper:main', sessionId: 'root', lastActivity: 100 }],
      [{ from: 'root', to: 'child-a', reason: 'trim', timestamp: 150, identityRef: 'programming-helper:main' }],
      identities,
      liveIndex,
      {
        activeSessions: {},
        messages: [{ timestamp: 200, event: { type: 'session_archived', sessionId: 'child-a' } }],
      },
    );

    assert.equal(threads[0].lifecycle, 'available');
    assert.equal(threads[0].canDispatch, true);
  });

  it('enriches transitions with event metadata', async () => {
    const threads = await groupByLineage(
      [{ identityRef: 'programming-helper:main', sessionId: 'root', lastActivity: 100 }],
      [{ from: 'root', to: 'child-a', reason: 'trim', timestamp: 150, identityRef: 'programming-helper:main' }],
      identities,
      readIndex,
      {
        activeSessions: { 'programming-helper:main': 'child-a' },
        messages: [{
          timestamp: 160,
          event: {
            type: 'session_continued',
            fromSessionId: 'root',
            toSessionId: 'child-a',
            trimCutRounds: 4,
            archived: true,
          },
        }],
      }
    );

    assert.equal(threads[0].lineage[1].transition.trimCutRounds, 4);
    assert.equal(threads[0].lineage[1].transition.archived, true);
  });
});

describe('deriveThreadWorkStatus', () => {
  it('marks an ended thread completed even when it has no Task', () => {
    assert.equal(deriveThreadWorkStatus({ lifecycle: 'available' }, { total: 0, completed: 0 }, 'idle'), 'completed');
  });

  it('keeps running threads active even when every Task is complete', () => {
    assert.equal(deriveThreadWorkStatus({ lifecycle: 'current' }, { total: 2, completed: 2 }, 'running'), 'active');
  });

  it('keeps a newly dispatched thread active until routing completes', () => {
    assert.equal(deriveThreadWorkStatus(
      { lifecycle: 'current', latestRoutingStatus: 'delivered' },
      { total: 2, completed: 2 },
      'offline',
    ), 'active');
  });

  it('keeps Task progress independent from an ended thread', () => {
    assert.equal(deriveThreadWorkStatus({ lifecycle: 'current' }, { total: 4, completed: 1, cancelled: 1 }, 'idle'), 'completed');
  });

  it('keeps the public classification limited to active, completed and archived', () => {
    assert.equal(deriveThreadWorkStatus({ lifecycle: 'archived' }, { total: 1, completed: 0 }, 'offline'), 'archived');
    assert.equal(deriveThreadWorkStatus({ lifecycle: 'missing' }, { total: 1, completed: 0 }, 'offline'), 'completed');
  });
});

describe('buildThreadTaskSummary', () => {
  it('counts cancelled Tasks as resolved while preserving their result', () => {
    assert.deepEqual(buildThreadTaskSummary([
      { status: 'completed' },
      { status: 'completed' },
      { status: 'deleted' },
      { status: 'pending' },
    ]), {
      total: 4,
      completed: 2,
      cancelled: 1,
      resolved: 3,
      inProgress: 0,
      pending: 1,
    });
  });
});

// ── Tests: normalizeGroupChatMembers ──

describe('normalizeGroupChatMembers', () => {
  it('injects user and admin automatically', () => {
    const result = normalizeGroupChatMembers([]);
    const refs = result.map((m) => m.identityRef);
    assert.ok(refs.includes('user'));
    assert.ok(refs.includes('work-group:admin'));
  });

  it('deduplicates by identityRef', () => {
    const result = normalizeGroupChatMembers([
      { identityRef: 'user', role: 'human' },
      { identityRef: 'helper:main' },
      { identityRef: 'helper:main' },
    ]);
    const helperCount = result.filter((m) => m.identityRef === 'helper:main').length;
    assert.equal(helperCount, 1);
  });

  it('defaults role to agent for non-user/admin members', () => {
    const result = normalizeGroupChatMembers([{ identityRef: 'helper:main' }]);
    const helper = result.find((m) => m.identityRef === 'helper:main');
    assert.equal(helper.role, 'agent');
  });
});
