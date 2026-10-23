/**
 * PH 会话归属转移：真实共享 runtime 的逐实例重装配（sessions_move）
 *
 * 夹具 test/fixtures/ph-project-config —— BasicAgent 哑装配 + 真实
 * assemblePhFeatureConfig（prebuilt-agents/official/programming-helper/agent.js
 * 的导出实现）。无真实模型请求（llm 即抛错）。
 *
 * 证明链（同一 run-prebuilt-agent 进程内，真实 IPC + 真实索引转移）：
 * 会话 S 在项目 A 装配（probe pa-v）→ remove-session（保存回执
 * persisted:true，兄弟会话保活进程）→ movePhSessions 真实改索引（A→B）→
 * add-session 重新构造实例 → 读到 B 项目层（pb-v）；再 B→目录，实例读目录
 * 层（d-v、无 projectId）。全程兄弟会话（项目 A）不受波及，末尾 remove +
 * add 复检仍是 A 配置——所有权来源（索引 projectId）逐实例注入，无进程级
 * 缓存，转移后重装配即生效。
 *
 * 全程隔离数据根（AGENTDEV_DATA_DIR 先于 import 设置）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';

const DATA_ROOT = mkdtempSync(join(tmpdir(), 'claw-ph-session-move-rt-'));
process.env.AGENTDEV_DATA_DIR = DATA_ROOT;
const EXTERNAL_ROOTS = [];
function makeExternalDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  EXTERNAL_ROOTS.push(dir);
  return dir;
}

// 先设 env 再 import：层路径常量与项目表在 import 时解析数据根
const { createPhProject, movePhSessions } = await import('../server/routes/ph-projects.js');
const {
  GLOBAL_LAYER_PATH,
  agentLayerPath,
  dirLayerPath,
  projectLayerPath,
} = await import('../server/shared/feature-config-layers.js');
const {
  readSessionIndex: readSessionIndexShared,
  updateSessionIndex: updateSessionIndexShared,
} = await import('../server/shared/session-access.js');

function writeLayer(filePath, content) {
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, JSON.stringify(content, null, 2), 'utf8');
}

function waitMessage(child, predicate) {
  return new Promise((resolve, reject) => {
    const clean = () => { clearTimeout(timer); child.off('message', message); child.off('exit', exit); };
    const message = (value) => { if (predicate(value)) { clean(); resolve(value); } };
    const exit = (code) => { clean(); reject(new Error(`Runtime exited: ${code}`)); };
    const timer = setTimeout(() => { clean(); reject(new Error('Runtime evidence missing')); }, 5000);
    child.on('message', message); child.on('exit', exit);
  });
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  await exited;
}

test('real shared runtime: move A→B→dir reassembles target config per instance, sibling untouched', async () => {
  const dirD = makeExternalDir('claw-ph-mv-rt-dirD-');
  const projectA = await createPhProject({ name: 'A', workDirectory: dirD });
  const projectB = await createPhProject({ name: 'B', workDirectory: dirD });

  writeLayer(GLOBAL_LAYER_PATH, { probe: { value: 'g-v' }, skill: { extraDirs: ['/global-skills'] } });
  writeLayer(agentLayerPath('programming-helper'), { probe: { value: 'a-v' } });
  writeLayer(dirLayerPath(dirD, 'programming-helper'), { probe: { value: 'd-v' } });
  writeLayer(projectLayerPath(projectA.id, 'programming-helper'), { probe: { value: 'pa-v' } });
  writeLayer(projectLayerPath(projectB.id, 'programming-helper'), { probe: { value: 'pb-v' } });

  const agentId = 'ph-project-config-fixture';
  const sessionsDir = join(DATA_ROOT, 'prebuilt-sessions', agentId);
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(join(sessionsDir, 'index.json'), JSON.stringify({ sessions: [
    { id: 'sessionS', workspaceAgentId: 'main', projectId: projectA.id },
    { id: 'sessionSibling', workspaceAgentId: 'main', projectId: projectA.id },
  ] }), 'utf8');

  const reserve = net.createServer();
  reserve.listen(0, '127.0.0.1');
  await once(reserve, 'listening');
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));

  const env = {
    ...process.env,
    AGENTDEV_DATA_DIR: DATA_ROOT,
    AGENTDEV_PORT: String(port),
    AGENTDEV_VIEWER_PORT: String(port),
    AGENTDEV_OPEN_BROWSER: 'false',
    FIXTURE_DIR_D: dirD,
    AGENTDEV_UDS_PATH: process.platform === 'win32'
      ? `\\\\.\\pipe\\claw-ph-mv-rt-${Date.now()}`
      : join(DATA_ROOT, 'viewer.sock'),
  };

  // movePhSessions 生命周期假件：本测试的 runtime 不进 server 托管注册表，
  // 转移时无存活实例需释放（对应生产「先释放再转移」的窗口后半段）。
  // 索引读写经注入重定向到夹具 agent 命名空间，但走真实 session-access
  // 实现（锁 / 内容签名 / revision）；项目表落盘路径真实。
  const fixtureAgentId = 'ph-project-config-fixture';
  const idleMoveDeps = {
    getAgentRuntime: () => undefined,
    isManagedRuntimeRunning: () => false,
    stopManagedAgent: async () => {},
    readViewerJson: async () => { throw new Error('no live runtime expected in move deps'); },
    readSessionIndex: () => readSessionIndexShared(fixtureAgentId),
    updateSessionIndex: (agentId, fn) => updateSessionIndexShared(fixtureAgentId, fn),
  };

  let viewer;
  let runtime;
  let output = '';
  try {
    viewer = spawn(process.execPath, ['node_modules/@agentdevjs/viewer/dist/cli/viewer.js'], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { clean(); reject(new Error('Viewer did not start')); }, 5000);
      const data = (chunk) => { output += String(chunk); if (/listening|running|启动|started/i.test(output)) { clean(); resolve(); } };
      const clean = () => { clearTimeout(timer); viewer.stdout.off('data', data); viewer.stderr.off('data', data); };
      viewer.stdout.on('data', data); viewer.stderr.on('data', data);
    });

    runtime = fork('scripts/run-prebuilt-agent.js', ['test/fixtures/ph-project-config', agentId, 'Probe', 'sessionS'], { env, silent: true });
    runtime.stdout.on('data', (chunk) => { output += String(chunk); });
    runtime.stderr.on('data', (chunk) => { output += String(chunk); });

    // 实例 1：S @ 项目 A（CLI 首会话）
    const probe1 = await waitMessage(runtime, (msg) => msg.type === 'config-probe' && msg.sessionId === 'sessionS');
    assert.equal(probe1.projectId, projectA.id);
    assert.equal(probe1.probe, 'pa-v');

    // 兄弟会话同进程装载（A）——后续 S 的转移不得波及
    const siblingReady = waitMessage(runtime, (msg) => msg.type === 'config-probe' && msg.sessionId === 'sessionSibling');
    runtime.send({ type: 'add-session', sessionId: 'sessionSibling' });
    const siblingProbe1 = await siblingReady;
    assert.equal(siblingProbe1.projectId, projectA.id);
    assert.equal(siblingProbe1.probe, 'pa-v');

    // remove-session S：保存回执 persisted:true（ADR-0026 保存屏障），兄弟保活进程
    runtime.send({ type: 'remove-session', sessionId: 'sessionS' });
    const exited1 = await waitMessage(runtime, (msg) => msg.type === 'session-exited' && msg.sessionId === 'sessionS');
    assert.equal(exited1.persisted, true);

    // 真实索引转移：A → B
    const movedToB = await movePhSessions(
      { sessionIds: ['sessionS'], target: { type: 'project', id: projectB.id } },
      idleMoveDeps,
    );
    assert.deepEqual(movedToB.movedSessionIds, ['sessionS']);

    // add-session S：新实例按新归属读 B 项目层
    const probe2 = waitMessage(runtime, (msg) => msg.type === 'config-probe' && msg.sessionId === 'sessionS');
    runtime.send({ type: 'add-session', sessionId: 'sessionS' });
    const probeB = await probe2;
    assert.equal(probeB.projectId, projectB.id);
    assert.equal(probeB.probe, 'pb-v');
    assert.deepEqual(probeB.layerIds, ['global', 'agent', 'project', 'session']);

    // B → 目录（默认归属）
    runtime.send({ type: 'remove-session', sessionId: 'sessionS' });
    await waitMessage(runtime, (msg) => msg.type === 'session-exited' && msg.sessionId === 'sessionS');
    const movedToDir = await movePhSessions(
      { sessionIds: ['sessionS'], target: { type: 'directory', openDirectory: dirD } },
      idleMoveDeps,
    );
    assert.deepEqual(movedToDir.movedSessionIds, ['sessionS']);

    const probe3 = waitMessage(runtime, (msg) => msg.type === 'config-probe' && msg.sessionId === 'sessionS');
    runtime.send({ type: 'add-session', sessionId: 'sessionS' });
    const probeDir = await probe3;
    assert.equal(probeDir.projectId, null);
    assert.equal(probeDir.probe, 'd-v');
    assert.deepEqual(probeDir.layerIds, ['global', 'agent', 'dir', 'session']);

    // 兄弟不受波及：remove + add 复检，仍按 A 项目层装配（进程内全程未被 S 的转移触碰）
    runtime.send({ type: 'remove-session', sessionId: 'sessionSibling' });
    await waitMessage(runtime, (msg) => msg.type === 'session-exited' && msg.sessionId === 'sessionSibling');
    const siblingProbe2 = waitMessage(runtime, (msg) => msg.type === 'config-probe' && msg.sessionId === 'sessionSibling');
    runtime.send({ type: 'add-session', sessionId: 'sessionSibling' });
    const siblingRecheck = await siblingProbe2;
    assert.equal(siblingRecheck.projectId, projectA.id);
    assert.equal(siblingRecheck.probe, 'pa-v');
  } catch (error) {
    error.message += '\n' + output.slice(-2500);
    throw error;
  } finally {
    await stop(runtime);
    await stop(viewer);
    rmSync(DATA_ROOT, { recursive: true, force: true });
    for (const dir of EXTERNAL_ROOTS) rmSync(dir, { recursive: true, force: true });
  }
});
