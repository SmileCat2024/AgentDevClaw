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
      permissionDefaults: { 'notifications.finish': 'auto', 'notifications.input': 'persistent' },
    });
    const agents = await mod.discoverAgents(root);
    const agent = agents.find((a) => a.id === 'ok-agent');
    assert.ok(agent);
    assert.deepEqual(agent.permissions, ['notifications.finish', 'notifications.input']);
    assert.deepEqual(agent.permissionDefaults, {
      'notifications.finish': 'auto',
      'notifications.input': 'persistent',
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
      permissionDefaults: { 'notifications.input': 'auto' },
    });
    await assert.rejects(() => mod.discoverAgents(root), /未声明的权限项/);
  });

  it('rejects permissionDefaults values that fail the item validate', async () => {
    // 通知项值域是三态模式（ADR-0030 修订）：'yes' 与退役布尔均非法
    for (const bad of ['yes', true, false]) {
      const root = await writeAgent(`invalid-value-${String(bad)}`, 'invalid-value-agent', {
        id: 'invalid-value-agent',
        permissions: ['notifications.finish'],
        permissionDefaults: { 'notifications.finish': bad },
      });
      await assert.rejects(() => mod.discoverAgents(root), /值非法/);
    }
  });

  it('still rejects unknown permission ids in declarations', async () => {
    const root = await writeAgent('unknown-id', 'unknown-id-agent', {
      id: 'unknown-id-agent',
      permissions: ['time.travel'],
    });
    await assert.rejects(() => mod.discoverAgents(root), /未知权限项/);
  });
});

// ── sidebarSessions 声明归一（ADR-0050）：增益 UX，非法不阻塞发现 ──

describe('discoverAgents: sidebarSessions declaration normalization', () => {
  it('projects declared visible / hidden and leaves undeclared as null', async () => {
    const root = await writeAgent('sessions-ok', 'sessions-ok-agent', { id: 'sessions-ok-agent', sidebarSessions: 'visible' });
    const hiddenRoot = await writeAgent('sessions-hidden', 'sessions-hidden-agent', { id: 'sessions-hidden-agent', sidebarSessions: 'hidden' });
    const bareRoot = await writeAgent('sessions-bare', 'sessions-bare-agent', { id: 'sessions-bare-agent' });
    assert.equal((await mod.discoverAgents(root)).find((a) => a.id === 'sessions-ok-agent').sidebarSessions, 'visible');
    assert.equal((await mod.discoverAgents(hiddenRoot)).find((a) => a.id === 'sessions-hidden-agent').sidebarSessions, 'hidden');
    assert.equal((await mod.discoverAgents(bareRoot)).find((a) => a.id === 'sessions-bare-agent').sidebarSessions, null,
      'undeclared → null (consumers treat null as "capability absent")');
  });

  it('drops invalid declarations to null without blocking discovery', async () => {
    const root = await writeAgent('sessions-bad', 'sessions-bad-agent', { id: 'sessions-bad-agent', sidebarSessions: 'sometimes' });
    const agents = await mod.discoverAgents(root);
    const agent = agents.find((a) => a.id === 'sessions-bad-agent');
    assert.ok(agent, 'invalid declaration must not block the whole agent discovery');
    assert.equal(agent.sidebarSessions, null, 'invalid value is dropped to null, never passed through as-is');
  });
});
