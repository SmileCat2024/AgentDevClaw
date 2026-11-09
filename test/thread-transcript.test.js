import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { projectThreadTranscript, segmentGeneration, setupThreadTranscriptRoute } from '../server/routes/thread-transcript.js';

function accountedHandoff() {
  return {
    seedKind: 'trim+seed',
    seedMessages: [
      { role: 'user', turn: 1, content: 'start' },
      { role: 'assistant', turn: 1, content: 'answer' },
      { role: 'system', turn: 1, content: 'trim notice text' },
    ],
    seedBoundary: {
      seedMessageCount: 3,
      appendedInjection: [{ kind: 'trim-notice', messageIndex: 2 }],
    },
  };
}

test('accounted generation folds the replayed prefix, surfaces the declared injection, and keeps only new messages', () => {
  const record = {
    sessionId: 's2', endKind: null,
    handoff: accountedHandoff(),
    // 前两条为 runtime 前置注入（身份提示等），种子从 messageIndex 2 开始。
    messages: [
      { role: 'system', turn: 0, content: 'idp' },
      { role: 'system', turn: 0, content: 'reminder' },
      { role: 'user', turn: 1, content: 'start' },
      { role: 'assistant', turn: 1, content: 'answer' },
      { role: 'system', turn: 1, content: 'trim notice text' },
      { role: 'user', turn: 3, content: 'continue' },
      { role: 'assistant', turn: 3, content: 'next' },
    ],
    timestamps: [1, 1, 1, 2, 3, 5, 6],
  };
  const seg = segmentGeneration(record);
  assert.equal(seg.boundary, 'accounted');
  assert.equal(seg.offset, 2);
  assert.equal(seg.seedEnd, 5);
  assert.equal(seg.replayCount, 2);
  assert.deepEqual(seg.injections, [{ messageIndex: 4, injectionKind: 'trim-notice' }]);

  const result = projectThreadTranscript(
    { threadId: 'wt-1', agentId: 'ph', title: 'topic' },
    [
      { sessionId: 's1', endKind: 'trim', startedAt: 1, endedAt: 4, messages: [
        { role: 'user', turn: 1, content: 'start' },
        { role: 'assistant', turn: 1, content: 'answer' },
      ], timestamps: [1, 2] },
      record,
    ],
  );

  const replay = result.events.find((event) => event.kind === 'replay');
  assert.equal(replay.count, 2);
  assert.deepEqual([replay.fromMessageIndex, replay.toMessageIndex], [2, 5]);
  const header = result.events.filter((event) => event.kind === 'generation-header').at(-1);
  assert.equal(header.boundary, 'accounted');
  assert.equal(header.newCount, 2);
  const injection = result.events.find((event) => event.kind === 'injection');
  assert.equal(injection.injectionKind, 'trim-notice');
  assert.equal(injection.content, 'trim notice text');
  assert.deepEqual(injection.source, { sessionId: 's2', turn: 1, messageIndex: 4 });

  // 重放前缀（start/answer）不得再作为 message 事件出现；新增消息从 seedEnd 起。
  const messageContents = result.events.filter((event) => event.kind === 'message').map((event) => event.content);
  assert.deepEqual(messageContents, ['start', 'answer', 'continue', 'next']);
  const edge = result.events.find((event) => event.kind === 'succession');
  assert.equal(edge.endKind, 'trim');
  assert.deepEqual(result.events.at(-1).source, { sessionId: 's2', turn: 3, messageIndex: 6 });
});

test('generation without handoff account is reported as unknown and never folded by content guessing', () => {
  const result = projectThreadTranscript(
    { threadId: 'wt-2', agentId: 'ph' },
    [
      { sessionId: 's1', endKind: 'custom-transform', messages: [{ role: 'user', turn: 1, content: 'a' }], timestamps: [] },
      { sessionId: 's2', messages: [
        { role: 'user', turn: 1, content: 'a' },
        { role: 'user', turn: 2, content: 'b' },
      ], timestamps: [] },
    ],
  );
  const edge = result.events.find((event) => event.kind === 'succession');
  assert.equal(edge.endKind, 'custom-transform');
  const headers = result.events.filter((event) => event.kind === 'generation-header');
  assert.equal(headers[0].boundary, 'first');
  assert.equal(headers[1].boundary, 'unknown');
  assert.ok(headers[1].notes.includes('handoff-missing'));
  assert.equal(headers[1].replayCount, 0);
  // 无账目：与上一代重复的消息原样保留，不做内容判重折叠。
  assert.deepEqual(result.events.filter((event) => event.kind === 'message').map((event) => event.content), ['a', 'a', 'b']);
});

