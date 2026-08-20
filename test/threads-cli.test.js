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
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });

    let payload = { ok: true };
    if (req.url === '/protoclaw/threads?agentId=coder') {
      payload = { ok: true, threads: [{ threadId: 'wt-1', agentId: 'coder', status: 'idle', headSessionId: 's-1' }] };
    } else if (req.url === '/protoclaw/threads' && req.method === 'POST') {
      payload = { ok: true, thread: { threadId: 'wt-new', agentId: 'coder', status: 'idle', headSessionId: 's-1' } };
    } else if (req.url === '/protoclaw/threads/wt-1/events?after=2') {
      payload = { ok: true, events: [{ type: 'turn.completed', turn: 1 }], cursor: 3 };
    } else if (req.url === '/protoclaw/threads/wt-1/commands') {
      payload = { ok: true, command: { commandId: 'cmd-1', status: 'pending' }, duplicate: false };
    } else if (req.url === '/protoclaw/threads/wt-1/head') {
      payload = { ok: true, thread: { threadId: 'wt-1', status: 'idle', headSessionId: 's-2' } };
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
    threadId: 'wt-1', agentId: 'coder', status: 'idle', headSessionId: 's-1',
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

test('claw threads validates required options without contacting the server', async () => {
  const result = await runCli('1', ['threads', 'create', '--agent', 'coder']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /缺少 --session 参数/);

  const invalidRevision = await runCli('1', [
    'threads', 'advance', 'wt-1', '--to-session', 's-2', '--expected-revision', 'not-a-number',
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
