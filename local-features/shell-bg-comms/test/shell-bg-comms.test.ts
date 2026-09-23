/**
 * shell-bg-comms 测试
 *
 * 覆盖：
 * - 构造即声明通道（target 四元组 + 标题元数据）
 * - observer 事件镜像：publishEvent(kind, registry.snapshot(task))
 * - 声明失败的惰性补声明（首个观察事件触发）
 * - 发布失败静默吞掉（镜像面尽力而为）
 * - onHostRequest 请求面：list / status / kill / 未知类型
 * - 未 attachShell 的降级路径
 */

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { ShellBgCommsFeature } from '../src/index.js';

interface RecordedCall { url: string; body: Record<string, unknown>; }

class FetchScript {
  calls: RecordedCall[] = [];
  private queue: Array<Record<string, unknown> | undefined> = [];
  private readonly originalFetch = globalThis.fetch;

  pushResponse(payload: Record<string, unknown>) { this.queue.push(payload); }

  install() {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      this.calls.push({ url: String(url), body });
      const responder = this.queue.length > 0 ? this.queue.shift() : undefined;
      const payload = responder ?? { ok: true };
      const ok = (payload as { ok?: unknown })?.ok !== false;
      return new Response(JSON.stringify(payload), { status: ok ? 200 : 400 });
    }) as typeof fetch;
  }

  restore() { globalThis.fetch = this.originalFetch; }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** 构造观察事件（测试用部分任务对象，绕开 BgTask 全量类型）。 */
function fakeEvent(kind: string, task: { id: string; status: string }) {
  return { kind, task } as unknown as Parameters<ShellBgCommsFeature['observer']>[0];
}

function makeRegistry(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: Record<string, unknown[]> = { kill: [], tail: [], snapshot: [] };
  const registry = {
    calls,
    snapshot(task: unknown) {
      calls.snapshot.push([task]);
      const t = task as { id: string; status: string };
      return { id: t.id, status: t.status, projected: true };
    },
    list() { return [{ id: 't-list', status: 'running', projected: true }]; },
    get(taskId: string) { return taskId === 't1' ? { id: 't1', status: 'running' } : undefined; },
    tail(task: unknown, chars: number) { calls.tail.push([task, chars]); return `tail-of-${(task as { id: string }).id}:${chars}`; },
    kill(taskId: string, opts?: { graceful?: boolean }) {
      calls.kill.push([taskId, opts]);
      return taskId === 't1';
    },
    ...overrides,
  };
  return registry;
}

function makeFeature() {
  return new ShellBgCommsFeature({
    agentId: 'programming-helper',
    sessionId: 'session-x',
    serverOrigin: 'http://127.0.0.1:1420',
  });
}

let script: FetchScript;

beforeEach(() => {
  script = new FetchScript();
  script.install();
});

afterEach(() => {
  script.restore();
});

describe('通道声明', () => {
  it('构造即声明，携带四元组与标题元数据', async () => {
    makeFeature();
    await flush();
    assert.equal(script.calls.length, 1);
    assert.equal(script.calls[0].url, 'http://127.0.0.1:1420/protoclaw/feature-comms/declare');
    assert.deepEqual(
      { agentId: script.calls[0].body.agentId, sessionId: script.calls[0].body.sessionId, featureId: script.calls[0].body.featureId, channelId: script.calls[0].body.channelId },
      { agentId: 'programming-helper', sessionId: 'session-x', featureId: 'shell-bg-comms', channelId: 'shell-bg' },
    );
    assert.equal(script.calls[0].body.title, '后台任务');
  });

  it('构造期声明失败不抛出，首个观察事件触发补声明后发布成功', async () => {
    script.pushResponse({ ok: false, code: 'runtime_not_found' }); // 构造期 declare：失败
    script.pushResponse({ ok: true }); // 补声明：成功
    const feature = makeFeature();
    await flush();
    assert.equal(script.calls.filter((c) => c.url.endsWith('/declare')).length, 1); // 构造期只试了一次

    feature.attachShell({ getBgRegistry: () => makeRegistry() });
    feature.observer(fakeEvent('registered', { id: 't1', status: 'running' }));
    await flush();
    const declares = script.calls.filter((c) => c.url.endsWith('/declare'));
    const publishes = script.calls.filter((c) => c.url.endsWith('/publish'));
    assert.equal(declares.length, 2); // 补声明成功
    assert.equal(publishes.length, 1);
  });
});

