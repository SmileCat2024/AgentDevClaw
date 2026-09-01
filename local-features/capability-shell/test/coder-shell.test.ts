/**
 * coder 领域 shell 测试 — 动词表 + threads adapter（ticket 034）
 *
 * 覆盖工单验收要点：
 * - 8 个动词声明齐备，advance / resume 不入表且 unknown_verb 报文附结构化指引
 * - send 缺幂等键被参数校验道拒绝
 * - adapter 直调 /protoclaw/threads*（请求形态与参数参照 bin/claw.mjs）
 * - send 阻塞语义：轮询 events 直到落定；超时返回结构化 done reason=timeout（非错误）
 *
 * fetch / sleep 全部注入，无真实网络与真实 sleep（遵守测试时长预算）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCoderShellPolicy } from '../src/coder-policy.js';
import { createThreadsAdapters } from '../src/coder-shell.js';
import { runCapabilityShellPipeline, createCapabilityShellTool } from '../src/tool-factory.js';
import type { FetchLike } from '../src/coder-shell.js';

const POLICY = createCoderShellPolicy();

/** 可编程 fetch stub：按 URL 谓词匹配，返回预设 payload。 */
function stubFetch(routes: Array<{ match: (url: string, init?: RequestInit) => boolean; body: any }>): FetchLike {
  return async (url, init) => {
    const route = routes.find((r) => r.match(url, init));
    if (!route) {
      return { ok: false, status: 404, json: async () => ({ ok: false, error: `no route: ${url}` }) };
    }
    return { ok: true, status: 200, json: async () => route.body };
  };
}

/** 用 coder_shell 策略跑管线（bashPath null 降级，结构道兜底）。 */
function runCapabilityShellPolicy(command: string) {
  const policy = createCoderShellPolicy();
  return runCapabilityShellPipeline(policy, command, {
    adapters: {},
    bashPath: null,
  });
}

