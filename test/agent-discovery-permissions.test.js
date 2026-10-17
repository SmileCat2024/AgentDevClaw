/**
 * Tests for agent-discovery.js 的 metadata 权限声明投影（ADR-0030）：
 * - permissions 规范化（既有）与 permissionDefaults 解析投影（新增）
 * - 非法声明在启动扫描（discoverAgents）时报错，与 permissions 同等级
 *
 * Uses node:test format per project convention (test/*.test.js).
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createAgentDiscoveryModule } from '../server/routes/agent-discovery.js';

const ROOT = mkdtempSync(path.join(tmpdir(), 'claw-discovery-perm-test-'));
const mod = createAgentDiscoveryModule({ sessionApi: {} });

// 每用例独立扫描根：discoverAgents 递归解析所有 metadata.json，共享根会让
// 前序用例的非法声明污染后续断言（报错消息被先触发的用例抢走）。
async function writeAgent(caseName, agentName, metadata) {
  const dir = path.join(ROOT, caseName, agentName);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'metadata.json'), JSON.stringify(metadata), 'utf8');
  return path.join(ROOT, caseName);
}

after(async () => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe('discoverAgents: permission declaration projection', () => {
  it('projects declared permissions and author defaults', async () => {
    const root = await writeAgent('ok', 'ok-agent', {
      id: 'ok-agent',
      permissions: ['notifications.finish', 'notifications.input'],
      permissionDefaults: { 'notifications.finish': true, 'notifications.input': true },
    });
    const agents = await mod.discoverAgents(root);
    const agent = agents.find((a) => a.id === 'ok-agent');
    assert.ok(agent);
    assert.deepEqual(agent.permissions, ['notifications.finish', 'notifications.input']);
    assert.deepEqual(agent.permissionDefaults, {
      'notifications.finish': true,
      'notifications.input': true,
    });
  });

  it('defaults missing permissionDefaults to an empty object', async () => {
    const root = await writeAgent('bare', 'bare-agent', { id: 'bare-agent' });
    const agents = await mod.discoverAgents(root);
    const agent = agents.find((a) => a.id === 'bare-agent');
    assert.ok(agent);
    assert.deepEqual(agent.permissions, []);
    assert.deepEqual(agent.permissionDefaults, {});
  });

  it('rejects permissionDefaults keys outside the declared permission set', async () => {
    const root = await writeAgent('undeclared', 'undeclared-agent', {
      id: 'undeclared-agent',
      permissions: ['notifications.finish'],
      permissionDefaults: { 'notifications.input': true },
    });
    await assert.rejects(() => mod.discoverAgents(root), /未声明的权限项/);
  });

  it('rejects permissionDefaults values that fail the item validate', async () => {
    const root = await writeAgent('invalid-value', 'invalid-value-agent', {
      id: 'invalid-value-agent',
      permissions: ['notifications.finish'],
      permissionDefaults: { 'notifications.finish': 'yes' },
    });
    await assert.rejects(() => mod.discoverAgents(root), /值非法/);
  });

  it('still rejects unknown permission ids in declarations', async () => {
    const root = await writeAgent('unknown-id', 'unknown-id-agent', {
      id: 'unknown-id-agent',
      permissions: ['time.travel'],
    });
    await assert.rejects(() => mod.discoverAgents(root), /未知权限项/);
  });
});
