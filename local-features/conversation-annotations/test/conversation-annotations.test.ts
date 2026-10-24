/**
 * ConversationAnnotationsFeature 测试：
 * - 快照契约：captureState 形状 / fresh 替换 / rollback 合并（cutoff 语义）
 * - 请求面：list / create（校验 + 幂等）/ remove / unknown
 * - 钩子跟踪：CallStart（N-1 边界）与 StepFinish（N 边界）的单调 max
 * - declareContinuity 包装：continuity 字段写入 / 剥离 / 合并语义不受影响
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ConversationAnnotationsFeatureInner,
  ConversationAnnotationsFeature,
  CONTINUITY_FIELD_KEY,
} from '../src/index.js';
import type { AnnotationChannelClient, AnnotationRecord } from '../src/index.js';

class FakeChannelClient implements AnnotationChannelClient {
  events: Array<{ eventType: string; data: unknown }> = [];
  declarations: unknown[] = [];
  failPublish = false;

  async declareChannel(meta: { title?: string; description?: string; presentation?: unknown }): Promise<unknown> {
    this.declarations.push(meta);
    return { ok: true };
  }

  async publishEvent(eventType: string, data: unknown): Promise<unknown> {
    if (this.failPublish) throw new Error('publish failed');
    this.events.push({ eventType, data });
    return { ok: true };
  }
}

function makeFeature() {
  const client = new FakeChannelClient();
  const feature = new ConversationAnnotationsFeatureInner({
    agentId: 'ph', sessionId: 's1', serverOrigin: 'http://127.0.0.1:1420', client,
  });
  return { client, feature };
}

/** 经 onHostRequest create 建标注（走真实校验路径）。 */
async function createVia(feature: ConversationAnnotationsFeatureInner, over: Partial<AnnotationRecord> = {}) {
  const result = await feature.onHostRequest('create', {
    turn: 1, role: 'user', quote: '重点内容', occurrence: 0, ...over,
  });
  assert.equal(result.ok, true, `create failed: ${JSON.stringify(result)}`);
  return result.annotation as AnnotationRecord;
}

