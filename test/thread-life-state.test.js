/**
 * Tests for thread life-state synthesis + archive (Q4/Q5/Q11/Q14/Q15)
 *
 * Covers:
 * 1. synthesizeThreadLifeState (pure): four-state priority, failed flag,
 *    closed filtering value, lastEventAt merge.
 * 2. ThreadArchiveIndex: persistence, idempotent archive/unarchive.
 * 3. Thread routes: list/get attach lifeState; archived thread rejects
 *    commands + deliver (409 thread_archived); busy thread rejects
 *    archive (409 thread_busy); archive/unarchive happy path.
 *
 * Uses node:test per project convention; mock app pattern per
 * coder-acp-routes.test.js; real temp dirs for store + archive index.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { synthesizeThreadLifeState } from '../server/thread-control/thread-life-state.js';
import { ThreadArchiveIndex } from '../server/thread-control/thread-archive.js';
import { setupThreadRoutes } from '../server/thread-control/thread-routes.js';

// ── helpers ──────────────────────────────────────────────────────

function makeThreadRecord(overrides = {}) {
  return {
    threadId: 'wt-test',
    agentId: 'programming-helper',
    status: 'open',
    commands: [],
    updatedAt: 1000,
    ...overrides,
  };
}

function makeBoardState(overrides = {}) {
  return { status: 'idle', updatedAt: 900, ...overrides };
}

function makeMockApp() {
  const routes = {};
  const mockApp = {
    get: (p, ...h) => { routes[`GET ${p}`] = h; },
    post: (p, ...h) => { routes[`POST ${p}`] = h; },
  };
  mockApp._routes = routes;
  return mockApp;
}

function makeMockExpress() {
  return { json: () => (_req, _res, next) => next?.() };
}

function makeMockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
  };
}

async function makeTempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'claw-life-state-'));
}

// ── 1. pure synthesis ────────────────────────────────────────────

describe('synthesizeThreadLifeState (four-state model)', () => {
  it('idle: open thread, idle board, no pending commands', () => {
    const life = synthesizeThreadLifeState({ thread: makeThreadRecord(), boardState: makeBoardState() });
    assert.deepEqual(life, { lifeState: 'idle', archivedAt: null, failed: false, lastEventAt: 1000 });
  });

  it('executing: board running wins over pending commands', () => {
    const thread = makeThreadRecord({
      commands: [{ status: 'pending' }],
    });
    const life = synthesizeThreadLifeState({ thread, boardState: makeBoardState({ status: 'running' }) });
    assert.equal(life.lifeState, 'executing');
  });

  it('executing: anchor rotating is active work even with idle board', () => {
    const life = synthesizeThreadLifeState({
      thread: makeThreadRecord({ status: 'rotating' }),
      boardState: makeBoardState(),
    });
    assert.equal(life.lifeState, 'executing');
  });

  it('pending-commands: pending commands without running board', () => {
    const life = synthesizeThreadLifeState({
      thread: makeThreadRecord({ commands: [{ status: 'delivered' }, { status: 'pending' }] }),
      boardState: makeBoardState(),
    });
    assert.equal(life.lifeState, 'pending-commands');
  });

  it('archived overrides everything, failed flag suppressed', () => {
    const life = synthesizeThreadLifeState({
      thread: makeThreadRecord(),
      boardState: makeBoardState({ status: 'running' }),
      archiveEntry: { archivedAt: 4242 },
    });
    assert.deepEqual(life, { lifeState: 'archived', archivedAt: 4242, failed: false, lastEventAt: 1000 });
  });

  it('failed is an attention flag, not a life position: board failed still idles', () => {
    const life = synthesizeThreadLifeState({
      thread: makeThreadRecord(),
      boardState: makeBoardState({ status: 'failed' }),
    });
    assert.equal(life.lifeState, 'idle');
    assert.equal(life.failed, true);
  });

  it('rotation_failed anchor also raises the failed flag', () => {
    const life = synthesizeThreadLifeState({
      thread: makeThreadRecord({ status: 'rotation_failed' }),
    });
    assert.equal(life.failed, true);
    assert.equal(life.lifeState, 'idle');
  });

  it('closed threads report closed for caller-side filtering', () => {
    const life = synthesizeThreadLifeState({ thread: makeThreadRecord({ status: 'closed' }) });
    assert.equal(life.lifeState, 'closed');
  });

  it('lastEventAt merges anchor and board timestamps', () => {
    const life = synthesizeThreadLifeState({
      thread: makeThreadRecord({ updatedAt: 500 }),
      boardState: makeBoardState({ updatedAt: 700 }),
    });
    assert.equal(life.lastEventAt, 700);
  });
});

// ── 2. archive index persistence ─────────────────────────────────

describe('ThreadArchiveIndex', () => {
  let root;
  before(async () => { root = await makeTempRoot(); });
  after(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('persists across instances; archive idempotent; unarchive idempotent', async () => {
    const idx1 = new ThreadArchiveIndex({ rootDir: root });
    assert.equal(await idx1.isArchived('wt-a'), false);

    const entry = await idx1.archive('wt-a');
    assert.equal(typeof entry.archivedAt, 'number');

    const again = await idx1.archive('wt-a');
    assert.equal(again.archivedAt, entry.archivedAt, 're-archive keeps original timestamp');

    // 新实例读同一目录（重启不丢）
    const idx2 = new ThreadArchiveIndex({ rootDir: root });
    assert.equal(await idx2.isArchived('wt-a'), true);
    assert.deepEqual(Object.keys(await idx2.list()), ['wt-a']);

    await idx2.unarchive('wt-a');
    await idx2.unarchive('wt-a'); // 幂等
    assert.equal(await idx1.isArchived('wt-a'), false);
    assert.deepEqual(await idx1.list(), {});
  });
});

// ── 3. routes: attachment + archive guards ───────────────────────

describe('thread routes — lifeState attachment + archive semantics', () => {
  let root;
  let control;
  let app;

  async function call(method, routePath, { params = {}, query = {}, body } = {}) {
    const handlers = app._routes[`${method} ${routePath}`];
    const res = makeMockRes();
    await handlers[handlers.length - 1]({ params, query, body }, res);
    return res;
  }

  before(async () => {
    root = await makeTempRoot();
    // 最小 core/board 桩：路由测试只关心路由层逻辑
    const makeThread = (id, overrides) => ({ threadId: id, agentId: 'programming-helper', status: 'open', commands: [], updatedAt: 1, ...overrides });
    const threads = new Map([
      ['wt-idle', makeThread('wt-idle')],
      ['wt-busy', makeThread('wt-busy', { commands: [{ status: 'pending' }] })],
    ]);
    const boardStates = new Map([['wt-busy', { status: 'running', updatedAt: 5 }]]);
    control = {
      core: {
        listThreads: async () => [...threads.values()],
        getThread: async (id) => threads.get(id) || null,
        appendCommand: async () => ({ duplicate: false }),
        deliverPendingCommands: async () => ({ delivered: 0 }),
      },
      board: {
        getState: async (id) => boardStates.get(id) || null,
      },
      archive: new ThreadArchiveIndex({ rootDir: root }),
    };
    app = makeMockApp();
    setupThreadRoutes(app, makeMockExpress(), { control });
  });
  after(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('GET list attaches synthesized lifeState per thread', async () => {
    const res = await call('GET', '/protoclaw/threads', { query: {} });
    assert.equal(res.statusCode, 200);
    const byId = Object.fromEntries(res.body.threads.map((t) => [t.threadId, t]));
    assert.equal(byId['wt-idle'].lifeState, 'idle');
    assert.equal(byId['wt-busy'].lifeState, 'executing');
    assert.equal(byId['wt-busy'].failed, false);
  });

  it('GET detail attaches lifeState', async () => {
    const res = await call('GET', '/protoclaw/threads/:threadId', { params: { threadId: 'wt-busy' } });
    assert.equal(res.body.thread.lifeState, 'executing');
  });

  it('archive rejects busy thread with 409 thread_busy (先中断再归档)', async () => {
    const res = await call('POST', '/protoclaw/threads/:threadId/archive', { params: { threadId: 'wt-busy' } });
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'thread_busy');
  });

  it('archive → commands/deliver rejected with 409 thread_archived; unarchive restores', async () => {
    const arch = await call('POST', '/protoclaw/threads/:threadId/archive', { params: { threadId: 'wt-idle' } });
    assert.equal(arch.statusCode, 200);
    assert.equal(arch.body.archivedAt > 0, true);

    const send = await call('POST', '/protoclaw/threads/:threadId/commands', {
      params: { threadId: 'wt-idle' },
      body: { kind: 'user_message', text: 'hello' },
    });
    assert.equal(send.statusCode, 409);
    assert.equal(send.body.code, 'thread_archived');

    const deliver = await call('POST', '/protoclaw/threads/:threadId/deliver', { params: { threadId: 'wt-idle' } });
    assert.equal(deliver.statusCode, 409);
    assert.equal(deliver.body.code, 'thread_archived');

    // 归档后列表呈现 archived 态
    const list = await call('GET', '/protoclaw/threads', { query: {} });
    const archived = list.body.threads.find((t) => t.threadId === 'wt-idle');
    assert.equal(archived.lifeState, 'archived');

    const unarch = await call('POST', '/protoclaw/threads/:threadId/unarchive', { params: { threadId: 'wt-idle' } });
    assert.equal(unarch.statusCode, 200);
    const send2 = await call('POST', '/protoclaw/threads/:threadId/commands', {
      params: { threadId: 'wt-idle' },
      body: { kind: 'user_message', text: 'hello' },
    });
    assert.equal(send2.statusCode, 201);
  });

  it('archive on unknown thread → 404', async () => {
    const res = await call('POST', '/protoclaw/threads/:threadId/archive', { params: { threadId: 'wt-none' } });
    assert.equal(res.statusCode, 404);
  });
});
