import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  buildThreadSessionLookup,
  ensureThreadConversationIndex,
  searchThreadConversations,
  setupThreadConversationSearchRoute,
} from '../server/routes/thread-conversation-search.js';

const FIXTURE_MESSAGES = [
  { role: 'user', text: 'find repeated input', turn: 1, messageIndex: 4 },
  { role: 'tool-call', kind: 'tool-call', text: 'grep {"pattern":"repeated input"}', turn: 2, messageIndex: 8 },
];

test('domain conversation matches user/assistant text only, tooling matches tool rows only', () => {
  const records = [
    { agentId: 'ph', sessionId: 's1', threadId: 'wt-1', title: 'one', updatedAt: '2026-11-01', messages: [
      ...FIXTURE_MESSAGES,
      { role: 'tool', text: 'repeated input was detected', turn: 3, messageIndex: 2 },
      { role: 'assistant', text: 'repeated only', turn: 4, messageIndex: 7 },
    ] },
  ];
  const conversation = searchThreadConversations(records, 'repeated input', { domain: 'conversation' });
  assert.equal(conversation.total, 1);
  assert.deepEqual(conversation.results[0].matches.map((match) => match.role), ['user']);
  const tooling = searchThreadConversations(records, 'repeated input', { domain: 'tooling' });
  assert.equal(tooling.total, 1);
  assert.deepEqual(tooling.results[0].matches.map((match) => match.role), ['tool-call', 'tool']);
  assert.deepEqual(tooling.results[0].matches[0].source, { agentId: 'ph', sessionId: 's1', turn: 2, messageIndex: 8 });
});

test('replayed rows are skipped so a trim successor does not duplicate hits already findable in its predecessor', () => {
  const records = [
    { agentId: 'ph', sessionId: 's1', threadId: 'wt-1', updatedAt: '2026-11-01', messages: [
      { role: 'user', text: 'dedupe me', turn: 1, messageIndex: 0 },
    ] },
    { agentId: 'ph', sessionId: 's2', threadId: 'wt-1', updatedAt: '2026-11-02', messages: [
      { role: 'user', text: 'dedupe me', turn: 1, messageIndex: 2, replayed: true },
      { role: 'user', text: 'new words dedupe me', turn: 3, messageIndex: 5 },
    ] },
  ];
  const result = searchThreadConversations(records, 'dedupe me', { domain: 'conversation' });
  assert.equal(result.total, 1);
  const matches = result.results[0].matches;
  assert.equal(matches.length, 2);
  assert.ok(matches.every((match) => match.source.sessionId === 's1' || match.source.messageIndex === 5));
});

test('search filters by inclusive date bounds before grouping and enforces 50-result cap', () => {
  const records = Array.from({ length: 60 }, (_, index) => ({
    agentId: 'a', sessionId: `s-${index}`, threadId: `wt-${index}`,
    updatedAt: `2026-11-${String(index < 30 ? '08' : '09')}T12:00:00Z`,
    messages: [{ role: 'user', text: 'needle', messageIndex: 0 }],
  }));
  const ranged = searchThreadConversations(records, 'needle', { domain: 'conversation', from: '2026-11-09', to: '2026-11-09' });
  assert.equal(ranged.total, 30);
  assert.ok(ranged.results.every((entry) => entry.updatedAt.startsWith('2026-11-09')));
  const capped = searchThreadConversations(records, 'needle', { domain: 'conversation', limit: 100 });
  assert.equal(capped.total, 60);
  assert.equal(capped.results.length, 50);
});

test('search applies archived-scope filters', () => {
  const records = [
    { agentId: 'a', sessionId: 's1', threadId: 'wt-live', archived: false, messages: [{ role: 'user', text: 'needle', messageIndex: 0 }] },
    { agentId: 'a', sessionId: 's2', threadId: 'wt-archived', archived: true, messages: [{ role: 'assistant', text: 'needle', messageIndex: 0 }] },
  ];
  assert.equal(searchThreadConversations(records, 'needle', { domain: 'conversation', scope: 'main' }).results[0].threadId, 'wt-live');
  assert.equal(searchThreadConversations(records, 'needle', { domain: 'conversation', scope: 'archived' }).results[0].threadId, 'wt-archived');
  assert.equal(searchThreadConversations(records, 'needle light').total, 0);
});

