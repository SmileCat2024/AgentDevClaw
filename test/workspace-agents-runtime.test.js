import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';

function waitMessage(child, predicate) {
  return new Promise((resolve, reject) => {
    const clean = () => { clearTimeout(timer); child.off('message', message); child.off('exit', exit); };
    const message = (value) => { if (predicate(value)) { clean(); resolve(value); } };
    const exit = (code) => { clean(); reject(new Error(`Runtime exited: ${code}`)); };
    const timer = setTimeout(() => { clean(); reject(new Error('Runtime evidence missing')); }, 2000);
    child.on('message', message); child.on('exit', exit);
  });
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  await exited;
}

test('real shared runtime loads two Session-bound assemblies independently and rejects an unknown Agent', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claw-agent-runtime-'));
  const reserve = net.createServer();
  reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  const agentId = 'workspace-agents-fixture';
  const sessions = path.join(root, 'prebuilt-sessions', agentId);
  await mkdir(sessions, { recursive: true });
  await writeFile(path.join(sessions, 'index.json'), JSON.stringify({ sessions: [
    { id: 'first', workspaceAgentId: 'main' }, { id: 'second', workspaceAgentId: 'reviewer' },
    { id: 'bad', workspaceAgentId: 'missing' },
  ] }));
  const env = { ...process.env, AGENTDEV_DATA_DIR: root, AGENTDEV_PORT: String(port), AGENTDEV_VIEWER_PORT: String(port), AGENTDEV_OPEN_BROWSER: 'false',
    AGENTDEV_UDS_PATH: process.platform === 'win32' ? `\\\\.\\pipe\\claw-agent-test-${Date.now()}` : path.join(root, 'viewer.sock') };
  let viewer, runtime;
  let output = '';
  try {
    viewer = spawn(process.execPath, ['node_modules/@agentdevjs/viewer/dist/cli/viewer.js'], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { clean(); reject(new Error('Viewer did not start')); }, 2000);
      const data = (chunk) => { output += String(chunk); if (/listening|running|启动|started/i.test(output)) { clean(); resolve(); } };
      const clean = () => { clearTimeout(timer); viewer.stdout.off('data', data); viewer.stderr.off('data', data); };
      viewer.stdout.on('data', data); viewer.stderr.on('data', data);
    });
    runtime = fork('scripts/run-prebuilt-agent.js', ['test/fixtures/workspace-agents', agentId, 'Fixture', 'first'], { env, silent: true });
    runtime.stdout.on('data', (chunk) => { output += String(chunk); });
    runtime.stderr.on('data', (chunk) => { output += String(chunk); });
    const first = await waitMessage(runtime, (msg) => msg.type === 'assembly-probe');
    assert.deepEqual([first.assembly, first.sessionId, first.name], ['main', 'first', 'Main helper']);
    const secondProbe = waitMessage(runtime, (msg) => msg.type === 'assembly-probe' && msg.sessionId === 'second');
    const secondReady = waitMessage(runtime, (msg) => msg.type === 'session-ready' && msg.sessionId === 'second');
    runtime.send({ type: 'add-session', sessionId: 'second' });
    const second = await secondProbe;
    assert.deepEqual([second.assembly, second.name], ['reviewer', 'Review helper']);
    await secondReady;
    const bad = waitMessage(runtime, (msg) => msg.type === 'session-error' && msg.sessionId === 'bad');
    runtime.send({ type: 'add-session', sessionId: 'bad' });
    assert.match((await bad).error, /Unknown workspace Agent/);
    assert.equal(runtime.exitCode, null, 'invalid sibling must not stop valid sessions');
  } catch (error) {
    error.message += '\n' + output.slice(-2500);
    throw error;
  } finally {
    await stop(runtime); await stop(viewer);
    await rm(root, { recursive: true, force: true });
  }
});
