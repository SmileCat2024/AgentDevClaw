/**
 * ModelSelectionFeature 单元测试（ADR-0034 实施方案 §2 / §9）
 *
 * 用假 modelControl 与假通道 client 断言：
 * - 状态两态契约（presetName null/string；thinkingEffort 键缺席/显式值）
 * - 行为矩阵：五类 RestoreOrigin 的恢复行为（rollback 忽略选择，其余应用）
 * - 应用流程：热重载顺序（restore 先于 onInitiate 时暂存）、pendingChoice 不残留
 * - 恢复失败：回退 __default__ + lastRestoreFailure；双败抛错；无 preset 锚点记录不抛
 * - 请求面：getStatus / selectModel / clearThinkingOverride 的成功与失败路径
 * - declareContinuity 包装：captureState 叠加协议字段；restoreState 剥离后透传 ctx
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FeatureInitContext, FeatureModelControl, LLMMeta, RestoreContext } from '@agentdevjs/core';
import {
  ModelSelectionFeature,
  ModelSelectionFeatureInner,
  type ModelSelectionState,
} from '../src/index.js';

// ========== 假件 ==========

type SetModelCall = { presetName: string; opts?: { thinkingEffort?: string | null; source?: string } };

class FakeModelControl implements FeatureModelControl {
  calls: SetModelCall[] = [];
  /** 按 presetName 决定解析成败；缺省全成功。 */
  failPresets = new Set<string>(['gone-preset']);
  meta: LLMMeta = { modelName: 'boot-model', presetName: 'boot-preset', modelRevision: 0 };

  setModel(presetName: string, opts?: { thinkingEffort?: string | null; source?: string }): boolean {
    this.calls.push({ presetName, opts });
    if (this.failPresets.has(presetName)) return false;
    this.meta = { ...this.meta, presetName, modelRevision: this.meta.modelRevision + 1 };
    return true;
  }

  setThinkingEffort(effort: string | null, opts?: { source?: string }): boolean {
    if (!this.meta.presetName) return false;
    return this.setModel(this.meta.presetName, { thinkingEffort: effort, ...opts });
  }

  getLLMMeta(): LLMMeta {
    return { ...this.meta };
  }

  hasModelResolver(): boolean {
    return true;
  }

  lastCall(): SetModelCall | undefined {
    return this.calls[this.calls.length - 1];
  }
}

class FakeChannelClient {
  declarations = 0;
  events: Array<{ eventType: string; data: unknown }> = [];
  async declareChannel(_meta: { title?: string; description?: string }): Promise<unknown> {
    this.declarations += 1;
    return { ok: true };
  }
  async publishEvent(eventType: string, data: unknown): Promise<unknown> {
    this.events.push({ eventType, data });
    return { ok: true };
  }
}

interface Fixture {
  feature: ModelSelectionFeatureInner;
  mc: FakeModelControl;
  client: FakeChannelClient;
  initCtx: FeatureInitContext;
}