test('incremental index reuses unchanged sessions and rebuilds on size or mtime change', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'thread-search-index-'));
  try {
    const sessionPath = path.join(root, 'session.json');
    await fs.writeFile(sessionPath, JSON.stringify({ runtime: { context: { messages: [
      { role: 'user', turn: 1, content: 'alpha', tag: { kind: 'summary' } },
      { role: 'assistant', turn: 1, content: '', toolCalls: [{ name: 'grep', args: { pattern: 'needle' } }] },
      { role: 'tool', turn: 1, toolCallId: 'c1', content: 'tool needle result' },
    ], enrichedMessages: [{ timestamp: 10 }, { timestamp: 11 }, { timestamp: 12 }] } } }));
    const session = { id: 's1', fileMtimeMs: 10, fileSize: 100, title: 'topic', updatedAt: 'now' };
    let readCount = 0;
    const options = {
      agentId: 'a', getAgentSessionDir: () => root,
      getSessionFilePath: () => { readCount++; return sessionPath; },
      sessions: [session], threadBySession: new Map([['s1', { threadId: 'wt-1', title: 'thread' }]]),
    };
    const first = await ensureThreadConversationIndex(options);
    assert.equal(readCount, 1);
    assert.equal(first.records[0].messages.length, 3);
    assert.equal(first.records[0].messages[0].kind, 'summary');
    assert.equal(first.records[0].messages[1].role, 'tool-call');
    assert.equal(first.coverage.degraded, false);
    const second = await ensureThreadConversationIndex(options);
    assert.equal(readCount, 1);
    assert.equal(second.records[0].threadId, 'wt-1');
    await ensureThreadConversationIndex({ ...options, sessions: [{ ...session, fileSize: 101 }] });
    assert.equal(readCount, 2);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('index clips oversized message text by role and flags truncation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'thread-search-clip-'));
  try {
    const sessionPath = path.join(root, 'session.json');
    await fs.writeFile(sessionPath, JSON.stringify({ runtime: { context: { messages: [
      { role: 'user', turn: 1, content: 'u'.repeat(20000) },
      { role: 'tool', turn: 1, toolCallId: 'c1', content: 't'.repeat(5000) },
      { role: 'assistant', turn: 2, content: '', toolCalls: [{ name: 'grep', args: { pattern: 'x'.repeat(5000) } }] },
    ], enrichedMessages: [{ timestamp: 10 }, { timestamp: 11 }, { timestamp: 12 }] } } }));
    const { records, coverage } = await ensureThreadConversationIndex({
      agentId: 'a', getAgentSessionDir: () => root, getSessionFilePath: () => sessionPath,
      sessions: [{ id: 's1', fileMtimeMs: 1, fileSize: 10, title: 't', updatedAt: 'now' }], threadBySession: new Map(),
    });
    const rows = records[0].messages;
    const userRow = rows.find((row) => row.role === 'user');
    assert.ok(userRow.text.endsWith('…[truncated 20000]'));
    assert.equal(userRow.text.length, 8000 + '…[truncated 20000]'.length);
    const toolRow = rows.find((row) => row.role === 'tool');
    assert.ok(toolRow.text.endsWith('…[truncated 5000]'));
    assert.equal(toolRow.text.length, 1200 + '…[truncated 5000]'.length);
    const callRow = rows.find((row) => row.role === 'tool-call');
    assert.ok(callRow.text.startsWith('grep {"pattern":"xxxx'));
    assert.ok(callRow.text.includes('…[truncated '));
    assert.equal(coverage.degraded, false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('index marks the replayed seed segment from the handoff account', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'thread-search-replay-'));
  try {
    const sessionPath = path.join(root, 'session.json');
    await fs.writeFile(sessionPath, JSON.stringify({ runtime: { context: { messages: [
      { role: 'system', turn: 0, content: 'idp' },
      { role: 'user', turn: 1, content: 'replayed user line' },
      { role: 'assistant', turn: 1, content: 'replayed answer', toolCalls: [{ name: 'grep', args: { pattern: 'replayed' } }] },
      { role: 'system', turn: 1, content: 'trim notice' },
      { role: 'user', turn: 3, content: 'fresh user line' },
    ], enrichedMessages: [] } } }));
    const readHandoffCalls = [];
    const { records } = await ensureThreadConversationIndex({
      agentId: 'a', getAgentSessionDir: () => root, getSessionFilePath: () => sessionPath,
      sessions: [{ id: 's1', fileMtimeMs: 1, fileSize: 10, title: 't', updatedAt: 'now', metadata: { handoffId: 'h1' } }],
      threadBySession: new Map(),
      readHandoff: async (agentId, handoffId) => {
        readHandoffCalls.push({ agentId, handoffId });
        return {
          seedKind: 'trim+seed',
          seedMessages: [
            { role: 'user', turn: 1, content: 'replayed user line' },
            { role: 'assistant', turn: 1, content: 'replayed answer', toolCalls: [{ name: 'grep', args: { pattern: 'replayed' } }] },
            { role: 'system', turn: 1, content: 'trim notice' },
          ],
          seedBoundary: { seedMessageCount: 3, appendedInjection: [{ kind: 'trim-notice', messageIndex: 2 }] },
        };
      },
    });
    assert.deepEqual(readHandoffCalls, [{ agentId: 'a', handoffId: 'h1' }]);
    const rows = records[0].messages;
    const replayedTexts = rows.filter((row) => row.replayed === true).map((row) => row.role);
    // 重放段（种子区 [1,4)）的行全部标记：user 正文、assistant 正文、其 tool-call 行、trim 注记。
    assert.deepEqual(replayedTexts.sort(), ['assistant', 'system', 'tool-call', 'user']);
    const freshRow = rows.find((row) => row.text === 'fresh user line');
    assert.ok(freshRow);
    assert.notEqual(freshRow.replayed, true);
    // 前置 runtime 注入（idp，在锚定窗口内但不在种子区）不标记。
    const idpRow = rows.find((row) => row.text === 'idp');
    assert.ok(idpRow);
    assert.notEqual(idpRow.replayed, true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('index guardrail drops tool result rows, then tool-call rows, then skips the oldest sessions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'thread-search-guard-'));
  try {
    const writeSession = async (name, messages) => {
      const file = path.join(root, name);
      await fs.writeFile(file, JSON.stringify({ runtime: { context: { messages, enrichedMessages: [] } } }));
      return file;
    };
    const files = {
      s1: await writeSession('s1.json', [{ role: 'user', turn: 1, content: 'u'.repeat(50) }]),
      s2: await writeSession('s2.json', [
        { role: 'user', turn: 1, content: 'v'.repeat(50) },
        { role: 'assistant', turn: 2, content: '', toolCalls: [{ name: 'grep', args: { pattern: 'p'.repeat(10) } }] },
        { role: 'tool', turn: 2, toolCallId: 'c1', content: 't'.repeat(50) },
      ]),
      s3: await writeSession('s3.json', [
        { role: 'user', turn: 1, content: 'w'.repeat(50) },
        { role: 'assistant', turn: 2, content: '', toolCalls: [{ name: 'grep', args: { pattern: 'q'.repeat(10) } }] },
      ]),
      s4: await writeSession('s4.json', [
        { role: 'user', turn: 1, content: 'z'.repeat(50) },
        { role: 'assistant', turn: 2, content: '', toolCalls: [{ name: 'grep', args: { pattern: 'r'.repeat(10) } }] },
      ]),
    };
    const { records, coverage } = await ensureThreadConversationIndex({
      agentId: 'a', getAgentSessionDir: () => root,
      getSessionFilePath: (agentId, sessionId) => files[sessionId],
      sessions: ['s1', 's2', 's3', 's4'].map((id, index) => ({ id, fileMtimeMs: index + 1, fileSize: 10, title: id, updatedAt: String(index + 1) })),
      threadBySession: new Map(),
    }, { toolDrop: 40, callDrop: 100, hardCap: 200 });
    // s1 预算内全保留；s2 超 toolDrop 丢 tool 结果行但保留 tool-call；s3 超 callDrop 连 tool-call 也丢；
    // s4 超 hardCap 整体跳过。
    assert.deepEqual(records.map((record) => record.sessionId), ['s1', 's2', 's3']);
    const s2Roles = records[1].messages.map((row) => row.role);
    assert.ok(s2Roles.includes('tool-call'));
    assert.ok(!s2Roles.includes('tool'));
    const s3Roles = records[2].messages.map((row) => row.role);
    assert.deepEqual(s3Roles, ['user']);
    assert.equal(coverage.degraded, true);
    assert.equal(coverage.droppedToolRows, 1);
    assert.equal(coverage.droppedCallRows, 2);
    assert.equal(coverage.skippedSessions, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('thread lookup is built from thread index session membership', () => {
  const lookup = buildThreadSessionLookup([{ threadId: 'wt-1', title: 'x', sessionIds: ['s1', 's2'] }]);
  assert.deepEqual(lookup.get('s2'), { threadId: 'wt-1', title: 'x' });
});

test('an open reader on the index file degrades persist instead of failing the whole build', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'thread-search-persist-'));
  try {
    const sessionPath = path.join(root, 'session.json');
    await fs.writeFile(sessionPath, JSON.stringify({ runtime: { context: { messages: [
      { role: 'user', turn: 1, content: 'persist needle' },
    ], enrichedMessages: [{ timestamp: 10 }] } } }));
    const session = { id: 's1', fileMtimeMs: 10, fileSize: 100, title: 'topic', updatedAt: 'now' };
    const options = {
      agentId: 'a', getAgentSessionDir: () => root, getSessionFilePath: () => sessionPath,
      sessions: [session], threadBySession: new Map(),
    };
    const indexPath = path.join(root, 'thread-conversation-search.json');
    await ensureThreadConversationIndex(options);
    // 生产缺陷场景：另一并发读路径正持有索引只读句柄（Windows 上 rename 到
    // 被只读句柄打开的目标必 EPERM），此时 rebuild 不得把整次搜索打挂。
    const reader = await fs.open(indexPath, 'r');
    let rebuilt;
    try {
      rebuilt = await ensureThreadConversationIndex({ ...options, sessions: [{ ...session, fileMtimeMs: 11 }] });
    } finally { await reader.close(); }
    assert.equal(rebuilt.records.length, 1);
    assert.equal(rebuilt.persistFailed, true);
    // 句柄释放后，下一次构建恢复持久化，磁盘索引回到最新。
    const persisted = await ensureThreadConversationIndex({ ...options, sessions: [{ ...session, fileMtimeMs: 12 }] });
    const stored = JSON.parse(await fs.readFile(indexPath, 'utf8'));
    assert.equal(stored.entries.s1.fileMtimeMs, 12);
    assert.notEqual(persisted.persistFailed, true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('concurrent index builds for the same agent coalesce into a single build', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'thread-search-coalesce-'));
  try {
    const sessionPath = path.join(root, 'session.json');
    await fs.writeFile(sessionPath, JSON.stringify({ runtime: { context: { messages: [
      { role: 'user', turn: 1, content: 'coalesce needle' },
    ], enrichedMessages: [] } } }));
    let readHandoffCalls = 0;
    let releaseGate;
    const gate = new Promise((resolve) => { releaseGate = resolve; });
    // 单一构建时兜底放行：并发被合并则第二个调用永远不会进 readHandoff。
    const gateTimeout = setTimeout(() => releaseGate(), 150);
    const buildOptions = () => ({
      agentId: 'a', getAgentSessionDir: () => root, getSessionFilePath: () => sessionPath,
      sessions: [{ id: 's1', fileMtimeMs: 1, fileSize: 10, title: 't', updatedAt: 'now', metadata: { handoffId: 'h1' } }],
      threadBySession: new Map(),
      readHandoff: async () => {
        readHandoffCalls += 1;
        if (readHandoffCalls >= 2) releaseGate();
        await gate;
        return null;
      },
    });
    const [first, second] = await Promise.all([
      ensureThreadConversationIndex(buildOptions()),
      ensureThreadConversationIndex(buildOptions()),
    ]);
    clearTimeout(gateTimeout);
    assert.equal(readHandoffCalls, 1);
    assert.deepEqual(first.records, second.records);
    assert.notEqual(first.persistFailed, true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('search route requires domain, honors agentId filter, and returns grouped matches', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'thread-search-route-'));
  try {
    const sessionsRoot = path.join(root, 'sessions');
    const threadsRoot = path.join(root, 'threads');
    await fs.mkdir(path.join(sessionsRoot, 'a'), { recursive: true });
    await fs.mkdir(path.join(sessionsRoot, 'b'), { recursive: true });
    await fs.mkdir(path.join(threadsRoot, 'threads'), { recursive: true });
    await fs.writeFile(path.join(sessionsRoot, 'a', 's1.json'), JSON.stringify({ runtime: { context: { messages: [
      { role: 'user', turn: 1, content: 'handoff issue needle' },
      { role: 'assistant', turn: 1, content: 'I see the handoff issue' },
    ], enrichedMessages: [{ timestamp: 10 }, { timestamp: 11 }] } } }));
    await fs.writeFile(path.join(sessionsRoot, 'b', 's2.json'), JSON.stringify({ runtime: { context: { messages: [
      { role: 'user', turn: 1, content: 'handoff issue from other agent' },
    ], enrichedMessages: [{ timestamp: 10 }] } } }));
    await fs.writeFile(path.join(threadsRoot, 'threads', 'index.json'), JSON.stringify({ threads: [] }));
    const routes = new Map();
    setupThreadConversationSearchRoute({ get: (route, handler) => routes.set(route, handler) }, {
      discoverAgents: async () => [{ id: 'a' }, { id: 'b' }],
      readSessionIndex: async (agentId) => ({ sessions: agentId === 'a'
        ? [{ id: 's1', fileMtimeMs: 1, fileSize: 100, title: 'session', updatedAt: '2026-11-09' }]
        : [{ id: 's2', fileMtimeMs: 1, fileSize: 100, title: 'other', updatedAt: '2026-11-08' }] }),
      getAgentSessionDir: (agentId) => path.join(root, 'sessions', agentId),
      threadsRoot,
      getSessionFilePath: (agentId, sessionId) => path.join(root, 'sessions', agentId, `${sessionId}.json`),
      readHandoff: async () => null,
    });
    const call = async (query) => {
      let body;
      let statusCode = 200;
      const res = { status(code) { statusCode = code; return this; }, json(value) { body = value; return this; } };
      let nextError;
      await routes.get('/protoclaw/search_conversations')({ query }, res, (error) => { nextError = error; });
      return { body, statusCode, nextError };
    };
    // domain 缺省 → 400（分流必须显式指定）。
    const missing = await call({ q: 'handoff issue' });
    assert.equal(missing.statusCode, 400);
    // agentId 过滤（与寻址参数同名，值可逗号分隔多值）：只搜工作空间 a，b 的会话不参与。
    const filtered = await call({ q: 'handoff issue', domain: 'conversation', agentId: 'a' });
    assert.equal(filtered.nextError, undefined);
    assert.equal(filtered.statusCode, 200);
    assert.equal(filtered.body.total, 1);
    assert.equal(filtered.body.results[0].matches[0].source.agentId, 'a');
    assert.deepEqual(filtered.body.results[0].matches[0].source, { agentId: 'a', sessionId: 's1', turn: 1, messageIndex: 0 });
    // 无 agentId → 全空间。
    const all = await call({ q: 'handoff issue', domain: 'conversation' });
    assert.equal(all.body.total, 2);
    // 多值（宽容通道）：a,b 并集 = 全空间（两空间各有命中）。
    // split 语义退化为整串精确匹配时此断言会失败（'a,b' 匹配不到任何空间 → 0）。
    const multi = await call({ q: 'handoff issue', domain: 'conversation', agentId: 'a,b' });
    assert.equal(multi.body.total, all.body.total);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
