/**
 * /protoclaw/session_record —— 只读浏览的数据面契约
 *
 * 只读浏览（归档对话 / 线程历史存档 / 工作群记录）不启动 runtime，界面靠这条
 * 路由取会话自身持久记录。它必须与存活 runtime 的 /messages 同源同形，否则
 * 只读视图会成为「残缺的第二套界面」：
 *   - 渲染器消费的富字段（display 的 diff、images、thinkingBlocks、source、
 *     execution、usage、toolCallId）必须原样带出，不能被裁成 role+content；
 *   - 时间锚 timestamps 与 messages 等长平行对齐（渲染器按长度相等才合并，
 *     失配则整份时间线静默丢失）；
 *   - turn 过滤同时裁剪两者，索引不错位；
 *   - 归档事实与标题随记录下发，打开入口据此走只读而不依赖列表缓存。
 *
 * 全程隔离数据根（AGENTDEV_DATA_DIR 先于 import 设置）。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_ROOT = mkdtempSync(join(tmpdir(), 'claw-session-record-'));
process.env.AGENTDEV_DATA_DIR = DATA_ROOT;

const AGENT = 'programming-helper';
const SESSION = 'session-readonly-record';

const { getPrebuiltAgentSessionDir, getPrebuiltSessionFilePath, writeSessionIndex, closeAllSessionDbs } =
  await import('../server/shared/session-access.js');
const { setupSessionRoutes } = await import('../server/routes/session.js');

after(() => {
  closeAllSessionDbs();
  rmSync(DATA_ROOT, { recursive: true, force: true });
});

function captureRecordRoute() {
  const handlers = {};
  const fakeMethods = {
    get: (p, ...rest) => { handlers[`GET ${p}`] = rest[rest.length - 1]; },
    post: () => {}, put: () => {}, delete: () => {}, patch: () => {},
  };
  setupSessionRoutes({ ...fakeMethods }, { json: () => (_req, _res, next) => next?.() }, {
    requireAgentLight: async (agentId) => ({ id: agentId }),
    discoverAgents: async () => [{ id: AGENT }],
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
  return handlers['GET /protoclaw/session_record'];
}

function makeRes() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; },
  };
}

// 会话快照：消息与 enrichedMessages 平行等长，enriched 侧带 timestamp
const SNAPSHOT = {
  goal: '只读浏览数据面',
  runtime: {
    context: {
      messages: [
        { role: 'system', content: 'sys', turn: 1 },
        { role: 'user', content: '修一下这个 bug', turn: 1 },
        {
          role: 'assistant',
          content: '',
          turn: 1,
          reasoning: '先读代码',
          toolCalls: [{ id: 'call-1', name: 'read', arguments: { file_path: 'src/a.js' } }],
        },
        {
          role: 'tool',
          content: '{"ok":true}',
          turn: 1,
          toolCallId: 'call-1',
          display: { diff: '+added' },
          execution: { durationMs: 12 },
        },
        { role: 'assistant', content: '已修复', turn: 2, usage: { input: 10, output: 5 } },
      ],
      enrichedMessages: [
        { role: 'system', timestamp: 1000 },
        { role: 'user', timestamp: 2000 },
        { role: 'assistant', timestamp: 3000 },
        { role: 'tool', timestamp: 4000 },
        { role: 'assistant', timestamp: 5000 },
      ],
    },
  },
};

before(async () => {
  mkdirSync(getPrebuiltAgentSessionDir(AGENT), { recursive: true });
  writeFileSync(getPrebuiltSessionFilePath(AGENT, SESSION), JSON.stringify(SNAPSHOT), 'utf8');
  await writeSessionIndex(AGENT, {
    revision: 1,
    activeSessionId: null,
    sessions: [{
      id: SESSION,
      title: '  归档的那次修复  ',
      archived: true,
      sessionType: 'main',
      workspaceAgentId: 'main',
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-02T00:00:00Z',
    }],
  });
});

describe('session_record 只读数据面', () => {
  test('富字段原样带出：渲染器不会因只读而丢卡片/图片/思考块', async () => {
    const handler = captureRecordRoute();
    const res = makeRes();
    await handler({ query: { agentId: AGENT, sessionId: SESSION } }, res);

    assert.equal(res.statusCode, 200);
    const [system, user, assistant, tool, final] = res.payload.messages;
    assert.equal(user.content, '修一下这个 bug');
    // 思考与工具调用
    assert.equal(assistant.reasoning, '先读代码');
    assert.deepEqual(assistant.toolCalls, [{ id: 'call-1', name: 'read', arguments: { file_path: 'src/a.js' } }]);
    // 工具结果卡片的富数据
    assert.deepEqual(tool.display, { diff: '+added' });
    assert.equal(tool.toolCallId, 'call-1');
    assert.deepEqual(tool.execution, { durationMs: 12 });
    // 用量（只读视图的统计不因无 runtime 而消失）
    assert.deepEqual(final.usage, { input: 10, output: 5 });
    assert.equal(system.role, 'system');
  });

  test('时间锚与消息等长平行对齐（失配则渲染器整份丢弃时间线）', async () => {
    const handler = captureRecordRoute();
    const res = makeRes();
    await handler({ query: { agentId: AGENT, sessionId: SESSION } }, res);

    const { messages, timestamps } = res.payload;
    assert.equal(timestamps.length, messages.length);
    assert.deepEqual(timestamps, [1000, 2000, 3000, 4000, 5000]);
  });

  test('turn 过滤同时裁剪消息与时间锚，索引不错位', async () => {
    const handler = captureRecordRoute();
    const res = makeRes();
    await handler({ query: { agentId: AGENT, sessionId: SESSION, turn: '2' } }, res);

    assert.equal(res.payload.messages.length, 1);
    assert.equal(res.payload.messages[0].content, '已修复');
    assert.deepEqual(res.payload.timestamps, [5000]);
  });

  test('归档事实与标题随记录下发（打开入口据此走只读，不依赖列表缓存）', async () => {
    const handler = captureRecordRoute();
    const res = makeRes();
    await handler({ query: { agentId: AGENT, sessionId: SESSION } }, res);

    assert.equal(res.payload.archived, true);
    assert.equal(res.payload.title, '归档的那次修复');
    assert.equal(res.payload.sessionId, SESSION);
  });

  test('无线程索引时线程归属为空串（非线程会话不炸、不伪造）', async () => {
    const handler = captureRecordRoute();
    const res = makeRes();
    await handler({ query: { agentId: AGENT, sessionId: SESSION } }, res);

    assert.equal(res.payload.threadId, '');
    assert.equal(res.payload.threadTitle, '');
  });

  test('线程归属反查：sessionIds 命中时透出，不含本会话时保持空串', async () => {
    // threads/index.json 与数据根同根（AGENTDEV_DATA_DIR 隔离），随会话快照落位
    const threadsDir = join(DATA_ROOT, 'threads');
    const indexFile = join(threadsDir, 'index.json');
    const writeThreadIndex = (threads) => {
      mkdirSync(threadsDir, { recursive: true });
      writeFileSync(indexFile, JSON.stringify({ threads }), 'utf8');
    };

    // 命中：本会话在线程的 sessionIds 里 → threadId / threadTitle 下发
    writeThreadIndex([
      { threadId: 'wt-other', title: '别的线程', sessionIds: ['session-elsewhere'] },
      { threadId: 'wt-owning', title: '修复调度链路', sessionIds: ['session-prev-gen', SESSION] },
    ]);
    let handler = captureRecordRoute();
    let res = makeRes();
    await handler({ query: { agentId: AGENT, sessionId: SESSION } }, res);
    assert.equal(res.payload.threadId, 'wt-owning');
    assert.equal(res.payload.threadTitle, '修复调度链路');

    // 不含本会话：索引存在也保持空串（反查按 sessionIds 匹配，不是取第一条）
    writeThreadIndex([{ threadId: 'wt-other', title: '别的线程', sessionIds: ['session-elsewhere'] }]);
    handler = captureRecordRoute();
    res = makeRes();
    await handler({ query: { agentId: AGENT, sessionId: SESSION } }, res);
    assert.equal(res.payload.threadId, '');
    assert.equal(res.payload.threadTitle, '');
  });

  test('会话文件不存在 → 404（消费方据 404 区分「已删除」与「服务故障」）', async () => {
    const handler = captureRecordRoute();
    const res = makeRes();
    await handler({ query: { agentId: AGENT, sessionId: 'no-such-session' } }, res);
    assert.equal(res.statusCode, 404);
  });
});