describe('快照契约', () => {
  it('captureState 返回副本，修改返回值不影响内部状态', async () => {
    const { feature } = makeFeature();
    await createVia(feature, { quote: '原文' });
    const snapshot = feature.captureState() as { annotations: AnnotationRecord[]; lastCallIndex: number };
    assert.equal(snapshot.annotations.length, 1);
    assert.equal(snapshot.lastCallIndex, 0);
    snapshot.annotations.pop();
    const again = feature.captureState() as { annotations: AnnotationRecord[] };
    assert.equal(again.annotations.length, 1);
  });

  it('fresh 实例 restoreState 整体替换：call 进行中的标注（turn > lastCallIndex）不丢', async () => {
    const { feature } = makeFeature();
    await feature.restoreState({
      annotations: [
        { id: 'a1', turn: 5, role: 'assistant', quote: '结论', occurrence: 0, createdAt: 100 },
        { id: 'a2', turn: 9, role: 'assistant', quote: '流式中标注', occurrence: 1, createdAt: 200 },
      ],
      lastCallIndex: 8,
    });
    const list = await feature.onHostRequest('list', {});
    assert.equal(list.ok, true);
    assert.equal((list.annotations as AnnotationRecord[]).length, 2);
    assert.equal(list.annotations[1].turn, 9, 'turn > lastCallIndex 的标注在 fresh 替换下必须保留');
  });

  it('restoreState 防御：null / 非法条目过滤 / 不合法 lastCallIndex 视为未知', async () => {
    const { feature } = makeFeature();
    await feature.restoreState(null as never);
    await feature.restoreState({ annotations: [{ junk: true }, 'x'] });
    const list = await feature.onHostRequest('list', {});
    assert.equal((list.annotations as AnnotationRecord[]).length, 0);
  });

  it('rollback 合并：后创建的标注锚定幸存消息则保留（turn ≤ cutoff 并集）', async () => {
    const { feature } = makeFeature();
    // 模拟真实序列：会话恢复（fresh）→ 第 9 轮时标注第 5 轮内容 → 回退到第 7 轮后。
    const checkpointState = {
      annotations: [
        { id: 'old1', turn: 4, role: 'user', quote: '早期需求', occurrence: 0, createdAt: 1 },
        { id: 'old2', turn: 6, role: 'assistant', quote: '中期结论', occurrence: 0, createdAt: 2 },
      ],
      lastCallIndex: 8,
    };
    await feature.restoreState(checkpointState as never);
    const late = await createVia(feature, { turn: 5, role: 'assistant', quote: '第9轮才标注的第5轮内容' });
    assert.equal(late.turn, 5);
    // 回退到 checkpoint 8（幸存边界 turn ≤ 7）。
    await feature.restoreState(checkpointState as never);
    const list = await feature.onHostRequest('list', {});
    const turns = (list.annotations as AnnotationRecord[]).map((a) => `${a.id}:${a.turn}`).sort();
    // turn 5 的后期标注保留；快照内的 4 / 6 保留。
    assert.deepEqual(turns, [`${late.id}:5`, 'old1:4', 'old2:6']);
  });

  it('rollback 合并：turn > cutoff 的标注随消息删除', async () => {
    const { feature } = makeFeature();
    await feature.restoreState({
      annotations: [
        { id: 'keep', turn: 3, role: 'user', quote: '保留', occurrence: 0, createdAt: 1 },
      ],
      lastCallIndex: 10,
    });
    await createVia(feature, { turn: 9, role: 'assistant', quote: '第9轮标注' });
    await createVia(feature, { turn: 5, role: 'assistant', quote: '第9轮标注第5轮内容' });
    // 回退到 checkpoint 6（幸存边界 turn ≤ 5）。
    await feature.restoreState({
      annotations: [{ id: 'keep', turn: 3, role: 'user', quote: '保留', occurrence: 0, createdAt: 1 }],
      lastCallIndex: 5,
    });
    const list = await feature.onHostRequest('list', {});
    const turns = (list.annotations as AnnotationRecord[]).map((a) => a.turn).sort((a, b) => a - b);
    assert.deepEqual(turns, [3, 5], 'turn 9 消失、turn 5 保留');
  });

  it('连续回退单调收缩：回退到 7 后再回退到 3，turn 5 标注最终消失', async () => {
    const { feature } = makeFeature();
    await feature.restoreState({ annotations: [], lastCallIndex: 10 });
    await createVia(feature, { turn: 5, role: 'user', quote: '幸存一会' });
    await feature.restoreState({ annotations: [], lastCallIndex: 7 });
    let list = await feature.onHostRequest('list', {});
    assert.equal((list.annotations as AnnotationRecord[]).length, 1, '回退到 7：turn 5 仍在');
    await feature.restoreState({ annotations: [], lastCallIndex: 3 });
    list = await feature.onHostRequest('list', {});
    assert.equal((list.annotations as AnnotationRecord[]).length, 0, '回退到 3：turn 5 随消息消失');
  });

  it('legacy 快照（无 lastCallIndex）：保守并集不过滤', async () => {
    const { feature } = makeFeature();
    await feature.restoreState({ annotations: [], lastCallIndex: 10 });
    await createVia(feature, { turn: 8, role: 'user', quote: '无法判断边界时不丢' });
    await feature.restoreState({ annotations: [
      { id: 'legacy', turn: 2, role: 'user', quote: '旧标注', occurrence: 0, createdAt: 1 },
    ] });
    const list = await feature.onHostRequest('list', {});
    assert.equal((list.annotations as AnnotationRecord[]).length, 2);
  });

  it('未 hydrate 的实例直接 create 后，rollback 合并按 live 语义执行', async () => {
    const { feature } = makeFeature();
    // 未经过任何 restoreState 的全新会话：直接标注后回滚。
    await createVia(feature, { turn: 2, role: 'user', quote: '直接标注' });
    await feature.restoreState({ annotations: [], lastCallIndex: 1 });
    const list = await feature.onHostRequest('list', {});
    assert.equal((list.annotations as AnnotationRecord[]).length, 0, 'turn 2 > cutoff 1，随消息删除');
  });
});