describe('observer 事件镜像', () => {
  it('事件投影为 publishEvent(kind, registry.snapshot(task))', async () => {
    const feature = makeFeature();
    await flush();
    const registry = makeRegistry();
    feature.attachShell({ getBgRegistry: () => registry });

    feature.observer(fakeEvent('finalized', { id: 't1', status: 'done' }));
    await flush();

    const publish = script.calls.find((c) => c.url.endsWith('/publish'));
    assert.ok(publish, 'publish call expected');
    assert.equal(publish.body.kind, 'event');
    assert.equal(publish.body.eventType, 'finalized');
    assert.deepEqual(publish.body.data, { id: 't1', status: 'done', projected: true });
  });

  it('发布失败被静默吞掉，后续事件继续尝试', async () => {
    const feature = makeFeature();
    await flush();
    feature.attachShell({ getBgRegistry: () => makeRegistry() });

    script.pushResponse({ ok: false, code: 'internal_error' });
    assert.doesNotThrow(() => feature.observer(fakeEvent('output', { id: 't1', status: 'running' })));
    await flush();
    // 已声明，第二个事件不再 declare；发布继续尝试（默认响应 ok）
    feature.observer(fakeEvent('report', { id: 't1', status: 'running' }));
    await flush();
    const publishes = script.calls.filter((c) => c.url.endsWith('/publish'));
    assert.equal(publishes.length, 2);
    assert.equal(publishes[1].body.eventType, 'report');
  });

  it('未 attachShell 时降级为 { id, kind } 投影', async () => {
    const feature = makeFeature();
    await flush();
    feature.observer(fakeEvent('registered', { id: 't9', status: 'running' }));
    await flush();
    const publish = script.calls.find((c) => c.url.endsWith('/publish'));
    assert.deepEqual(publish?.body.data, { id: 't9', kind: 'registered' });
  });
});

describe('onHostRequest 请求面', () => {
  it('list：返回 registry.list()', async () => {
    const feature = makeFeature();
    feature.attachShell({ getBgRegistry: () => makeRegistry() });
    const result = await feature.onHostRequest('list', {});
    assert.equal(result.ok, true);
    assert.deepEqual(result.tasks, [{ id: 't-list', status: 'running', projected: true }]);
  });

  it('list：未 attachShell 返回空列表', async () => {
    const feature = makeFeature();
    const result = await feature.onHostRequest('list', {});
    assert.equal(result.ok, true);
    assert.deepEqual(result.tasks, []);
  });

  it('status：返回 snapshot + 输出尾部', async () => {
    const feature = makeFeature();
    const registry = makeRegistry();
    feature.attachShell({ getBgRegistry: () => registry });
    const result = await feature.onHostRequest('status', { taskId: 't1' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.task, { id: 't1', status: 'running', projected: true });
    assert.equal(result.outputTail, 'tail-of-t1:4000');
  });

  it('status：任务不存在或缺 taskId 返回 task_not_found', async () => {
    const feature = makeFeature();
    feature.attachShell({ getBgRegistry: () => makeRegistry() });
    assert.equal((await feature.onHostRequest('status', { taskId: 'nope' })).code, 'task_not_found');
    assert.equal((await feature.onHostRequest('status', {})).code, 'task_not_found');
  });

  it('kill：成功返回 killed，graceful 选项透传', async () => {
    const feature = makeFeature();
    const registry = makeRegistry();
    feature.attachShell({ getBgRegistry: () => registry });
    const result = await feature.onHostRequest('kill', { taskId: 't1', graceful: true });
    assert.deepEqual(result, { ok: true, killed: true });
    assert.deepEqual(registry.calls.kill, [['t1', { graceful: true }]]);
  });

  it('kill：任务不存在返回 task_not_found', async () => {
    const feature = makeFeature();
    feature.attachShell({ getBgRegistry: () => makeRegistry() });
    const result = await feature.onHostRequest('kill', { taskId: 'nope' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'task_not_found');
  });

  it('未知 requestType 返回 operation_unavailable', async () => {
    const feature = makeFeature();
    const result = await feature.onHostRequest('explode', {});
    assert.equal(result.ok, false);
    assert.equal(result.code, 'operation_unavailable');
  });
});