test('summary-message handoff presents the whole seed as one summary injection without a replayed prefix', () => {
  const record = {
    sessionId: 's2',
    handoff: {
      seedKind: 'summary-message',
      seedMessages: [{ role: 'system', turn: 0, content: 'generated summary' }],
    },
    messages: [
      { role: 'system', turn: 0, content: 'generated summary' },
      { role: 'user', turn: 1, content: 'follow-up' },
    ],
    timestamps: [3, 4],
  };
  const seg = segmentGeneration(record);
  assert.equal(seg.boundary, 'accounted');
  assert.equal(seg.replayCount, 0);
  assert.deepEqual(seg.injections, [{ messageIndex: 0, injectionKind: 'summary' }]);

  const result = projectThreadTranscript({ threadId: 'wt-3', agentId: 'ph' }, [
    { sessionId: 's1', endKind: 'summary', messages: [{ role: 'user', turn: 1, content: 'q' }], timestamps: [1] },
    record,
  ]);
  const injection = result.events.find((event) => event.kind === 'injection');
  assert.equal(injection.injectionKind, 'summary');
  assert.equal(injection.content, 'generated summary');
  assert.equal(result.events.find((event) => event.kind === 'replay'), undefined);
  assert.deepEqual(result.events.filter((event) => event.kind === 'message').map((event) => event.content), ['q', 'follow-up']);
});

test('route resolves the successor handoff account via session index metadata and skips the first generation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'thread-transcript-'));
  try {
    const threadsRoot = path.join(root, 'threads');
    const sessionsRoot = path.join(root, 'sessions');
    await fs.mkdir(path.join(threadsRoot, 'threads'), { recursive: true });
    await fs.mkdir(sessionsRoot, { recursive: true });
    await fs.writeFile(path.join(threadsRoot, 'threads', 'wt-route.json'), JSON.stringify({
      threadId: 'wt-route', agentId: 'ph', sessionChain: [
        { sessionId: 's1', endKind: 'trim', startedAt: 1, endedAt: 2 },
        { sessionId: 's2', startedAt: 3 },
      ],
    }));
    const saveSession = async (id, messages) => fs.writeFile(path.join(sessionsRoot, `${id}.json`), JSON.stringify({
      runtime: { context: { messages, enrichedMessages: [] } },
    }));
    await saveSession('s1', [{ role: 'user', turn: 1, content: 'q' }]);
    await saveSession('s2', [
      { role: 'system', turn: 0, content: 'generated summary' },
      { role: 'user', turn: 1, content: 'follow-up' },
    ]);
    const routes = new Map();
    const app = { get: (route, handler) => routes.set(route, handler) };
    const readHandoffCalls = [];
    setupThreadTranscriptRoute(app, {
      threadsRoot,
      getSessionFilePath: (_agentId, sessionId) => path.join(sessionsRoot, `${sessionId}.json`),
      readSessionIndex: async () => ({ sessions: [
        { id: 's1' },
        { id: 's2', metadata: { handoffId: 'h1' } },
      ] }),
      readHandoff: async (agentId, handoffId) => {
        readHandoffCalls.push({ agentId, handoffId });
        return {
          seedKind: 'summary-message',
          seedMessages: [{ role: 'system', turn: 0, content: 'generated summary' }],
        };
      },
    });
    let body;
    let statusCode = 200;
    const res = { status(code) { statusCode = code; return this; }, json(value) { body = value; return this; } };
    let nextError;
    await routes.get('/protoclaw/thread_transcript')({ query: { threadId: 'wt-route' } }, res, (error) => { nextError = error; });
    assert.equal(nextError, undefined);
    assert.equal(statusCode, 200);
    // 只有第二代（successor）读包；第一代不读。
    assert.deepEqual(readHandoffCalls, [{ agentId: 'ph', handoffId: 'h1' }]);
    const injection = body.events.find((event) => event.kind === 'injection');
    assert.equal(injection.injectionKind, 'summary');
    assert.equal(injection.content, 'generated summary');
    assert.deepEqual(body.events.filter((event) => event.kind === 'message').map((event) => event.content), ['q', 'follow-up']);
    const header = body.events.filter((event) => event.kind === 'generation-header').at(-1);
    assert.equal(header.boundary, 'accounted');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