describe('请求面', () => {
  it('create 校验：turn / role / quote / occurrence 逐项拒绝', async () => {
    const { feature } = makeFeature();
    const bad = [
      { turn: -1 }, { turn: 1.5 }, { turn: '3' },
      { role: 'system' }, { role: 'tool' },
      { quote: '' }, { quote: '   ' }, { quote: 42 },
      { occurrence: -1 }, { occurrence: 0.5 },
    ];
    for (const over of bad) {
      const result = await feature.onHostRequest('create', {
        turn: 1, role: 'user', quote: 'q', occurrence: 0, ...over,
      });
      assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(over)}`);
      assert.equal(result.code, 'invalid_payload');
    }
  });

  it('create 幂等：同锚位返回已有条目（duplicate: true），不重复入账、不发事件', async () => {
    const { client, feature } = makeFeature();
    const first = await createVia(feature);
    const second = await feature.onHostRequest('create', {
      turn: first.turn, role: first.role, quote: first.quote, occurrence: first.occurrence,
    });
    assert.equal(second.ok, true);
    assert.equal(second.duplicate, true);
    assert.equal((second.annotation as AnnotationRecord).id, first.id);
    const list = await feature.onHostRequest('list', {});
    assert.equal((list.annotations as AnnotationRecord[]).length, 1);
    assert.equal(client.events.length, 1, '幂等命中不发 created 事件');
  });

  it('create 成功发布 created 事件；发布失败静默不影响入账', async () => {
    const { client, feature } = makeFeature();
    const record = await createVia(feature, { quote: '事件内容' });
    assert.deepEqual(client.events, [{ eventType: 'created', data: { ...record } }]);
    client.failPublish = true;
    const silent = await createVia(feature, { quote: '静默发布失败' });
    assert.equal(silent.id.length > 0, true);
    const list = await feature.onHostRequest('list', {});
    assert.equal((list.annotations as AnnotationRecord[]).length, 2);
  });

  it('remove：不存在返回 annotation_not_found；存在删除并发布 removed 事件', async () => {
    const { client, feature } = makeFeature();
    const missing = await feature.onHostRequest('remove', { id: 'nope' });
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'annotation_not_found');
    const record = await createVia(feature);
    const removed = await feature.onHostRequest('remove', { id: record.id });
    assert.equal(removed.ok, true);
    assert.deepEqual(client.events.at(-1), { eventType: 'removed', data: { id: record.id } });
    const list = await feature.onHostRequest('list', {});
    assert.equal((list.annotations as AnnotationRecord[]).length, 0);
  });

  it('unknown requestType 返回 operation_unavailable', async () => {
    const { feature } = makeFeature();
    const result = await feature.onHostRequest('update', {});
    assert.equal(result.ok, false);
    assert.equal(result.code, 'operation_unavailable');
  });
});

describe('轮次边界跟踪', () => {
  it('CallStart 记录 N-1（user 消息落位前），StepFinish 记录 N，单调 max', async () => {
    const { feature } = makeFeature();
    await feature.trackCallIndexAtStart({ agent: { _callIndex: 7 } } as never);
    let snapshot = feature.captureState() as { lastCallIndex: number };
    assert.equal(snapshot.lastCallIndex, 6, 'checkpoint 捕获时刻的幸存边界');
    await feature.trackCallIndexAtStep({ callIndex: 7 } as never);
    await feature.trackCallIndexAtStart({ agent: { _callIndex: 8 } } as never);
    await feature.trackCallIndexAtStep({ callIndex: 5 } as never); // 不回退
    snapshot = feature.captureState() as { lastCallIndex: number };
    assert.equal(snapshot.lastCallIndex, 7);
  });
});

describe('declareContinuity 包装', () => {
  function makeWrapped() {
    const client = new FakeChannelClient();
    const feature = new ConversationAnnotationsFeature({
      agentId: 'ph', sessionId: 's1', serverOrigin: 'http://127.0.0.1:1420', client,
    });
    return { client, feature };
  }

  it('captureState 携带 continuity 字段；restoreState 剥离后正常替换', async () => {
    const { feature } = makeWrapped();
    const snapshot = feature.captureState() as Record<string, unknown>;
    assert.ok(CONTINUITY_FIELD_KEY in snapshot, 'continuity 描述符随快照导出');
    const result = await feature.onHostRequest('create', { turn: 1, role: 'user', quote: '包装后可用', occurrence: 0 });
    assert.equal(result.ok, true);
    // 新实例恢复（带 continuity 字段的完整快照）。
    const { feature: next } = makeWrapped();
    await next.restoreState(feature.captureState() as never);
    const list = await next.onHostRequest('list', {});
    assert.equal((list.annotations as AnnotationRecord[]).length, 1);
  });

  it('包装类 rollback 合并语义与 Inner 一致', async () => {
    const { feature } = makeWrapped();
    await feature.restoreState({ annotations: [], lastCallIndex: 10 } as never);
    await feature.onHostRequest('create', { turn: 5, role: 'user', quote: '幸存', occurrence: 0 });
    await feature.onHostRequest('create', { turn: 9, role: 'user', quote: '消亡', occurrence: 0 });
    await feature.restoreState({ annotations: [], lastCallIndex: 6 } as never);
    const list = await feature.onHostRequest('list', {});
    const turns = (list.annotations as AnnotationRecord[]).map((a) => a.turn);
    assert.deepEqual(turns.sort((a, b) => a - b), [5]);
  });
});
