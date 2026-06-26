/**
 * Tests for server.js Group Chat data layer + dispatch prompt composition.
 *
 * Covers:
 * 1. composeDispatchPrompt — prompt building with chat name, text, links
 * 2. searchInText — snippet extraction, role detection, edge cases
 * 3. Group Chat CRUD — write/read/list/append/updateMessageRouting round-trip
 * 4. aggregateSessionPool — session pool aggregation from 3 sources (runtime_status)
 *
 * The CRUD tests use a temp directory to exercise real file I/O.
 * The pure functions are inline-replicated from server.js.
 * When server.js changes, update the inline copies accordingly.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';

// ── Inline helpers (mirrors server.js) ──

const SEARCH_SNIPPET_RADIUS = 40;

function searchInText(text, queryLower) {
  const idx = text.toLowerCase().indexOf(queryLower);
  if (idx === -1) return null;
  const start = Math.max(0, idx - SEARCH_SNIPPET_RADIUS);
  const end = Math.min(text.length, idx + queryLower.length + SEARCH_SNIPPET_RADIUS);
  let snippet = text.slice(start, end);
  snippet = snippet.replace(/^\[[^\]]*\]\s*/, '');
  const beforeSnippet = text.slice(0, idx);
  const lastRoleMatch = beforeSnippet.match(/\[(user|assistant)\][^\[]*$/);
  const matchRole = lastRoleMatch ? lastRoleMatch[1] : '';
  return { snippet, matchRole, matchIndex: idx };
}

function composeDispatchPrompt(chatName, message) {
  const parts = [];
  if (chatName) {
    parts.push(`[群聊：${chatName}]`);
  }
  parts.push(message.text || '');
  if (Array.isArray(message.links) && message.links.length > 0) {
    parts.push('\n参考链接：');
    for (const link of message.links) {
      const desc = link.description ? ` — ${link.description}` : '';
      parts.push(`- ${link.url}${desc}`);
    }
  }
  return parts.join('\n\n');
}

function sanitizeSessionFragment(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'default';
}

/**
 * Group Chat data layer with injectable root dir.
 * Mirrors the server.js functions but accepts a rootDir parameter for testing.
 */
function createGroupChatStore(rootDir) {
  async function ensureDir() {
    await fs.mkdir(rootDir, { recursive: true });
  }

  function getGroupChatPath(chatId) {
    return join(rootDir, `${sanitizeSessionFragment(chatId)}.json`);
  }

  async function readGroupChat(chatId) {
    try {
      const raw = await fs.readFile(getGroupChatPath(chatId), 'utf8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async function writeGroupChat(chat) {
    await ensureDir();
    chat.updatedAt = Date.now();
    await fs.writeFile(getGroupChatPath(chat.id), JSON.stringify(chat, null, 2), 'utf8');
    return chat;
  }

  async function listGroupChats() {
    await ensureDir();
    const entries = await fs.readdir(rootDir);
    const chats = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(join(rootDir, entry), 'utf8');
        const chat = JSON.parse(raw);
        chats.push({
          id: chat.id,
          name: chat.name,
          goal: chat.goal || null,
          createdAt: chat.createdAt,
          updatedAt: chat.updatedAt,
          memberCount: Array.isArray(chat.members) ? chat.members.length : 0,
          messageCount: Array.isArray(chat.messages) ? chat.messages.length : 0,
          lastMessage: Array.isArray(chat.messages) && chat.messages.length > 0
            ? {
                text: (chat.messages[chat.messages.length - 1].text || '').slice(0, 100),
                from: chat.messages[chat.messages.length - 1].from,
                timestamp: chat.messages[chat.messages.length - 1].timestamp,
              }
            : null,
        });
      } catch {}
    }
    chats.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return chats;
  }

  async function appendGroupChatMessage(chatId, message) {
    const chat = await readGroupChat(chatId);
    if (!chat) return null;
    if (!Array.isArray(chat.messages)) chat.messages = [];
    chat.messages.push(message);
    await writeGroupChat(chat);
    return chat;
  }

  async function updateMessageRouting(chatId, messageId, routingUpdate) {
    const chat = await readGroupChat(chatId);
    if (!chat || !Array.isArray(chat.messages)) return null;
    const msg = chat.messages.find((m) => m.id === messageId);
    if (!msg) return null;
    msg.routing = { ...(msg.routing || {}), ...routingUpdate };
    await writeGroupChat(chat);
    return msg;
  }

  async function deleteGroupChatFile(chatId) {
    try {
      await fs.unlink(getGroupChatPath(chatId));
      return true;
    } catch {
      return false;
    }
  }

  return { readGroupChat, writeGroupChat, listGroupChats, appendGroupChatMessage, updateMessageRouting, deleteGroupChatFile, getGroupChatPath };
}

