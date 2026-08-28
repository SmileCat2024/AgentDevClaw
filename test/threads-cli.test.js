/**
 * Generic Thread CLI black-box tests.
 *
 * The test server only checks the CLI-to-HTTP mapping; Thread semantics are
 * covered by test/thread-control.test.js.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI_PATH = path.join(PROJECT_ROOT, 'bin', 'claw.mjs');

const servers = [];

after(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
});

function startFakeClawServer() {
  const requests = [];
  const watchState = { showCalls: 0 };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });

    let payload = { ok: true };
    if (req.url === '/protoclaw/threads?agentId=coder') {
      payload = { ok: true, threads: [{ threadId: 'wt-1', agentId: 'coder', status: 'idle', lifeState: 'executing', title: '工单025', headSessionId: 's-1' }] };
    } else if (req.url === '/protoclaw/threads' && req.method === 'POST') {
      payload = { ok: true, thread: { threadId: 'wt-new', agentId: 'coder', status: 'idle', headSessionId: 's-1' } };
    } else if (req.url === '/protoclaw/prebuilt_sessions' && req.method === 'POST') {
      payload = {
        ok: true,
        session: { id: 'session-new', title: '工单025' },
        threadId: 'wt-new-thread',
        targetSessionId: 'session-new',
      };
    } else if (req.url === '/protoclaw/threads/wt-1' && req.method === 'GET') {
      payload = { ok: true, thread: { threadId: 'wt-1', lifeState: 'executing', failed: false } };
    } else if (req.url === '/protoclaw/threads/wt-idle' && req.method === 'GET') {
      payload = { ok: true, thread: { threadId: 'wt-idle', lifeState: 'idle' } };
    } else if (req.url === '/protoclaw/threads/wt-idle/commands') {
      payload = { ok: true, command: { commandId: 'cmd-idle', status: 'pending' }, duplicate: false };
    } else if (req.url === '/protoclaw/threads/wt-1/events?after=2') {
      payload = { ok: true, events: [{ type: 'turn.completed', turn: 1 }], cursor: 3 };
    } else if (req.url === '/protoclaw/threads/wt-1/commands') {
      payload = { ok: true, command: { commandId: 'cmd-1', status: 'pending', kind: 'user_message' }, duplicate: false, delivery: { delivered: true } };
    } else if (req.url === '/protoclaw/threads/wt-1/head') {
      payload = { ok: true, thread: { threadId: 'wt-1', status: 'idle', headSessionId: 's-2' } };
    } else if (req.url === '/protoclaw/threads/wt-watch' && req.method === 'GET') {
      watchState.showCalls += 1;
      // 首查 executing（在办），之后 idle + 无 pending → 配合事件游标落定
      const executing = watchState.showCalls === 1;
      payload = { ok: true, thread: { threadId: 'wt-watch', status: 'open', lifeState: executing ? 'executing' : 'idle', failed: false, commands: [] } };
    } else if (req.url === '/protoclaw/threads/wt-watch/events') {
      payload = { ok: true, events: [], cursor: 1 };
    } else if (req.url === '/protoclaw/threads/wt-watch/events?after=1') {
      payload = { ok: true, events: [{ type: 'turn.completed', turn: 1 }], cursor: 2 };
    } else if (req.url === '/protoclaw/threads/wt-stuck' && req.method === 'GET') {
      payload = { ok: true, thread: { threadId: 'wt-stuck', status: 'open', lifeState: 'executing', failed: false, commands: [] } };
    } else if (req.url === '/protoclaw/threads/wt-stuck/events') {
      payload = { ok: true, events: [], cursor: 0 };
    }

    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(payload));
  });
  servers.push(server);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port,
    requests,
  })));
}

function runCli(port, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test('claw threads maps generic commands to Thread HTTP routes', async () => {
  const fake = await startFakeClawServer();

  const listed = await runCli(fake.port, ['threads', 'list', '--agent', 'coder', '--format', 'json']);
  assert.equal(listed.code, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout).threads[0], {
    threadId: 'wt-1', agentId: 'coder', status: 'idle', lifeState: 'executing', title: '工单025', headSessionId: 's-1',
  });

  const created = await runCli(fake.port, [
    'threads', 'create', '--agent', 'coder', '--session', 's-1', '--title', 'demo',
    '--mode', 'autonomous', '--format', 'json',
  ]);
  assert.equal(created.code, 0, created.stderr);
  const createRequest = fake.requests.find((request) => request.method === 'POST' && request.url === '/protoclaw/threads');
  assert.deepEqual(createRequest.body, {
    agentId: 'coder', sessionId: 's-1', title: 'demo', mode: 'autonomous',
  });

  const events = await runCli(fake.port, ['threads', 'events', 'wt-1', '--after', '2', '--format', 'jsonl']);
  assert.equal(events.code, 0, events.stderr);
  assert.deepEqual(JSON.parse(events.stdout.trim()), { type: 'turn.completed', turn: 1 });

  const sent = await runCli(fake.port, [
    'threads', 'send', 'wt-1', '--text', '继续执行', '--kind', 'external',
    '--source', 'cli', '--idempotency-key', 'cli-1', '--format', 'json',
  ]);
  assert.equal(sent.code, 0, sent.stderr);
  const sendRequest = fake.requests.find((request) => request.url === '/protoclaw/threads/wt-1/commands');
  assert.deepEqual(sendRequest.body, {
    text: '继续执行', kind: 'external', source: 'cli', idempotencyKey: 'cli-1',
  });

  const advanced = await runCli(fake.port, [
    'threads', 'advance', 'wt-1', '--to-session', 's-2', '--from-session', 's-1',
    '--expected-revision', '7', '--end-kind', 'context_rotation', '--format', 'json',
  ]);
  assert.equal(advanced.code, 0, advanced.stderr);
  const advanceRequest = fake.requests.find((request) => request.url === '/protoclaw/threads/wt-1/head');
  assert.deepEqual(advanceRequest.body, {
    toSessionId: 's-2', fromSessionId: 's-1', expectedRevision: 7, endKind: 'context_rotation',
  });
});

test('claw sessions create maps to prebuilt session API and prints thread handle', async () => {
  const fake = await startFakeClawServer();

  const result = await runCli(fake.port, [
    'sessions', 'create', '--agent', 'programming-helper', '--session-type', 'coder',
    '--title', '工单025', '--dir', 'D:/code/AgentDevClaw', '--format', 'json',
  ]);
  assert.equal(result.code, 0, result.stderr);
  const createRequest = fake.requests.find((request) => request.url === '/protoclaw/prebuilt_sessions');
  assert.deepEqual(createRequest.body, {
    agentId: 'programming-helper', sessionType: 'coder', title: '工单025', openDirectory: 'D:/code/AgentDevClaw',
  });
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.threadId, 'wt-new-thread');
  assert.equal(parsed.session.id, 'session-new');
});

test('threads send --wait-started reports turn start and timeout via lifeState polling', async () => {
  const fake = await startFakeClawServer();

  const started = await runCli(fake.port, [
    'threads', 'send', 'wt-1', '--text', '开工', '--wait-started', '5', '--format', 'json',
  ]);
  assert.equal(started.code, 0, started.stderr);
  const startedPayload = JSON.parse(started.stdout);
  assert.equal(startedPayload.started, true);
  assert.equal(startedPayload.lifeState, 'executing');

  const timedOut = await runCli(fake.port, [
    'threads', 'send', 'wt-idle', '--text', '开工', '--wait-started', '1', '--format', 'json',
  ]);
  assert.equal(timedOut.code, 0, timedOut.stderr);
  const timedOutPayload = JSON.parse(timedOut.stdout);
  assert.equal(timedOutPayload.started, false);
});

test('claw threads validates required options without contacting the server', async () => {
  const result = await runCli('1', ['threads', 'create', '--agent', 'coder']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /缺少 --session 参数/);

  const missingFromSession = await runCli('1', [
    'threads', 'advance', 'wt-1', '--to-session', 's-2',
  ]);
  assert.notEqual(missingFromSession.code, 0);
  assert.match(missingFromSession.stderr, /--from-session 必填/, 'K23：head 推进必须显式携带当前 head');

  const invalidRevision = await runCli('1', [
    'threads', 'advance', 'wt-1', '--to-session', 's-2', '--from-session', 's-1', '--expected-revision', 'not-a-number',
  ]);
  assert.notEqual(invalidRevision.code, 0);
  assert.match(invalidRevision.stderr, /--expected-revision 必须是非负整数/);
});

test('claw threads help is available without a server', async () => {
  const result = await runCli('1', ['threads', 'help']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /claw threads list/);
  assert.match(result.stdout, /claw threads close/);
});

test('threads text output is compact and exposes dispatch-critical fields', async () => {
  const fake = await startFakeClawServer();

  const listed = await runCli(fake.port, ['threads', 'list', '--agent', 'coder']);
  assert.equal(listed.code, 0, listed.stderr);
  assert.match(listed.stdout, /wt-1\s+\[idle\|executing\]/);
  assert.match(listed.stdout, /"工单025"/);

  const shown = await runCli(fake.port, ['threads', 'show', 'wt-1']);
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, /lifeState: executing/);
  assert.match(shown.stdout, /failed: false/);

  const sent = await runCli(fake.port, ['threads', 'send', 'wt-1', '--text', 'X'.repeat(5000)]);
  assert.equal(sent.code, 0, sent.stderr);
  assert.match(sent.stdout, /sent cmd-1\s+kind=user_message\s+duplicate=false\s+delivered=true/);
  assert.ok(!sent.stdout.includes('X'.repeat(100)), 'text 输出不得回显工单全文');
});

test('threads watch settles on turn.completed and reports timeout via exit code', async () => {
  const fake = await startFakeClawServer();

  const settled = await runCli(fake.port, [
    'threads', 'watch', 'wt-watch', '--interval', '0.3', '--timeout', '5',
  ]);
  assert.equal(settled.code, 0, settled.stderr);
  assert.match(settled.stdout, /event: turn\.completed turn=1/);
  assert.match(settled.stdout, /watch done: turn\.completed \| life=idle failed=false/);

  const timedOut = await runCli(fake.port, [
    'threads', 'watch', 'wt-stuck', '--interval', '0.3', '--timeout', '1',
  ]);
  assert.equal(timedOut.code, 2, timedOut.stderr);
  assert.match(timedOut.stdout, /watch done: timeout \| life=executing failed=false/);
});
