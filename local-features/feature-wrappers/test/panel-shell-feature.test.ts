/**
 * PanelShellFeature 测试（后台任务面板镜像，ADR-0018 首个通道接入）
 *
 * 覆盖：
 * - 继承替换形态：instanceof ShellFeature、构造即声明通道（featureId = name）
 * - 观察事件镜像：handleBgEvent → publishEvent(kind, snapshot(task) + outputTail)
 * - 声明失败的惰性补声明（首个观察事件触发）
 * - 发布失败静默吞掉（镜像面尽力而为）
 * - onHostRequest 请求面：list / status / kill / report / 未知类型
 * - registry 未创建（getBgRegistry() 为 null）的降级路径
 */

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { ShellFeature } from '@agentdevjs/shell-feature';
import { PanelShellFeature } from '../src/index.js';

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

/** 构造观察事件（测试用部分任务对象，绕开 BgTask 全量类型）。tail 需要
 * 引擎内部任务对象（chunks），fake 一并携带。 */
function fakeEvent(kind: string, task: { id: string; status: string }) {
  return { kind, task: { ...task, chunks: ['raw'] } } as unknown as Parameters<PanelShellFeature['handleBgEvent']>[0];
}

function makeRegistry(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: Record<string, unknown[]> = { kill: [], tail: [], snapshot: [], reportNow: [] };
  const registry = {
    calls,
    snapshot(task: unknown) {
      calls.snapshot.push([task]);
      const t = task as { id: string; status: string };
      return { id: t.id, status: t.status, projected: true };
    },
    list() { return [{ id: 't-list', status: 'running', projected: true }]; },
    get(taskId: string) {
      // t-list 同时给出引擎内部任务对象（带 chunks）：面板 list 分支必须经
      // get 拿原始任务再取尾巴——把 list() 的快照当任务传给 tail 属于回归。
      if (taskId === 't1') return { id: 't1', status: 'running', chunks: ['raw'] };
      if (taskId === 't-list') return { id: 't-list', status: 'running', chunks: ['raw'] };
      return undefined;
    },
    tail(task: unknown, chars: number) {
      if (typeof task !== 'object' || task === null || !('chunks' in task)) {
        throw new TypeError("Cannot read properties of undefined (reading 'join')");
      }
      calls.tail.push([task, chars]);
      const id = (task as { id?: string }).id ?? 'unknown';
      return `tail-of-${id}:${chars}`;
    },
    kill(taskId: string, opts?: { graceful?: boolean; manual?: boolean }) {
      calls.kill.push([taskId, opts]);
      return taskId === 't1';
    },
    reportNow(taskId: string) {
      calls.reportNow.push([taskId]);
      return taskId === 't1';
    },
    ...overrides,
  };
  return registry;
}

function makeFeature() {
  return new PanelShellFeature({
    workspaceDir: 'ws',
    agentId: 'programming-helper',
    sessionId: 'session-x',
    serverOrigin: 'http://127.0.0.1:1420',
  });
}

/** 注入 fake registry：实例上覆盖惰性访问器（真实 _registry 在 getAsyncTools 才创建）。 */
function injectRegistry(feature: PanelShellFeature, registry: ReturnType<typeof makeRegistry>) {
  feature.getBgRegistry = () => registry as unknown as ReturnType<PanelShellFeature['getBgRegistry']>;
}

let script: FetchScript;

beforeEach(() => {
  script = new FetchScript();
  script.install();
});

afterEach(() => {
  script.restore();
});

describe('继承替换形态', () => {
  it('是 ShellFeature 的子类（装配处直接替换，不双挂载）', () => {
    const feature = makeFeature();
    assert.ok(feature instanceof ShellFeature);
    assert.equal(feature.name, 'shell');
    assert.equal(typeof feature.onHostRequest, 'function');
  });

  it('构造即声明，featureId 等于 feature name（IPC 分发按它查实例）', async () => {
    makeFeature();
    await flush();
    assert.equal(script.calls.length, 1);
    assert.equal(script.calls[0].url, 'http://127.0.0.1:1420/protoclaw/feature-comms/declare');
    assert.deepEqual(
      { agentId: script.calls[0].body.agentId, sessionId: script.calls[0].body.sessionId, featureId: script.calls[0].body.featureId, channelId: script.calls[0].body.channelId },
      { agentId: 'programming-helper', sessionId: 'session-x', featureId: 'shell', channelId: 'shell-bg' },
    );
    assert.equal(script.calls[0].body.title, '后台任务');
  });

  it('构造期声明失败不抛出，首个观察事件触发补声明后发布成功', async () => {
    script.pushResponse({ ok: false, code: 'runtime_not_found' }); // 构造期 declare：失败
    script.pushResponse({ ok: true }); // 补声明：成功
    const feature = makeFeature();
    await flush();
    assert.equal(script.calls.filter((c) => c.url.endsWith('/declare')).length, 1); // 构造期只试了一次

    injectRegistry(feature, makeRegistry());
    feature.handleBgEvent(fakeEvent('registered', { id: 't1', status: 'running' }));
    await flush();
    const declares = script.calls.filter((c) => c.url.endsWith('/declare'));
    const publishes = script.calls.filter((c) => c.url.endsWith('/publish'));
    assert.equal(declares.length, 2); // 补声明成功
    assert.equal(publishes.length, 1);
  });
});