// ── Tests ──

describe('composeDispatchPrompt', () => {
  it('includes chat name header when provided', () => {
    const prompt = composeDispatchPrompt('项目讨论', { text: '请检查这段代码' });
    assert.ok(prompt.startsWith('[群聊：项目讨论]'));
    assert.ok(prompt.includes('请检查这段代码'));
  });

  it('omits chat name header when empty', () => {
    const prompt = composeDispatchPrompt('', { text: 'hello' });
    assert.equal(prompt, 'hello');
  });

  it('omits chat name header when null', () => {
    const prompt = composeDispatchPrompt(null, { text: 'hello' });
    assert.equal(prompt, 'hello');
  });

  it('appends links section when links present', () => {
    const prompt = composeDispatchPrompt('群A', {
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
    const prompt = composeDispatchPrompt(null, { text: 'hi', links: [] });
    assert.ok(!prompt.includes('参考链接'));
  });

  it('omits links section when links missing', () => {
    const prompt = composeDispatchPrompt(null, { text: 'hi' });
    assert.ok(!prompt.includes('参考链接'));
  });

  it('handles empty message text gracefully', () => {
    const prompt = composeDispatchPrompt('群', {});
    assert.equal(prompt, '[群聊：群]\n\n');
  });

  it('renders all provided links (filtering is API layer responsibility)', () => {
    // composeDispatchPrompt itself does NOT filter links without url;
    // the POST handler filters with links.filter(l => l && l.url).
    const prompt = composeDispatchPrompt(null, {
      text: 'test',
      links: [{ url: 'https://valid.com', description: 'desc' }],
    });
    assert.ok(prompt.includes('https://valid.com — desc'));
  });
});

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

  it('strips role prefix from start of snippet', () => {
    // Construct text where match is right after a role tag so the snippet
    // starts with [user]
    const text = '[user] target_keyword_here_and_more_padding';
    const result = searchInText(text, 'target_keyword');
    assert.ok(result);
    assert.ok(!result.snippet.startsWith('[user]'), 'snippet should not start with role tag');
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
    // Snippet should be much shorter than full text
    assert.ok(result.snippet.length < text.length);
    // Should contain TARGET with ~40 chars of context on each side
    assert.ok(result.snippet.includes('TARGET'));
  });
});