function makeFixture(): Fixture {
  const mc = new FakeModelControl();
  const client = new FakeChannelClient();
  const feature = new ModelSelectionFeatureInner({ agentId: 'a', sessionId: 's', serverOrigin: 'http://x', client });
  const initCtx = {
    agentId: 'a',
    config: {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    getFeature: () => undefined,
    registerTool: () => {},
    dataSourceRegistry: {},
    modelControl: mc,
  } as unknown as FeatureInitContext;
  return { feature, mc, client, initCtx };
}

/** feature 已完成 onInitiate（持有 modelControl、通道已声明）。 */
async function initiated(): Promise<Fixture> {
  const fixture = makeFixture();
  await fixture.feature.onInitiate(fixture.initCtx);
  return fixture;
}

/** 排空微任务（feature 内 publish/declare 为 fire-and-forget 异步）。 */
function flushMicrotasks(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

const origins: Array<[string, RestoreContext]> = [
  ['session-revive', { origin: { kind: 'session-revive' } }],
  ['continuity-import', { origin: { kind: 'continuity-import', sourceSessionId: 'src' } }],
  ['branch-import', { origin: { kind: 'branch-import', sourceSessionId: 'src' } }],
  ['hot-reload', { origin: { kind: 'hot-reload' } }],
];

// ========== 状态两态契约 ==========

test('captureState：无覆盖时 presetName null 且无 thinkingEffort 键', async () => {
  const { feature } = await initiated();
  const state = feature.captureState();
  assert.equal(state.presetName, null);
  assert.equal('thinkingEffort' in state, false);
  assert.equal(state.schemaVersion, 1);
});

test('请求面成功路径更新内存选择；captureState 两键齐备', async () => {
  const { feature } = await initiated();
  const result = await feature.onHostRequest('selectModel', { presetName: 'fast-model', thinkingEffort: 'high' });
  assert.equal(result.ok, true);
  assert.equal((result.meta as LLMMeta).presetName, 'fast-model');
  const state = feature.captureState();
  assert.equal(state.presetName, 'fast-model');
  assert.equal(state.thinkingEffort, 'high');
});

// ========== 行为矩阵 ==========

test('rollback origin：忽略快照选择（无 setModel），lastRestoreFailure 正常恢复', async () => {
  const { feature, mc } = await initiated();
  await feature.onHostRequest('selectModel', { presetName: 'current-choice' });
  mc.calls.length = 0;

  await feature.restoreState(
    { schemaVersion: 1, presetName: 'old-choice', thinkingEffort: 'low', lastRestoreFailure: { reason: 'preset_unavailable', at: 123 } },
    { origin: { kind: 'rollback' } },
  );

  assert.equal(mc.calls.length, 0);
  const status = await feature.onHostRequest('getStatus', {});
  assert.equal((status.choice as { presetName: string }).presetName, 'current-choice');
  assert.deepEqual(status.lastRestoreFailure, { reason: 'preset_unavailable', at: 123 });
});

for (const [label, ctx] of origins) {
  test(`${label} origin：应用快照选择（setModel source=restore）`, async () => {
    const { feature, mc } = await initiated();
    await feature.restoreState({ schemaVersion: 1, presetName: 'saved-model', thinkingEffort: 'high' }, ctx);
    const last = mc.lastCall();
    assert.ok(last, 'setModel 应被调用');
    assert.equal(last.presetName, 'saved-model');
    assert.equal(last.opts?.thinkingEffort, 'high');
    assert.equal(last.opts?.source, 'model-selection:restore');
    const status = await feature.onHostRequest('getStatus', {});
    assert.deepEqual(status.choice, { presetName: 'saved-model', thinkingEffort: 'high' });
  });
}

test('无 ctx（旧调用方）：按应用语义处理（等同非 rollback）', async () => {
  const { feature, mc } = await initiated();
  await feature.restoreState({ schemaVersion: 1, presetName: 'legacy-model' });
  assert.equal(mc.lastCall()?.presetName, 'legacy-model');
});

test('快照无覆盖（presetName null）：非 rollback 下无模型动作', async () => {
  const { feature, mc } = await initiated();
  await feature.restoreState({ schemaVersion: 1, presetName: null }, { origin: { kind: 'session-revive' } });
  assert.equal(mc.calls.length, 0);
});

test('非法快照：无操作不抛错', async () => {
  const { feature, mc } = await initiated();
  await feature.restoreState({ garbage: true }, { origin: { kind: 'session-revive' } });
  await feature.restoreState(null, { origin: { kind: 'session-revive' } });
  assert.equal(mc.calls.length, 0);
});

// ========== 应用流程：时序与 pendingChoice ==========

test('热重载顺序（restoreState 先于 onInitiate）：暂存待 onInitiate 应用', async () => {
  const fixture = makeFixture();
  await fixture.feature.restoreState({ schemaVersion: 1, presetName: 'reloaded-model' }, { origin: { kind: 'hot-reload' } });
  assert.equal(fixture.mc.calls.length, 0, '无 modelControl 时不得应用');
  await fixture.feature.onInitiate(fixture.initCtx);
  assert.equal(fixture.mc.lastCall()?.presetName, 'reloaded-model');
});

test('pendingChoice 不残留：应用完成后再触发 onInitiate 不重复应用', async () => {
  const fixture = await initiated();
  await fixture.feature.restoreState({ schemaVersion: 1, presetName: 'once-model' }, { origin: { kind: 'session-revive' } });
  const applied = fixture.mc.calls.length;
  assert.ok(applied >= 1);
  await fixture.feature.onInitiate(fixture.initCtx); // 再触发（热重载后再次 mount）
  assert.equal(fixture.mc.calls.length, applied, 'pendingChoice 已清，不得重复 setModel');
});

// ========== 恢复失败路径 ==========

test('恢复失败：回退 __default__，lastRestoreFailure 记录，选择保留原值', async () => {
  const { feature, mc } = await initiated();
  await feature.restoreState({ schemaVersion: 1, presetName: 'gone-preset' }, { origin: { kind: 'session-revive' } });
  assert.deepEqual(mc.calls.map((c) => c.presetName), ['gone-preset', '__default__']);
  assert.equal(mc.calls[1].opts?.source, 'model-selection:fallback');
  const status = await feature.onHostRequest('getStatus', {});
  assert.equal((status.choice as { presetName: string }).presetName, 'gone-preset');
  assert.equal((status.lastRestoreFailure as { reason: string }).reason, 'preset_unavailable');
});

test('双败（原 preset 与 __default__ 均失败）：抛错（宿主 READY 门禁不放行）', async () => {
  const { feature, mc } = await initiated();
  mc.failPresets.add('__default__');
  await assert.rejects(
    () => feature.restoreState({ schemaVersion: 1, presetName: 'gone-preset' }, { origin: { kind: 'session-revive' } }),
    /model-selection restore failed/,
  );
});

test('presetName null + 档位覆盖 + 无 preset 锚点：记录 no_preset_anchor 不抛错', async () => {
  const fixture = makeFixture();
  fixture.mc.meta = { modelName: 'raw-model', modelRevision: 0 }; // 无 presetName
  await fixture.feature.onInitiate(fixture.initCtx);
  await fixture.feature.restoreState({ schemaVersion: 1, presetName: null, thinkingEffort: 'high' }, { origin: { kind: 'session-revive' } });
  const status = await fixture.feature.onHostRequest('getStatus', {});
  assert.equal((status.lastRestoreFailure as { reason: string }).reason, 'no_preset_anchor');
});

// ========== 请求面 ==========

test('selectModel：presetName 缺失或空串拒绝', async () => {
  const { feature } = await initiated();
  assert.equal((await feature.onHostRequest('selectModel', {})).code, 'invalid_payload');
  assert.equal((await feature.onHostRequest('selectModel', { presetName: '' })).code, 'invalid_payload');
});

test('selectModel：thinkingEffort null 违反两态契约拒绝', async () => {
  const { feature } = await initiated();
  const result = await feature.onHostRequest('selectModel', { presetName: 'm', thinkingEffort: null });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid_payload');
});

test('selectModel：解析失败返回业务错误，choice 不变', async () => {
  const { feature, mc } = await initiated();
  await feature.onHostRequest('selectModel', { presetName: 'good-model' });
  const before = await feature.onHostRequest('getStatus', {});
  const result = await feature.onHostRequest('selectModel', { presetName: 'gone-preset' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'preset_resolve_failed');
  const after = await feature.onHostRequest('getStatus', {});
  assert.deepEqual(after.choice, before.choice);
  assert.equal(mc.lastCall()?.presetName, 'gone-preset');
});

test('selectModel：effort 键缺席不动档位（保留既有覆盖）', async () => {
  const { feature, mc } = await initiated();
  await feature.onHostRequest('selectModel', { presetName: 'model-a', thinkingEffort: 'high' });
  await feature.onHostRequest('selectModel', { presetName: 'model-b' });
  const last = mc.lastCall();
  assert.equal(last?.presetName, 'model-b');
  assert.equal('thinkingEffort' in (last?.opts ?? {}), false);
  const state = feature.captureState();
  assert.equal(state.presetName, 'model-b');
  assert.equal(state.thinkingEffort, 'high');
});

test('clearThinkingOverride：按当前选择重 resolve 且不带覆盖，键删除', async () => {
  const { feature, mc } = await initiated();
  await feature.onHostRequest('selectModel', { presetName: 'model-a', thinkingEffort: 'high' });
  const result = await feature.onHostRequest('clearThinkingOverride', {});
  assert.equal(result.ok, true);
  const last = mc.lastCall();
  assert.equal(last?.presetName, 'model-a');
  assert.equal('thinkingEffort' in (last?.opts ?? {}), false);
  assert.equal('thinkingEffort' in feature.captureState(), false);
});

test('未知 requestType：operation_unavailable', async () => {
  const { feature } = await initiated();
  assert.equal((await feature.onHostRequest('nope', {})).code, 'operation_unavailable');
});

// ========== refresh-credentials（凭证刷新收编，ADR-0034） ==========

test('refresh-credentials：按当前 preset 重 resolve，choice 不变，不发布快照', async () => {
  const { feature, mc, client } = await initiated();
  await feature.onHostRequest('selectModel', { presetName: 'model-a' });
  mc.calls.length = 0;
  await flushMicrotasks();
  const eventsBefore = client.events.length;

  const result = await feature.onHostRequest('refresh-credentials', {});
  assert.equal(result.ok, true);
  const last = mc.lastCall();
  assert.equal(last?.presetName, 'model-a');
  assert.equal(last?.opts?.source, 'credential-refresh');
  assert.equal('thinkingEffort' in (last?.opts ?? {}), false, '活 meta 无档位时不得透传');
  // 同一选择下的实例轮换：不是改选——内存 choice 与快照事件都不得变化
  const status = await feature.onHostRequest('getStatus', {});
  assert.deepEqual(status.choice, { presetName: 'model-a' });
  await flushMicrotasks();
  assert.equal(client.events.length, eventsBefore, 'refresh 不得触发 snapshot 发布');
});

test('refresh-credentials：活 meta 携带档位时原样透传（含显式 null）', async () => {
  const { feature, mc } = await initiated();
  mc.meta = { ...mc.meta, presetName: 'model-a', thinkingEffort: 'high' };
  await feature.onHostRequest('refresh-credentials', {});
  assert.equal(mc.lastCall()?.opts?.thinkingEffort, 'high');
  mc.meta = { ...mc.meta, thinkingEffort: null };
  await feature.onHostRequest('refresh-credentials', {});
  assert.strictEqual(mc.lastCall()?.opts?.thinkingEffort, null);
});

test('refresh-credentials：非 preset 锚点返回 no_preset_anchor，不触发 setModel', async () => {
  const fixture = makeFixture();
  fixture.mc.meta = { modelName: 'raw-model', modelRevision: 0 };
  await fixture.feature.onInitiate(fixture.initCtx);
  const result = await fixture.feature.onHostRequest('refresh-credentials', {});
  assert.equal(result.ok, false);
  assert.equal(result.code, 'no_preset_anchor');
  assert.equal(fixture.mc.calls.length, 0);
});

test('refresh-credentials：重 resolve 失败返回业务错误，保留原实例与选择', async () => {
  const { feature, mc } = await initiated();
  await feature.onHostRequest('selectModel', { presetName: 'model-a' });
  const metaBefore = { ...mc.meta };
  mc.failPresets.add('model-a');
  const result = await feature.onHostRequest('refresh-credentials', {});
  assert.equal(result.ok, false);
  assert.equal(result.code, 'preset_resolve_failed');
  assert.deepEqual(mc.meta, metaBefore);
  const status = await feature.onHostRequest('getStatus', {});
  assert.deepEqual(status.choice, { presetName: 'model-a' });
});


// ========== 通道与 continuity 包装 ==========

test('onInitiate 声明通道一次；选择变化与 onLLMSwap 广播 snapshot 事件', async () => {
  const { feature, client } = await initiated();
  await feature.onHostRequest('selectModel', { presetName: 'm1' });
  await flushMicrotasks();
  const snapshotEvents = client.events.filter((e) => e.eventType === 'snapshot');
  assert.ok(snapshotEvents.length >= 1);
  const payload = snapshotEvents[snapshotEvents.length - 1].data as { choice: { presetName: string }; ready: boolean };
  assert.equal(payload.choice.presetName, 'm1');
  assert.equal(payload.ready, true);
  feature.onLLMSwap();
  await flushMicrotasks();
  assert.ok(client.events.filter((e) => e.eventType === 'snapshot').length >= 2);
  // 再触发 onInitiate 不重复声明
  await feature.onInitiate(makeFixture().initCtx);
  assert.equal(client.declarations, 1);
});

test('declareContinuity 包装：captureState 叠加协议字段；restoreState 剥离并透传 ctx', async () => {
  const fixture = makeFixture();
  const wrapped = new ModelSelectionFeature({ agentId: 'a', sessionId: 's', serverOrigin: 'http://x', client: fixture.client });
  await wrapped.onInitiate!(fixture.initCtx);

  await wrapped.onHostRequest!('selectModel', { presetName: 'wrapped-model' });
  const state = wrapped.captureState!() as ModelSelectionState & {
    __agentdev_continuity__?: { protocol: string; importMode: string };
  };
  const descriptor = state.__agentdev_continuity__;
  assert.ok(descriptor, '__agentdev_continuity__ 协议字段应存在');
  assert.equal(descriptor.protocol, 'claw.model-selection.v1');
  assert.equal(descriptor.importMode, 'replace');

  // rollback origin 经包装透传：Inner 不应用选择
  fixture.mc.calls.length = 0;
  await wrapped.restoreState!({ ...state, presetName: 'historical-model' }, { origin: { kind: 'rollback' } });
  assert.equal(fixture.mc.calls.length, 0);
  const status = (await wrapped.onHostRequest!('getStatus', {})) as { choice: { presetName: string } };
  assert.equal(status.choice.presetName, 'wrapped-model');
});