describe('观察事件镜像', () => {
  it('事件投影为 publishEvent(kind, snapshot + outputTail)', async () => {
    const feature = makeFeature();
    await flush();
    const registry = makeRegistry();
    injectRegistry(feature, registry);

    feature.handleBgEvent(fakeEvent('finalized', { id: 't1', status: 'done' }));
    await flush();

    const publish = script.calls.find((c) => c.url.endsWith('/publish'));
    assert.ok(publish, 'publish call expected');
    assert.equal(publish.body.kind, 'event');
    assert.equal(publish.body.eventType, 'finalized');
    // 输出尾巴随事件下发（面板纯事件驱动渲染，不另发请求）
    assert.deepEqual(publish.body.data, { id: 't1', status: 'done', projected: true, outputTail: 'tail-of-t1:2000' });
  });

  it('发布失败被静默吞掉，后续事件继续尝试', async () => {
    const feature = makeFeature();
    await flush();
    injectRegistry(feature, makeRegistry());

    script.pushResponse({ ok: false, code: 'internal_error' });
    assert.doesNotThrow(() => feature.handleBgEvent(fakeEvent('output', { id: 't1', status: 'running' })));
    await flush();
    // 已声明，第二个事件不再 declare；发布继续尝试（默认响应 ok）
    feature.handleBgEvent(fakeEvent('report', { id: 't1', status: 'running' }));
    await flush();
    const publishes = script.calls.filter((c) => c.url.endsWith('/publish'));
    assert.equal(publishes.length, 2);
    assert.equal(publishes[1].body.eventType, 'report');
  });

  it('registry 未创建（getBgRegistry() 为 null）时降级为 { id, kind } 投影', async () => {
    const feature = makeFeature();
    await flush();
    feature.handleBgEvent(fakeEvent('registered', { id: 't9', status: 'running' }));
    await flush();
    const publish = script.calls.find((c) => c.url.endsWith('/publish'));
    assert.deepEqual(publish?.body.data, { id: 't9', kind: 'registered' });
  });
});

describe('onHostRequest 请求面', () => {
  it('list：快照 + 输出尾巴（尾巴经 get 拿原始任务，快照直接传 tail 会炸）', async () => {
    const feature = makeFeature();
    injectRegistry(feature, makeRegistry());
    const result = await feature.onHostRequest('list', {});
    assert.equal(result.ok, true);
    assert.deepEqual(result.tasks, [{ id: 't-list', status: 'running', projected: true, outputTail: 'tail-of-t-list:2000' }]);
  });

  it('list：registry 未创建返回空列表', async () => {
    const feature = makeFeature();
    const result = await feature.onHostRequest('list', {});
    assert.equal(result.ok, true);
    assert.deepEqual(result.tasks, []);
  });

  it('status：返回 snapshot + 输出尾部', async () => {
    const feature = makeFeature();
    const registry = makeRegistry();
    injectRegistry(feature, registry);
    const result = await feature.onHostRequest('status', { taskId: 't1' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.task, { id: 't1', status: 'running', projected: true });
    assert.equal(result.outputTail, 'tail-of-t1:4000');
  });

  it('status：任务不存在或缺 taskId 返回 task_not_found', async () => {
    const feature = makeFeature();
    injectRegistry(feature, makeRegistry());
    assert.equal((await feature.onHostRequest('status', { taskId: 'nope' })).code, 'task_not_found');
    assert.equal((await feature.onHostRequest('status', {})).code, 'task_not_found');
  });

  it('kill：成功返回 killed；面板 kill 是用户发起，manual: true 随行（触发打断通知）', async () => {
    const feature = makeFeature();
    const registry = makeRegistry();
    injectRegistry(feature, registry);
    const result = await feature.onHostRequest('kill', { taskId: 't1', graceful: true });
    assert.deepEqual(result, { ok: true, killed: true });
    assert.deepEqual(registry.calls.kill, [['t1', { graceful: true, manual: true }]]);
  });

  it('kill：任务不存在返回 task_not_found', async () => {
    const feature = makeFeature();
    injectRegistry(feature, makeRegistry());
    const result = await feature.onHostRequest('kill', { taskId: 'nope' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'task_not_found');
  });

  it('report：触发 registry.reportNow（手动立即汇报）', async () => {
    const feature = makeFeature();
    const registry = makeRegistry();
    injectRegistry(feature, registry);
    const result = await feature.onHostRequest('report', { taskId: 't1' });
    assert.deepEqual(result, { ok: true, reported: true });
    assert.deepEqual(registry.calls.reportNow, [['t1']]);
  });

  it('report：任务不存在或缺 taskId 返回 task_not_found', async () => {
    const feature = makeFeature();
    injectRegistry(feature, makeRegistry());
    assert.equal((await feature.onHostRequest('report', { taskId: 'nope' })).code, 'task_not_found');
    assert.equal((await feature.onHostRequest('report', {})).code, 'task_not_found');
  });

  it('未知 requestType 返回 operation_unavailable', async () => {
    const feature = makeFeature();
    const result = await feature.onHostRequest('explode', {});
    assert.equal(result.ok, false);
    assert.equal(result.code, 'operation_unavailable');
  });
});
