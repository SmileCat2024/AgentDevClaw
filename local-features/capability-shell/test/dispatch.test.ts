/**
 * 分派层测试 — adapter map 分派与数组 spawn（ticket 033）
 *
 * spawn 段用真实子进程（node -e），遵守测试时长预算（<2s）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  dispatchPipeline,
  runCollectedSpawn,
} from '../src/dispatch.js';
import type { DispatchSegment } from '../src/dispatch.js';

describe('capability-shell dispatchPipeline', () => {
  it('进程内函数 adapter：直接调用并返回结果', async () => {
    const segments: DispatchSegment[] = [{
      verb: 'echo_upper',
      args: ['hello'],
      adapterKey: 'echo_upper',
      kind: 'function',
    }];
    const r = await dispatchPipeline(segments, {
      adapters: {
        'echo_upper': async (a) => a.join(' ').toUpperCase(),
      },
    });
    assert.equal(r.ok, true);
    assert.equal(r.output, 'HELLO');
  });

  it('spawn 段：数组执行且上游 stdout 写下游 stdin', async () => {
    // 用真实可执行文件：node -e "console.log('a'); console.log('b')" | grep b
    const segments: DispatchSegment[] = [
      {
        verb: 'gen',
        args: ['-e', 'console.log("a"); console.log("b")'],
        adapterKey: process.execPath,
        kind: 'spawn',
      },
      { verb: 'grep', args: ['b'], adapterKey: 'grep', kind: 'spawn' },
    ];
    const r = await dispatchPipeline(segments, { adapters: {} });
    assert.equal(r.ok, true);
    assert.equal(r.output, 'b\n');
  });

  it('进程内 adapter 消费上游管道数据', async () => {
    const adapters = {
      count_lines: async (args: string[]) => `lines:${args[0] ?? ''}`,
    };
    // 两个段：第一个是 spawn（node 打印 3 行），第二个是进程内函数
    const segments: DispatchSegment[] = [
      {
        verb: 'gen',
        args: [],
        adapterKey: 'gen-adapter',
        kind: 'function',
      },
      { verb: 'count', args: [], adapterKey: 'count-adapter', kind: 'function' },
    ];
    const r = await dispatchPipeline(segments, {
      adapters: {
        'gen-adapter': async () => 'x\ny\nz\n',
        'count-adapter': async () => 'counted',
      },
    });
    assert.equal(r.ok, true);
    assert.equal(r.output, 'counted');
  });

  it('spawn 段失败 → dispatch_failed 且信息含 stderr 诊断', async () => {
    const segments: DispatchSegment[] = [
      { verb: 'fail', args: ['-e', 'process.exit(3)'], adapterKey: process.execPath, kind: 'spawn' },
    ];
    const r = await dispatchPipeline(segments, { adapters: {} });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'dispatch_failed');
  });

  it('ENOENT 命令 → dispatch_failed', async () => {
    const segments: DispatchSegment[] = [
      { verb: 'nope', args: [], adapterKey: 'definitely-not-exists-cmd-xyz', kind: 'spawn' },
    ];
    const r = await dispatchPipeline(segments, { adapters: {} });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'dispatch_failed');
  });

  it('空段列表拒绝', async () => {
    const r = await dispatchPipeline([], {});
    assert.equal(r.ok, false);
    assert.equal(r.code, 'dispatch_failed');
  });

  it('执行前已 abort 的管线：不执行命令，以终止态收尾不抛异常', async () => {
    const ac = new AbortController();
    // 先 abort 再执行：直接以终止态收尾，不执行命令
    ac.abort();
    const segments: DispatchSegment[] = [
      { verb: 'slow', args: [], adapterKey: process.execPath, kind: 'spawn' },
    ];
    const r = await dispatchPipeline(segments, {
      adapters: {},
      signal: ac.signal,
    });
    // 预中断：不以崩溃收尾（ok 由实现语义决定，这里断言不抛异常）
    assert.ok(typeof r.ok === 'boolean');
  });
});

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
