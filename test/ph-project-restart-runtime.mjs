import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import express from 'express';
import { chromium } from 'playwright';
import { restartPage } from './helpers/ph-project-restart-page.js';

async function freePort() {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

// A real shared child process and Viewer: no model calls, real start/stop IPC,
// real session index, real restart HTTP route and connected-agents projection.
test('shared runtime restart preserves each sibling session and project ownership', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claw-ph-restart-'));
  const viewerPort = await freePort();
  const appPort = await freePort();
  Object.assign(process.env, {
    AGENTDEV_DATA_DIR: root, PORT: String(appPort), AGENTDEV_VIEWER_PORT: String(viewerPort),
    AGENTDEV_UDS_PATH: path.join(root, 'viewer.sock'),
  });
  const { createAgentLifecycleModule } = await import('../server/routes/agent-lifecycle.js');
  const { createAgentDiscoveryModule } = await import('../server/routes/agent-discovery.js');
  const { buildLightPrebuiltSessionRecord } = await import('../server/routes/session-helpers-pure.js');
  const { writeSessionIndex, readSessionIndex } = await import('../server/shared/session-access.js');
  const { managedAgents, isChildProcessRunning } = await import('../server/shared/agent-access.js');
  const projectId = 'prj_123456abcdef';
  const sessions = [
    { id: 'directory', title: '目录对话', openDirectory: root, workspaceAgentId: 'main' },
    { id: 'project', title: '项目对话', openDirectory: root, projectId, workspaceAgentId: 'reviewer' },
  ];
  await writeSessionIndex('programming-helper', { activeSessionId: 'directory', sessions });
  await mkdir(path.join(root, 'workspaces/programming-helper'), { recursive: true });
  await writeFile(path.join(root, 'workspaces/programming-helper/projects.json'), JSON.stringify({ schemaVersion: 1, projects: [
    { id: projectId, name: '测试项目', workDirectory: root, directorySource: 'external', archived: false },
  ] }));
  const agent = { id: 'programming-helper', name: '测试工作空间', kind: 'workspace', processMode: 'shared-global', relativeDir: 'test/fixtures/restart-user-input', status: {} };
  const discovery = createAgentDiscoveryModule({ sessionApi: {
    listPrebuiltSessions: async () => {
      const index = await readSessionIndex(agent.id);
      return { ...index, sessions: index.sessions.map(s => buildLightPrebuiltSessionRecord(agent.id, s)) };
    },
  } });
  const readViewerJson = async url => {
    const res = await fetch(`http://127.0.0.1:${viewerPort}${url}`);
    assert.ok(res.ok, `Viewer request ${url}: ${res.status}`);
    return res.json();
  };
  const lifecycle = createAgentLifecycleModule({
    sessionApi: {}, getAgents: async () => [agent], getAgentsLight: async () => [agent],
    requireAgentLight: async id => { assert.equal(id, agent.id); return agent; },
    resolveRuntimeDisplayName: async () => 'Fixture',
    readActiveWorkspaceSessionMeta: discovery.readActiveWorkspaceSessionMeta,
    readWorkspaceSessionMeta: discovery.readWorkspaceSessionMeta,
    readViewerJson, getPendingInputCount: async () => 0, resolveAgentModelPresets: async () => [],
  });
  const app = express();
  app.use(express.static('public'));
  app.get('/api/agents', async (_req, res) => res.json(await readViewerJson('/api/agents')));
  app.get('/fixture', (_req, res) => res.type('html').send(restartPage({ projectId, root })));
  lifecycle.setupRoutes(app, express);
  const server = app.listen(appPort, '127.0.0.1');
  await once(server, 'listening');
  let output = '';
  const viewer = spawn(process.execPath, ['node_modules/@agentdevjs/viewer/dist/cli/viewer.js'], {
    env: { ...process.env, AGENTDEV_PORT: String(viewerPort), AGENTDEV_OPEN_BROWSER: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  async function post(route, body) {
    const response = await fetch(`http://127.0.0.1:${appPort}/protoclaw/${route}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const payload = await response.json();
    assert.ok(response.ok, JSON.stringify(payload));
    return payload;
  }
  function checkOwnership(agents) {
    const children = agents.filter(a => a.source === 'child');
    assert.equal(children.length, 2, '两条共享进程对话都必须可见');
    assert.equal(new Set(children.map(a => a.runtime_session_id)).size, 2, '各会话有独立 Viewer 身份');
    for (const session of sessions) {
      const child = children.find(a => a.active_workspace_session_id === session.id);
      assert.ok(child, `不能丢失 ${session.id} 对话`);
      assert.equal(child.project_id, session.projectId || '');
      assert.equal(child.open_directory, root);
    }
  }
  let browser;
  try {
    await new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); viewer.stdout.off('data', onData); viewer.stderr.off('data', onData); };
      const onData = chunk => { output += chunk; if (/listening|running|启动|started/i.test(output)) { cleanup(); resolve(); } };
      const timer = setTimeout(() => { cleanup(); reject(new Error('Viewer startup missing: ' + output)); }, 2000);
      viewer.stdout.on('data', onData); viewer.stderr.on('data', onData);
    });
    const first = await post('start_agent', { agentId: agent.id, sessionId: 'project' });
    assert.equal(first.agent?.project_id, projectId);
    const second = await post('start_agent', { agentId: agent.id, sessionId: 'directory' });
    assert.ok(second.agent?.runtime_session_id);
    checkOwnership(await lifecycle.getConnectedAgents());
    const readyResponse = await fetch(`http://127.0.0.1:${appPort}/protoclaw/runtime_status?agentId=programming-helper&sessionId=project`);
    const ready = await readyResponse.json();
    assert.equal(ready.ready, true);
    assert.equal(ready.agent.project_id, projectId, '就绪探测不能把项目身份洗成目录对话');
    assert.equal(ready.agent.open_directory, root);
    const oldProject = first.agent.runtime_session_id;
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${appPort}/fixture`);
    await page.waitForSelector('body[data-ready="true"]');
    const projectGroup = page.locator(`[data-project-key="prj:${projectId}"]`);
    assert.equal(await projectGroup.locator(`[data-agent-id="${oldProject}"]`).count(), 1);
    await projectGroup.locator('.agent-runtime-item').click();
    const response = page.waitForResponse(r => r.url().endsWith('/protoclaw/restart_agent') && r.request().method() === 'POST');
    await page.locator('#restart').click();
    const restarted = await (await response).json();
    await page.waitForSelector('body[data-restarted="true"]');
    assert.equal(restarted.agent?.project_id, projectId);
    assert.notEqual(restarted.agent?.runtime_session_id, oldProject);
    assert.equal(await projectGroup.locator(`[data-agent-id="${restarted.agent.runtime_session_id}"]`).count(), 1, '点击重启后新 runtime 必须仍在项目组');
    assert.equal(await page.locator(`[data-agent-id="${oldProject}"]`).count(), 0);
    assert.deepEqual(errors, []);
    checkOwnership(await lifecycle.getConnectedAgents());
    // Cross the former 500ms lease-abort retry boundary; the old loop must not
    // close the replacement instance with the same persistent Session ID.
    await new Promise(resolve => setTimeout(resolve, 500));
    checkOwnership(await lifecycle.getConnectedAgents());
    for (const runtimeId of [restarted.agent.runtime_session_id, second.agent.runtime_session_id]) {
      const leases = await readViewerJson(`/api/agents/${runtimeId}/input-requests`);
      assert.ok(Array.isArray(leases) && leases.length > 0, '新实例和兄弟会话仍能接收用户输入');
    }
    await page.reload();
    await page.waitForSelector('body[data-ready="true"]');
    assert.equal(await projectGroup.locator(`[data-agent-id="${restarted.agent.runtime_session_id}"]`).count(), 1, '刷新前后分组一致');
    const index = await readSessionIndex(agent.id);
    assert.equal(index.sessions.find(s => s.id === 'project').projectId, projectId);
  } finally {
    await browser?.close();
    const children = [...new Set([...managedAgents.values()].map(rt => rt.process))];
    for (const child of [...children, viewer]) {
      if (!isChildProcessRunning(child)) continue;
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
    managedAgents.clear();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