describe('Group Chat data layer', () => {
  let tmpDir;
  let store;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'gc-test-'));
    store = createGroupChatStore(tmpDir);
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
      assert.deepEqual(read.members, [{ identityRef: 'user', role: 'human' }]);
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
      // Should be readable via the sanitized id
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
        members: [{ identityRef: 'user' }, { identityRef: 'helper' }],
        messages: [
          { id: 'm1', text: 'hello', from: 'user', timestamp: 5000 },
          { id: 'm2', text: 'world', from: 'helper', timestamp: 6000 },
        ],
      });
      const chats = await store.listGroupChats();
      assert.equal(chats.length, 1);
      assert.equal(chats[0].id, 'c1');
      assert.equal(chats[0].name, 'Chat One');
      assert.equal(chats[0].memberCount, 2);
      assert.equal(chats[0].messageCount, 2);
      assert.equal(chats[0].lastMessage.text, 'world');
      assert.equal(chats[0].lastMessage.from, 'helper');
      // Summary should NOT contain messages array
      assert.equal(chats[0].messages, undefined);
    });

    it('sorts by updatedAt descending', async () => {
      await store.writeGroupChat({ id: 'old', name: 'Old', createdAt: 100, messages: [] });
      // Small delay to ensure different updatedAt
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
      await fs.writeFile(join(tmpDir, 'readme.txt'), 'not json');
      await store.writeGroupChat({ id: 'c1', name: 'C', createdAt: 0, messages: [] });
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
      // Only update status, should NOT lose targetIdentityRef
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

// ── aggregateSessionPool (mirrors GET /protoclaw/gc/runtime_status) ──

/**
 * Aggregate all sessions in a group chat's session pool from three sources:
 * 1. chat.sessions mapping (persistent sessions)
 * 2. chat.messages routing (dispatched sessions, including completed)
 * 3. chat.importedSessions (imported external sessions)
 *
 * Excludes: work-group:admin identity, failed routing status.
 * Deduplicates by key = identityRef:sessionId.
 *
 * This mirrors the aggregation logic in GET /protoclaw/gc/runtime_status
 * in server.js. When the server code changes, update this copy accordingly.
 */
function aggregateSessionPool(chat, identities) {
  const identityDisplayName = (ref) => {
    const info = identities.find((i) => i.identityRef === ref);
    return info?.displayName || ref.split(':')[1] || ref;
  };

  const sessionMap = new Map();

  // Source 1: chat.sessions mapping (persistent sessions)
  for (const [identityRef, sessionId] of Object.entries(chat.sessions || {})) {
    if (identityRef === 'work-group:admin') continue;
    if (!sessionId) continue;
    const workspaceId = identityRef.split(':')[0];
    const key = `${identityRef}:${sessionId}`;
    sessionMap.set(key, {
      identityRef, sessionId, workspaceId,
      displayName: identityDisplayName(identityRef),
      lastActivity: 0,
    });
  }

  // Source 2: message routing (including completed, excluding failed)
  for (const msg of (chat.messages || [])) {
    const r = msg.routing;
    if (!r || !r.targetSessionId) continue;
    if (r.status === 'failed') continue;
    if (r.targetIdentityRef === 'work-group:admin') continue;
    const key = `${r.targetIdentityRef}:${r.targetSessionId}`;
    const existing = sessionMap.get(key);
    if (!existing || (msg.timestamp || 0) > (existing.lastActivity || 0)) {
      sessionMap.set(key, {
        identityRef: r.targetIdentityRef,
        sessionId: r.targetSessionId,
        workspaceId: r.targetWorkspaceId || r.targetIdentityRef.split(':')[0],
        displayName: identityDisplayName(r.targetIdentityRef),
        lastActivity: msg.timestamp || 0,
      });
    }
  }

  // Source 3: imported external sessions
  for (const imp of (chat.importedSessions || [])) {
    if (!imp.sessionId || !imp.workspaceId) continue;
    const memberIdentity = (chat.members || [])
      .find((m) => m.identityRef && m.identityRef.startsWith(imp.workspaceId + ':'));
    const identityRef = memberIdentity?.identityRef || `${imp.workspaceId}:main`;
    const key = `${identityRef}:${imp.sessionId}`;
    if (!sessionMap.has(key)) {
      sessionMap.set(key, {
        identityRef,
        sessionId: imp.sessionId,
        workspaceId: imp.workspaceId,
        displayName: imp.workspaceName || identityDisplayName(identityRef),
        lastActivity: imp.importedAt || 0,
      });
    }
  }

  return Array.from(sessionMap.values());
}

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

  it('includes completed sessions from message routing (regression: old code filtered them)', () => {
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

  it('excludes failed routing entries', () => {
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
    assert.equal(pool.length, 0);
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
