/**
 * plain agent runner 守卫集成测试（scripts/run-plain-agent.js）
 *
 * runner 是 560+ 行装配枢纽，此前零测试覆盖（第四轮审计 L7）。本文件用
 * 子进程 + AGENTDEV_DATA_DIR 隔离数据目录直接 spawn runner，锁定启动
 * 守卫语义：agent 不存在、--config-group 拼写守卫、注册表接线。
 * 守卫都在模型解析 / LLM 调用之前触发，无网络依赖。
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = join(REPO_ROOT, 'scripts', 'run-plain-agent.js');
const DATA_ROOT = mkdtempSync(join(tmpdir(), 'claw-plain-runner-'));
process.env.AGENTDEV_DATA_DIR = DATA_ROOT;

// 直接写注册表文件（与 agent-registry.js 的落盘格式同构）
const FAKE_AGENT_DIR = join(DATA_ROOT, 'fake-agents', 'plain-guard-agent');
mkdirSync(FAKE_AGENT_DIR, { recursive: true });
const metadataPath = join(FAKE_AGENT_DIR, 'metadata.json');
writeFileSync(metadataPath, JSON.stringify({
  id: 'plain-guard-agent',
  entry: 'agent.js',
  deployment: { kind: 'standalone' },
  features: [],
}), 'utf8');
writeFileSync(join(FAKE_AGENT_DIR, 'agent.js'), 'export default class {};\n', 'utf8');
const registryPath = join(DATA_ROOT, 'agent-registry.json');
writeFileSync(registryPath, JSON.stringify({
  schemaVersion: 1,
  agents: [{ id: 'plain-guard-agent', projectDir: FAKE_AGENT_DIR, metadataPath, registeredAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
}, null, 2), 'utf8');

function spawnRun(extraArgs = [], extraEnv = {}) {
  return spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'run-plain-agent.js'), 'plain-guard-agent', '--goal', 'x', '--headless', ...extraArgs], {
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, AGENTDEV_DATA_DIR: DATA_ROOT, PROTOCLAW_HEADLESS: '1' },
  });
}

function expectExit1With(runs, pattern, message) {
  assert.equal(runs.status, 1, `${message}: 应非零退出，实际 status=${runs.status} stderr=${runs.stderr}`);
  assert.match(runs.stderr, pattern);
}

after(() => {
  rmSync(DATA_ROOT, { recursive: true, force: true });
});

describe('plain agent runner 守卫（spawn 集成）', () => {
  test('未注册 Agent：fatal 报错 + exit 1', () => {
    const runs = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'run-plain-agent.js'), 'no-such-agent', '--goal', 'g', '--headless'], {
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, AGENTDEV_DATA_DIR: DATA_ROOT, PROTOCLAW_HEADLESS: '1' },
    });
    assert.equal(runs.status, 1);
    assert.match(runs.stderr, /未找到独立 Agent/);
  });

  test('--config-group 组不存在：拼写守卫报错退出，不静默回退', () => {
    const runs = spawnRun(['--config-group', 'no-such-group']);
    assert.equal(runs.status, 1);
    assert.match(runs.stderr, /配置组不存在/u);
    assert.match(runs.stderr, /claw config-groups/u); // 附可用组列表指引
  });

  test('--debug 不带 Studio 关联：报错退出，不进入执行', () => {
    const runs = spawnRun(['--debug']);
    assert.equal(runs.status, 1);
    assert.match(runs.stderr, /--debug/u);
  });
});
