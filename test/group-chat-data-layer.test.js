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
