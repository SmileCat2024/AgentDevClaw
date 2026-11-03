/**
 * discoverAgents 名册缓存（短 TTL + in-flight 合并）回归：
 * - TTL 窗口内重复调用返回同一共享只读数组（盘上名册已变也不重扫）
 * - resetDiscoverAgentsCache 后立即反映盘上变更
 * - 扫描失败不缓存：修复名册后无需 reset 即可成功
 *
 * Uses node:test format per project convention (test/*.test.js).
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { discoverAgents, resetDiscoverAgentsCache } from '../server/routes/agent-discovery.js';

const ROOT = mkdtempSync(path.join(tmpdir(), 'claw-discovery-cache-test-'));

async function writeAgent(dirName, metadata) {
  const dir = path.join(ROOT, dirName);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'metadata.json'), JSON.stringify(metadata), 'utf8');
  return dir;
}

after(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe('discoverAgents roster cache', () => {
  it('serves a second call within the TTL from cache (no rescan)', async () => {
    resetDiscoverAgentsCache();
    await writeAgent('cached-agent', { id: 'cached-agent', name: 'Cached' });
    const first = await discoverAgents(ROOT);
    assert.equal(first.length, 1);

    // 盘上删除名册后立刻再查：TTL 内必须仍是缓存结果（证明没有重扫）。
    await rm(path.join(ROOT, 'cached-agent'), { recursive: true, force: true });
    const second = await discoverAgents(ROOT);
    assert.equal(second.length, 1, 'second call within TTL must come from cache');
    assert.equal(second, first, 'cached call must return the shared readonly array');
  });

  it('rescans after resetDiscoverAgentsCache', async () => {
    resetDiscoverAgentsCache();
    const rescan = await discoverAgents(ROOT);
    assert.equal(rescan.length, 0, 'deleted roster entry must disappear after cache reset');
  });

  it('does not cache scan failures', async () => {
    resetDiscoverAgentsCache();
    await writeAgent('broken-agent', { id: 'broken-agent', permissions: ['time.travel'] });
    await assert.rejects(() => discoverAgents(ROOT), /未知权限项/);

    // 修复名册后无需 reset：失败未被缓存，下一次调用重扫并成功。
    const dir = path.join(ROOT, 'broken-agent');
    await writeFile(path.join(dir, 'metadata.json'), JSON.stringify({ id: 'broken-agent' }), 'utf8');
    const agents = await discoverAgents(ROOT);
    assert.equal(agents.length, 1);
    assert.equal(agents[0].id, 'broken-agent');
  });
});
