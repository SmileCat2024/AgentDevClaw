/**
 * 分派层测试 — adapter map 分派与数组 spawn（ticket 033）
 *
 * spawn 段用真实子进程（node -e），遵守测试时长预算（<2s）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runCollectedSpawn } from '../src/dispatch.js';

describe('capability-shell runCollectedSpawn', () => {
  it('collect stdout 与退出码', async () => {
    const r = await runCollectedSpawn(
      process.execPath,
      ['-e', 'console.log("hello")'],
      {},
    );
    assert.equal(r.ok, true);
    assert.equal(r.stdout, 'hello\n');
    assert.equal(r.exitCode, 0);
  });

  it('非 0 退出 → ok:false 不 throw', async () => {
    const r = await runCollectedSpawn(
      process.execPath,
      ['-e', 'console.error("boom"); process.exit(3)'],
      {},
    );
    assert.equal(r.ok, false);
    assert.equal(r.exitCode, 3);
    assert.ok(r.stderr.includes('boom'));
  });

  it('stdin 输入传递', async () => {
    const r = await runCollectedSpawn(
      process.execPath,
      ['-e', 'let d=""; process.stdin.on("data",c=>d+=c); process.stdin.on("end",()=>console.log("got:"+d.trim()))'],
      { input: 'pipe-data' },
    );
    assert.equal(r.ok, true);
    assert.equal(r.stdout, 'got:pipe-data\n');
  });

  it('执行前已 abort：不执行命令直接终止态返回', async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await runCollectedSpawn(process.execPath, ['-e', 'console.log("x")'], {
      signal: ac.signal,
    });
    assert.equal(r.terminated, true);
    assert.equal(r.stdout, '');
  });

  it('慢命令（>SPAWN_KILL_FALLBACK_MS）无 abort：正常等待 close，不被兜底计时误杀（ticket 036）', async () => {
    const r = await runCollectedSpawn(
      process.execPath,
      ['-e', 'setTimeout(()=>console.log("done"), 1500)'],
      {},
    );
    assert.equal(r.ok, true);
    assert.equal(r.terminated, undefined);
    assert.equal(r.stdout, 'done\n');
    assert.equal(r.exitCode, 0);
  });

  it('执行中 abort → kill 并收集部分输出（ADR-0005 中断即结果）', async () => {
    const ac = new AbortController();
    // 子进程：先输出一行，然后每 50ms 持续输出
    const childPromise = runCollectedSpawn(
      process.execPath,
      ['-e', 'console.log("first"); setInterval(()=>console.log("tick"), 50)'],
      { signal: ac.signal },
    );
    // 等第一行输出
    await new Promise(r => setTimeout(r, 300));
    ac.abort();
    const result = await childPromise;
    assert.equal(result.terminated, true);
    assert.ok(result.stdout.includes('first'));
  });
});