describe('coder_shell 动词表（ticket 034）', () => {
  it('v1 动词表恰为 8 个：create/send/watch/list/show/archive/unarchive/deliver', () => {
    assert.deepEqual(
      Object.keys(POLICY.verbs).sort(),
      ['archive', 'create', 'deliver', 'list', 'send', 'show', 'unarchive', 'watch'],
    );
  });

  it('advance / resume 不入动词表', () => {
    assert.ok(!('advance' in POLICY.verbs));
    assert.ok(!('resume' in POLICY.verbs));
  });

  it('send 幂等键必填：缺失在参数校验道拒绝', async () => {
    // 缺幂等键：只有 threadId + text 两个参数（期望 3 个）
    const result = await runCapabilityShellPipeline(POLICY, "send wt-1 'do work'", {
      adapters: {},
      bashPath: null,
    });
    assert.equal(result.ok, false);
    assert.equal(result.rejection?.code, 'arg_rejected');
    assert.equal(result.rejection.stage, 'args');
    assert.ok(result.output.includes('send'), result.output);
    assert.ok(result.output.includes('idempotencyKey'), '拒绝文案应含参数名');
  });

  it('越权动词（advance/resume/rm/curl）被拒绝且报文附结构化指引 / 动词清单', async () => {
    for (const verb of ['advance', 'resume', 'rm', 'curl']) {
      const r = await runCapabilityShellPipeline(POLICY, verb, {
        adapters: {},
        bashPath: null,
      });
      assert.equal(r.ok, false, `应拒绝: ${verb}`);
      assert.equal(r.rejection?.code, 'unknown_verb');
      assert.ok(r.output.includes('可用动词'), r.output);
      if (verb === 'advance' || verb === 'resume') {
        assert.ok(
          r.output.includes('人工介入'),
          `advance/resume 报文应附结构化指引: ${r.output}`,
        );
      }
    }
  });

  it('完整管线：send 阻塞到落定，输出含投递确认与落定摘要（mock fetch）', async () => {
    // 模拟 server：send → executing → events 带 turn.completed → idle 落定
    let threadPolls = 0;
    const adapters = createThreadsAdapters({
      serverOrigin: 'http://test',
      pollIntervalMs: 1,
      fetchImpl: (async (url: string) => {
        if (url.endsWith('/threads/wt-1/commands')) {
          return { ok: true, status: 201, json: async () => ({ ok: true, command: { commandId: 'cmd-1' }, duplicate: false, delivery: { delivered: 1 } }) };
        }
        if (url.includes('/events') && !url.includes('after=')) {
          // events 基线（游标）
          return { ok: true, status: 200, json: async () => ({ ok: true, events: [], cursor: 10 }) };
        }
        if (url.includes('/events?after=10')) {
          return { ok: true, status: 200, json: async () => ({ ok: true, events: [{ type: 'turn.completed', turn: 1 }], cursor: 11 }) };
        }
        if (url.endsWith('/threads/wt-1')) {
          // 第一轮 executing，之后 idle（lifeState 离开 executing → 落定）
          const lifeState = threadPolls === 0 ? 'executing' : 'idle';
          threadPolls += 1;
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, thread: { threadId: 'wt-1', lifeState, status: 'open', failed: false, commands: [] } }),
          };
        }
        return { ok: false, status: 404, json: async () => ({ ok: false, error: `no route: ${url}` }) };
      }) as unknown as FetchLike,
    });
    const r = await runCapabilityShellPipeline(
      POLICY,
      "send wt-1 ticket-1 'do the work'",
      { adapters, bashPath: null },
    );
    assert.equal(r.ok, true, r.output);
    assert.ok(r.output.includes('sent '), r.output);
    assert.ok(r.output.includes('done reason=turn.completed'), r.output);
  });

  it('send 超时：settle 窗口内收到终止信号 → 结构化 done reason=timeout（非错误）', async () => {
    // 模拟 Tool.timeout 已触发（termination() = 'timeout'，signal 已 abort）：
    // adapter 在下一轮轮询前感知终止，返回结构化 done，不抛错
    const adapters = createThreadsAdapters({
      serverOrigin: 'http://test',
      pollIntervalMs: 1,
      fetchImpl: stubFetch([
        { match: (u) => u.endsWith('/threads/wt-1/commands'), body: { ok: true, command: { commandId: 'cmd-1' }, duplicate: false, delivery: { delivered: 1 } } },
        { match: (u) => u.includes('/events'), body: { ok: true, events: [], cursor: 10 } },
        { match: (u) => u.endsWith('/threads/wt-1'), body: { ok: true, thread: { threadId: 'wt-1', lifeState: 'executing', status: 'open', failed: false, commands: [] } } },
      ]),
    });
    const tool = createCapabilityShellTool(POLICY, adapters, {
      bashPath: null,
      timeoutMs: 50,
      maxTimeoutMs: 50,
    });
    const ac = new AbortController();
    const out = await tool.execute(
      { command: "send wt-1 ticket-1 'long work'" },
      {
        signal: AbortSignal.timeout(50),
        termination: () => 'timeout',
      } as any,
    );
    const text = String(out);
    assert.ok(tool.timeout, '工具应声明 timeout 契约（唯一超时闸门）');
    assert.ok(tool.timeout!.fromArg === 'timeout');
    assert.ok(text.includes('done reason=timeout'), `超时应返回结构化 done 而非错误: ${text}`);
    assert.ok(text.includes('watch wt-1'), '超时报文应指引续挂 watch');
  });

  it('watch 续挂：落定即返，结构化 done（mock fetch）', async () => {
    const adapters = createThreadsAdapters({
      serverOrigin: 'http://test',
      pollIntervalMs: 1,
      fetchImpl: stubFetch([
        { match: (u) => u.includes('/events') && !u.includes('after='), body: { ok: true, events: [], cursor: 10 } },
        { match: (u) => u.endsWith('/threads/wt-1'), body: { ok: true, thread: { threadId: 'wt-1', lifeState: 'idle', status: 'open', failed: false, commands: [] } } },
        { match: (u) => u.includes('/events?after=10'), body: { ok: true, events: [{ type: 'turn.completed', turn: 1 }], cursor: 11 } },
      ]),
    });
    const r = await runCapabilityShellPipeline(POLICY, 'watch wt-1', {
      adapters,
      bashPath: null,
    });
    assert.equal(r.ok, true, r.output);
    assert.ok(r.output.includes('done reason=turn.completed'), r.output);
  });
});
