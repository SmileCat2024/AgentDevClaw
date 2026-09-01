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

describe('coder_shell 动词表（ticket 034/035）', () => {
  it('v1 动词表恰为 9 个：new-session/create/send/watch/list/show/archive/unarchive/deliver', () => {
    assert.deepEqual(
      Object.keys(POLICY.verbs).sort(),
      ['archive', 'create', 'deliver', 'list', 'new-session', 'send', 'show', 'unarchive', 'watch'],
    );
  });

  it('advance / resume 不入动词表', () => {
    assert.ok(!('advance' in POLICY.verbs));
    assert.ok(!('resume' in POLICY.verbs));
  });

  it('工具声明 parallelizable：派发语义批次可并发（同线程冲突由服务端 409 仲裁）', () => {
    const tool = createCapabilityShellTool(POLICY, {}, { bashPath: null });
    assert.equal(tool.parallelizable, true);
  });

  it('list 的 agentId 可选（ticket 035 审查修正）：裸 list 与 list <agentId> 均过参数道', async () => {
    const adapters = createThreadsAdapters({
      serverOrigin: 'http://test',
      fetchImpl: stubFetch([
        {
          match: (u) => u.endsWith('/protoclaw/threads') || u.includes('/protoclaw/threads?agentId='),
          body: { threads: [{ threadId: 'wt-1', status: 'open', lifeState: 'idle', failed: false }] },
        },
      ]),
    });
    for (const cmd of ['list', 'list programming-helper']) {
      const r = await runCapabilityShellPipeline(POLICY, cmd, { adapters, bashPath: null });
      assert.equal(r.ok, true, `应放行: ${cmd} → ${r.output}`);
    }
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

describe('coder_shell new-session 动词（ticket 035A）', () => {
  /** 记录请求的 fetch stub：按 URL 谓词返回预设 payload，同时捕获请求。 */
  function recordingFetch(routes: Array<{ match: (url: string, init?: RequestInit) => boolean; body: any }>) {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      requests.push({ url, init });
      const route = routes.find((r) => r.match(url, init));
      if (!route) {
        return { ok: false, status: 404, json: async () => ({ ok: false, error: `no route: ${url}` }) };
      }
      return { ok: true, status: 200, json: async () => route.body };
    };
    return { fetchImpl, requests };
  }

  it('契约映射：POST /protoclaw/prebuilt_sessions，body 含 sessionType=coder 与 title', async () => {
    const { fetchImpl, requests } = recordingFetch([
      {
        match: (u, init) => u.endsWith('/protoclaw/prebuilt_sessions') && init?.method === 'POST',
        // threadId 在 session 对象之前（服务端为截断安全特意如此排列）
        body: { protocolVersion: 2, threadId: 'wt-new', session: { id: 'session-abc', title: 'T' }, targetSessionId: 'session-abc' },
      },
    ]);
    const adapters = createThreadsAdapters({ serverOrigin: 'http://test', fetchImpl });
    const r = await runCapabilityShellPipeline(POLICY, "new-session programming-helper '工单035 标题'", {
      adapters, bashPath: null,
    });
    assert.equal(r.ok, true, r.output);
    assert.equal(requests.length, 1, '应恰好发出一次 POST');
    const body = JSON.parse(String(requests[0].init?.body));
    assert.equal(body.agentId, 'programming-helper');
    assert.equal(body.sessionType, 'coder', 'body 必含 sessionType=coder（线程宿主自动建线）');
    assert.equal(body.title, '工单035 标题');
    assert.ok(!('openDirectory' in body), 'v1 不暴露目录参数');
    // 响应解析：threadId 在 session 对象之前，输出两行
    assert.ok(r.output.includes('sessionId=session-abc'), r.output);
    assert.ok(r.output.includes('threadId=wt-new'), r.output);
  });

  it('响应解析：threadId 前置（session 缺失也能解析），null threadId 附手动建线提示', async () => {
    const adapters = createThreadsAdapters({
      serverOrigin: 'http://test',
      fetchImpl: stubFetch([
        {
          match: (u) => u.endsWith('/protoclaw/prebuilt_sessions'),
          body: { threadId: null, session: { id: 'session-null' }, targetSessionId: 'session-null' },
        },
      ]),
    });
    const r = await runCapabilityShellPipeline(POLICY, 'new-session programming-helper', {
      adapters, bashPath: null,
    });
    assert.equal(r.ok, true, r.output);
    assert.ok(r.output.includes('sessionId=session-null'), r.output);
    assert.ok(r.output.includes('threadId=null'), r.output);
    assert.ok(r.output.includes('create'), '提示应含手动建线指引');
  });

  it('new-session 缺 agentId → 参数校验道拒绝（title 可选，1 参可过个数道）', async () => {
    // 0 参数：agentId 必填缺失
    const r0 = await runCapabilityShellPipeline(POLICY, 'new-session', { adapters: {}, bashPath: null });
    assert.equal(r0.ok, false);
    assert.equal(r0.rejection?.code, 'arg_rejected');
    assert.ok(r0.output.includes('new-session <agentId>'), r0.output);
    // 3 个参数（超限）同样拒绝
    const r3 = await runCapabilityShellPipeline(POLICY, 'new-session a b c', { adapters: {}, bashPath: null });
    assert.equal(r3.ok, false);
    assert.equal(r3.rejection?.code, 'arg_rejected');
  });
});

describe('coder_shell create 会话预校验（ticket 035B）', () => {
  /** 组装带请求记录的 adapters。 */
  function makeAdapters(routes: Array<{ match: (url: string, init?: RequestInit) => boolean; body: any }>) {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      requests.push({ url, init });
      const route = routes.find((r) => r.match(url, init));
      if (!route) {
        return { ok: false, status: 404, json: async () => ({ ok: false, error: `no route: ${url}` }) };
      }
      return { ok: true, status: 200, json: async () => route.body };
    };
    const adapters = createThreadsAdapters({ serverOrigin: 'http://test', fetchImpl });
    return { adapters, requests };
  }

  it('会话不存在 → 结构化拒绝，不产生任何 POST /protoclaw/threads 请求', async () => {
    const { adapters, requests } = makeAdapters([
      // 会话列表：目标 sessionId 不在列表
      { match: (u) => u.includes('/protoclaw/prebuilt_sessions?agentId='), body: { sessions: [{ id: 'session-other' }] } },
    ]);
    const r = await runCapabilityShellPipeline(POLICY, "create programming-helper session-missing '工单'", {
      adapters, bashPath: null,
    });
    assert.equal(r.ok, false, r.output);
    assert.equal(r.rejection?.code, 'dispatch_failed');
    assert.ok(r.output.includes('session-missing'), r.output);
    assert.ok(r.output.includes('new-session'), '拒绝文案应指引先用 new-session');
    assert.ok(
      !requests.some((req) => req.url.endsWith('/protoclaw/threads')),
      '拒绝路径不得发出建线 POST（无僵尸线程）',
    );
  });

  it('会话存在 → 预校验通过，正常建线', async () => {
    const { adapters, requests } = makeAdapters([
      { match: (u) => u.includes('/protoclaw/prebuilt_sessions?agentId=programming-helper'), body: { sessions: [{ id: 'session-ok', agentId: 'programming-helper' }] } },
      { match: (u, init) => u.endsWith('/protoclaw/threads') && init?.method === 'POST', body: { thread: { threadId: 'wt-1', lifeState: 'idle', status: 'open', failed: false } } },
    ]);
    const r = await runCapabilityShellPipeline(POLICY, 'create programming-helper session-ok', {
      adapters, bashPath: null,
    });
    assert.equal(r.ok, true, r.output);
    assert.ok(r.output.includes('threadId=wt-1'), r.output);
    assert.equal(requests.filter((req) => req.url.endsWith('/protoclaw/threads')).length, 1);
  });

  it('会话查询失败（server 错误）不阻塞建线，响应注明会话未验证', async () => {
    const { adapters, requests } = makeAdapters([
      // 列表查询 500：不阻塞建线
      { match: (u) => u.includes('/protoclaw/prebuilt_sessions?'), body: { ok: false, error: 'internal error' } },
      { match: (u, init) => u.endsWith('/protoclaw/threads') && init?.method === 'POST', body: { thread: { threadId: 'wt-2', lifeState: 'idle', status: 'open', failed: false } } },
    ]);
    const r = await runCapabilityShellPipeline(POLICY, 'create programming-helper session-ok', {
      adapters, bashPath: null,
    });
    assert.ok(r.output.includes('threadId=wt-2'), '查询失败不阻塞建线');
    assert.ok(r.output.includes('未验证'), `响应应注明会话未验证: ${r.output}`);
    // 列表 GET（1 次，失败）+ 建线 POST 都发出
    const postThreads = requests.filter((req) => req.url.endsWith('/protoclaw/threads') && req.init?.method === 'POST');
    assert.equal(postThreads.length, 1, '查询失败不阻塞建线 POST');
  });
});
