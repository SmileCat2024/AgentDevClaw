/**
 * PH 项目配置：真实共享进程的逐实例隔离（ticket 043）
 *
 * 夹具 test/fixtures/ph-project-config —— BasicAgent 哑装配 + 真实
 * assemblePhFeatureConfig（prebuilt-agents/official/programming-helper/agent.js
 * 的导出实现：真实层文件读取 + $mount 提取 + 累加折叠 + merge）。
 *
 * 证明链：一个 run-prebuilt-agent 进程内，目录会话（D）与同路径两个项目
 * （A/B）各自的 Session Agent 实例构造期读到的配置互不渗透——projectId
 * 逐实例注入（宿主读 Session 索引），项目实例不进目录层、目录实例不进项目层，
 * global/agent 继承两侧共享。无真实模型请求（llm 即抛错）。
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

const DATA_ROOT = mkdtempSync(join(tmpdir(), 'claw-ph-project-config-runtime-'));
process.env.AGENTDEV_DATA_DIR = DATA_ROOT;
const EXTERNAL_ROOTS = [];
function makeExternalDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  EXTERNAL_ROOTS.push(dir);
  return dir;
}

// 先设 env 再 import：层路径常量与项目表在 import 时解析数据根
const { createPhProject } = await import('../server/routes/ph-projects.js');
const {
  GLOBAL_LAYER_PATH,
  agentLayerPath,
  dirLayerPath,
  projectLayerPath,
} = await import('../server/shared/feature-config-layers.js');

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

test('real shared runtime: D / A / B sessions assemble isolated configs in one process', async () => {
  const dirD = makeExternalDir('claw-ph-fc-rt-dirD-');
  const projectA = await createPhProject({ name: 'A', workDirectory: dirD });
  const projectB = await createPhProject({ name: 'B', workDirectory: dirD });

  // 层内容：global/agent 两侧共享继承；dir 与 project 各给互异的 probe 值
  writeLayer(GLOBAL_LAYER_PATH, { probe: { value: 'g-v' }, skill: { extraDirs: ['/global-skills'] } });
  writeLayer(agentLayerPath('programming-helper'), { probe: { value: 'a-v' } });
  writeLayer(dirLayerPath(dirD, 'programming-helper'), { probe: { value: 'd-v' } });
  writeLayer(projectLayerPath(projectA.id, 'programming-helper'), { probe: { value: 'pa-v' }, skill: { extraDirs: ['/a-skills'] } });
  writeLayer(projectLayerPath(projectB.id, 'programming-helper'), { probe: { value: 'pb-v' } });

  const agentId = 'ph-project-config-fixture';
  const sessionsDir = join(DATA_ROOT, 'prebuilt-sessions', agentId);
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(join(sessionsDir, 'index.json'), JSON.stringify({ sessions: [
    { id: 'dirsession', workspaceAgentId: 'main' },
    { id: 'sessionA', workspaceAgentId: 'main', projectId: projectA.id },
    { id: 'sessionB', workspaceAgentId: 'main', projectId: projectB.id },
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
      ? `\\\\.\\pipe\\claw-ph-fc-rt-${Date.now()}`
      : join(DATA_ROOT, 'viewer.sock'),
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

    runtime = fork('scripts/run-prebuilt-agent.js', ['test/fixtures/ph-project-config', agentId, 'Probe', 'sessionA'], { env, silent: true });
    runtime.stdout.on('data', (chunk) => { output += String(chunk); });
    runtime.stderr.on('data', (chunk) => { output += String(chunk); });

    // 实例 1：项目 A（CLI 首会话）——只进 project 层，不读同路径目录层
    const probeA = await waitMessage(runtime, (msg) => msg.type === 'config-probe' && msg.sessionId === 'sessionA');
    assert.equal(probeA.projectId, projectA.id);
    assert.deepEqual(probeA.layerIds, ['global', 'agent', 'project', 'session']);
    assert.equal(probeA.probe, 'pa-v');
    assert.deepEqual(probeA.extraDirs, ['/global-skills', '/a-skills']);

    // 实例 2：目录会话（同进程 add-session）——只进目录层，项目层文件存在也不读
    const probeDir = waitMessage(runtime, (msg) => msg.type === 'config-probe' && msg.sessionId === 'dirsession');
    runtime.send({ type: 'add-session', sessionId: 'dirsession' });
    const dirResult = await probeDir;
    assert.equal(dirResult.projectId, null);
    assert.deepEqual(dirResult.layerIds, ['global', 'agent', 'dir', 'session']);
    assert.equal(dirResult.probe, 'd-v');
    assert.deepEqual(dirResult.extraDirs, ['/global-skills']);

    // 实例 3：项目 B（同进程 add-session）——与 A 同路径互不影响
    const probeB = waitMessage(runtime, (msg) => msg.type === 'config-probe' && msg.sessionId === 'sessionB');
    runtime.send({ type: 'add-session', sessionId: 'sessionB' });
    const bResult = await probeB;
    assert.equal(bResult.projectId, projectB.id);
    assert.deepEqual(bResult.layerIds, ['global', 'agent', 'project', 'session']);
    assert.equal(bResult.probe, 'pb-v');
    assert.deepEqual(bResult.extraDirs, ['/global-skills']);
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
