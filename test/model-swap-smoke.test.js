/**
 * 模型热切换端到端冒烟测试（真实 runtime 子进程）。
 *
 * spawn 真实 ViewerWorker + fork run-prebuilt-agent.js（BasicAgent 系 fixture），
 * 经 IPC 驱动 swap-model，断言回执语义与进程存活。这是 2026-08 闪退事故的
 * 回归防线：BasicAgent 白名单重组曾丢弃 modelResolver，setModel 抛错在 IPC
 * handler 内变成 uncaughtException 杀死 runtime，用户侧表现为"切一次模型
 * runtime 闪退 + session runtime not connected"。单元测试全部通过但无真实
 * 进程链路覆盖，本文件补的就是这条链。
 *
 * 环境隔离：随机 TCP 端口 + 随机 UDS pipe，不触碰 2026 端口与默认
 * \\.\pipe\agentdev-viewer（可能与正在运行的 Claw server 冲突）。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawn } from 'child_process';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';

import { PROJECT_ROOT, RUNTIME_SCRIPT } from '../server/shared/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWER_CLI = path.join(PROJECT_ROOT, 'node_modules', '@agentdevjs', 'viewer', 'dist', 'cli', 'viewer.js');
const FIXTURE_AGENT_DIR = path.join(__dirname, 'fixtures', 'model-swap-smoke-agent');

function getRandomPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function waitForTcp(port, timeoutMs = 8000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(); });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - start > timeoutMs) reject(new Error(`viewer worker not reachable on ${port}`));
        else setTimeout(attempt, 150);
      });
    };
    attempt();
  });
}

/** 等 runtime stdout 出现标记行（READY） */
function waitForStdout(child, marker, timeoutMs = 8000, acc = { text: '' }) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`runtime not ready, stdout tail:\n${acc.text.slice(-1500)}`)), timeoutMs);
    const onData = (chunk) => {
      acc.text += String(chunk);
      if (acc.text.includes(marker)) {
        clearTimeout(timer);
        child.stdout.removeListener('data', onData);
        resolve(acc.text);
      }
    };
    child.stdout.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`runtime exited before ready (code=${code}), stdout tail:\n${acc.text.slice(-1500)}`));
    });
  });
}

/** 发 swap-model IPC 并等待回执 */
function swapModel(child, presetName, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const requestId = `smoke-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const timer = setTimeout(() => {
      child.removeListener('message', onMessage);
      reject(new Error(`swap ack timeout for ${presetName}`));
    }, timeoutMs);
    const onMessage = (msg) => {
      if (msg?.type === 'model-swap-result' && msg.requestId === requestId) {
        clearTimeout(timer);
        child.removeListener('message', onMessage);
        resolve(msg);
      }
    };
    child.on('message', onMessage);
    child.send({ type: 'swap-model', presetName, requestId });
  });
}

describe('model hot-swap smoke (real runtime process)', () => {
  let viewerProc;
  let child;

  before(async () => {
    const port = await getRandomPort();
    const udsPath = `\\\\.\\pipe\\agentdev-smoke-${Date.now()}`;
    const sharedEnv = {
      ...process.env,
      AGENTDEV_PORT: String(port),
      AGENTDEV_VIEWER_PORT: String(port),
      AGENTDEV_UDS_PATH: udsPath,
      AGENTDEV_OPEN_BROWSER: 'false',
    };

    viewerProc = spawn(process.execPath, [VIEWER_CLI], { env: sharedEnv, stdio: 'ignore', windowsHide: true });
    await waitForTcp(port);

    child = fork(RUNTIME_SCRIPT, [FIXTURE_AGENT_DIR, 'smoke-agent', 'Smoke', '__protoclaw-no-session__'], {
      cwd: PROJECT_ROOT,
      env: sharedEnv,
      silent: true,
    });
    await waitForStdout(child, '[ProtoClaw Runtime] READY session=');
  });

  after(async () => {
    child?.kill();
    viewerProc?.kill();
    // 给 OS 一点时间回收，避免句柄残留拖慢测试进程退出
    await new Promise((resolve) => setTimeout(resolve, 200));
  });

  it('swap-model to __default__ acks ok:true with meta and keeps the process alive', async () => {
    const ack = await swapModel(child, '__default__');

    assert.equal(ack.ok, true, `expected ok ack, got: ${JSON.stringify(ack)}`);
    assert.equal(ack.meta?.presetName, '__default__');
    assert.ok(ack.meta?.modelName, 'modelName should be non-empty');
    assert.equal(child.exitCode, null, 'runtime process must stay alive after a successful swap');
  });

  it('swap-model to unknown preset acks ok:false (failure reachable, no crash)', async () => {
    const ack = await swapModel(child, '__definitely_not_a_preset__');

    assert.equal(ack.ok, false, 'unknown preset must produce a failure ack');
    assert.ok(ack.error, 'failure ack must carry an error reason');
    // 事故回归断言：修复前 uncaughtException 在这里杀死进程
    assert.equal(child.exitCode, null, 'runtime process must stay alive after a failed swap');
  });
});
