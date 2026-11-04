/**
 * 会话标题状态与来源保护（ADR-0041）
 *
 * 行为契约：
 * 1. titleState 是标题来源的唯一判据，标题文案只用于展示。
 * 2. 用户手动改名（PUT .../title）把状态置为 user，此后再走生成端点不得覆盖。
 * 3. 生成端点成功落盘时把状态置为 auto。
 * 4. 接续（handoff resume）创建的新 Session 继承来源标题，且不加任何前缀。
 * 5. 分支创建保留「（分支）」前缀。
 *
 * 全程隔离数据根（AGENTDEV_DATA_DIR），无真实模型请求、无 runtime 子进程。
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_ROOT = mkdtempSync(join(tmpdir(), 'claw-title-state-'));
process.env.AGENTDEV_DATA_DIR = DATA_ROOT;

after(async () => {
  const { closeAllSessionDbs } = await import('../server/shared/session-access.js');
  closeAllSessionDbs();
  rmSync(DATA_ROOT, { recursive: true, force: true });
});

const { createSessionHelpers } = await import('../server/routes/session-helpers.js');
const { setupSessionRoutes } = await import('../server/routes/session.js');
const { readWorkspaceState, writeWorkspaceState } = await import('../server/routes/workspace.js');
const { readSessionIndex } = await import('../server/shared/session-access.js');
const { HANDOFF_SCHEMA_VERSION } = await import('@agentdevjs/core');

const AGENT_ID = 'programming-helper';

function makeHelpers() {
  return createSessionHelpers({
    readWorkspaceState,
    writeWorkspaceState,
    discoverAgents: async () => [{ id: AGENT_ID }],
    enrichAgent: async (agent) => agent,
    startManagedAgent: async () => ({ ok: true }),
    waitForManagedRuntimeReady: async () => true,
  });
}

function captureHandlers(helpers) {
  const handlers = {};
  const app = {
    get: (p, ...rest) => { handlers[`GET ${p}`] = rest[rest.length - 1]; },
    post: (p, ...rest) => { handlers[`POST ${p}`] = rest[rest.length - 1]; },
    put: (p, ...rest) => { handlers[`PUT ${p}`] = rest[rest.length - 1]; },
    delete: (p, ...rest) => { handlers[`DELETE ${p}`] = rest[rest.length - 1]; },
  };
  setupSessionRoutes(app, { json: () => (_req, _res, next) => next?.() }, {
    ...helpers,
    requireAgentLight: async (agentId) => ({ id: agentId, permissions: undefined }),
    discoverAgents: async () => [{ id: AGENT_ID }],
    startManagedAgent: async () => ({ ok: true }),
    stopManagedAgent: async () => {},
    waitForManagedRuntimeReady: async () => true,
    notifySessionLineage: null,
    notifySessionArchived: null,
    clearUISurfaces: async () => {},
    threadRotation: {},
    threadLifecycle: { findThreadBySession: async () => null },
    threadSuccession: {},
    threadDelete: {},
  });
  return handlers;
}

function makeRes() {
  return {
    statusCode: 200,
    jsonPayload: null,
    error: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.jsonPayload = payload; },
  };
}

async function call(handler, req) {
  const res = makeRes();
  await handler(req, res, (error) => { res.error = error; });
  return res;
}

async function readRecord(sessionId) {
  const index = await readSessionIndex(AGENT_ID);
  return index.sessions.find((session) => session.id === sessionId) || null;
}

async function createSession(helpers, extra = {}) {
  return helpers.createPrebuiltSession(AGENT_ID, { returnSummary: false, ...extra });
}

describe('标题状态：创建路径写入来源', () => {
  test('全新对话是 placeholder，显式标题是 auto', async () => {
    const helpers = makeHelpers();

    const placeholder = await createSession(helpers);
    assert.equal(placeholder.titleState, 'placeholder',
      '等待应用策略起名的会话必须是占位状态');

    const explicit = await createSession(helpers, { title: '排查幽灵会话' });
    assert.equal(explicit.titleState, 'auto',
      '创建方直接给定标题，来源是写入方而不是占位');
  });
});

describe('标题状态：用户改名后不被生成覆盖', () => {
  test('改名把状态置为 user，随后生成端点拒绝覆盖', async () => {
    const helpers = makeHelpers();
    const handlers = captureHandlers(helpers);
    const session = await createSession(helpers);

    const renamed = await call(
      handlers['PUT /protoclaw/prebuilt_sessions/:sessionId/title'],
      {
        params: { sessionId: session.id },
        body: { agentId: AGENT_ID, title: '用户起的名字' },
        headers: {},
      },
    );
    assert.equal(renamed.statusCode, 200);
    assert.equal((await readRecord(session.id)).titleState, 'user',
      '手动改名必须记录为用户接管');

    // 生成端点在用户接管后到达：必须明确跳过，且不改写标题。跳过要在调用模型
    // 之前发生，因此这里不可能产生任何标题内容。
    const generated = await call(
      handlers['POST /protoclaw/generate_session_title'],
      { body: { agentId: AGENT_ID, sessionId: session.id }, headers: {} },
    );
    assert.equal(generated.statusCode, 200);
    assert.equal(generated.jsonPayload?.skipped, 'user_owned_title',
      '用户接管后，后台生成必须被明确跳过而不是静默继续');
    const after = await readRecord(session.id);
    assert.equal(after.title, '用户起的名字', '用户标题不得被生成覆盖');
    assert.equal(after.titleState, 'user');
  });
});

describe('标题状态：接续与分支', () => {
  test('接续创建的新 Session 继承来源标题且不加前缀', async () => {
    const helpers = makeHelpers();
    const handlers = captureHandlers(helpers);
    const source = await createSession(helpers, { title: '重构标题生成' });
    writeSessionSnapshot(source.id);
    const handoffPath = writeHandoff(source.id, '重构标题生成');

    const resumed = await call(
      handlers['POST /protoclaw/context_handoffs/compacted_resume'],
      {
        body: { agentId: AGENT_ID, handoffPath, startRuntime: false },
        headers: {},
      },
    );
    assert.equal(resumed.statusCode, 200, JSON.stringify(resumed.jsonPayload));
    const newSessionId = resumed.jsonPayload?.session?.id;
    assert.ok(newSessionId, '接续必须返回新会话 id');

    const record = await readRecord(newSessionId);
    assert.equal(record.title, '重构标题生成',
      '接续只更换承载内容的 Session，标题沿用来源，不附加（精简）/（摘要）');
    assert.equal(record.titleState, 'auto',
      '来源是创建方写入的标题，接续后仍是同一来源');
  });

  test('分支创建保留（分支）前缀并继承来源状态', async () => {
    const helpers = makeHelpers();
    const handlers = captureHandlers(helpers);
    const source = await createSession(helpers, { title: '重构标题生成' });
    writeSessionSnapshot(source.id);

    const branched = await call(
      handlers['POST /protoclaw/sessions/branch'],
      {
        body: { agentId: AGENT_ID, sourceSessionId: source.id, cutMsgIndexEnd: 1 },
        headers: {},
      },
    );
    assert.equal(branched.statusCode, 200, JSON.stringify(branched.jsonPayload));
    const branchId = branched.jsonPayload?.session?.id
      || branched.jsonPayload?.newSessionId;
    assert.ok(branchId, '分支创建必须返回新会话 id');

    const record = await readRecord(branchId);
    assert.equal(record.title, '（分支）重构标题生成',
      '分支是用户显式发起的分叉动作，标题保留（分支）前缀');
  });
});

// 最小 handoff 包：只需 readHandoffPackage + createCompactedResumeFromHandoff
// 消费的字段（schemaVersion / sourceAgentId / sourceSessionId / sourceRecord）。
function writeHandoff(sourceSessionId, sourceTitle) {
  const dir = join(DATA_ROOT, 'context-handoffs', AGENT_ID);
  mkdirSync(dir, { recursive: true });
  const handoffId = `handoff-${sourceSessionId}`;
  writeFileSync(join(dir, `${handoffId}.json`), JSON.stringify({
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    handoffId,
    createdAt: new Date().toISOString(),
    sourceAgentId: AGENT_ID,
    sourceSessionId,
    mode: 'trim-transcript',
    sourceRecord: { title: sourceTitle, sessionType: 'main' },
    stats: { synthetic: true },
  }), 'utf8');
  return join(dir, `${handoffId}.json`);
}

// 最小可接续 / 可分支的会话快照：只消费 messages / runtime / rollbackHistory。
function writeSessionSnapshot(sessionId, messageCount = 2) {
  const messages = Array.from({ length: messageCount }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `m${i}`,
    turn: Math.floor(i / 2),
  }));
  const dir = join(DATA_ROOT, 'workspaces', AGENT_ID, 'sessions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.json`), JSON.stringify({
    sessionId,
    savedAt: Date.now(),
    runtime: {
      callIndex: Math.max(-1, Math.ceil(messageCount / 2) - 1),
      callState: 'idle',
      context: { messages, enrichedMessages: [] },
      featureStates: [],
    },
    rollbackHistory: [],
  }), 'utf8');
}
