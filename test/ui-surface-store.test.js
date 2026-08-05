/**
 * UISurfaceStore 测试
 *
 * 验证：revision 递增、contentHash 幂等、Agent 隔离、
 * close 幂等、action 校验、eventId 去重、会话清理。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { UISurfaceStore, computeContentHash } from '../server/ui-surface-store.js';

// ── 测试用的合法 Spec ──

function makeSpec(title = 'Test') {
  return {
    schemaVersion: 1,
    catalogVersion: 'v1',
    title,
    root: 'root',
    elements: {
      root: { type: 'Stack', props: { gap: 'md' }, children: ['text'] },
      text: { type: 'Text', props: { content: 'Hello' }, children: [] },
    },
  };
}

function makeSpecWithAction() {
  return {
    schemaVersion: 1,
    catalogVersion: 'v1',
    title: 'Form',
    root: 'root',
    elements: {
      root: { type: 'Stack', props: {}, children: ['input', 'btn'] },
      input: { type: 'TextInput', props: { name: 'value', label: 'Value' }, children: [] },
      btn: { type: 'Button', props: { label: 'Submit', actionId: 'submit' }, children: [] },
    },
    actions: {
      submit: { intent: 'submit', label: 'Submit', includeFields: ['value'] },
    },
  };
}

describe('UISurfaceStore', () => {
  let store;

  beforeEach(() => {
    store = new UISurfaceStore({ maxSurfaces: 3 });
  });

  describe('upsert — revision', () => {
    it('首次创建返回 revision 1', () => {
      const { record, changed } = store.upsert('agent-a', 'page1', makeSpec());
      assert.ok(changed);
      assert.equal(record.revision, 1);
      assert.equal(record.status, 'active');
    });

    it('相同 surfaceId 不同内容递增 revision', () => {
      store.upsert('agent-a', 'page1', makeSpec('V1'));
      const { record, changed } = store.upsert('agent-a', 'page1', makeSpec('V2'));
      assert.ok(changed);
      assert.equal(record.revision, 2);
    });

    it('expectedRevision 匹配时成功', () => {
      const { record: r1 } = store.upsert('agent-a', 'page1', makeSpec());
      const { record: r2, conflict } = store.upsert('agent-a', 'page1', makeSpec('V2'), {
        expectedRevision: r1.revision,
      });
      assert.equal(conflict, null);
      assert.equal(r2.revision, 2);
    });

    it('expectedRevision 不匹配时返回 conflict', () => {
      store.upsert('agent-a', 'page1', makeSpec());
      const { conflict } = store.upsert('agent-a', 'page1', makeSpec('V2'), {
        expectedRevision: 99,
      });
      assert.equal(conflict, 'revision_conflict');
    });
  });

  describe('upsert — 幂等', () => {
    it('相同内容不递增 revision', () => {
      const spec = makeSpec();
      const { record: r1 } = store.upsert('agent-a', 'page1', spec);
      const { record: r2, changed } = store.upsert('agent-a', 'page1', spec);
      assert.ok(!changed);
      assert.equal(r2.revision, r1.revision);
    });

    it('contentHash 相同的内容被视为相同', () => {
      const spec1 = makeSpec('Same');
      const spec2 = makeSpec('Same');
      // 不同的对象引用，相同内容
      store.upsert('agent-a', 'page1', spec1);
      const { changed } = store.upsert('agent-a', 'page1', spec2);
      assert.ok(!changed);
    });
  });

  describe('Agent 隔离', () => {
    it('不同 agent 的 surface 不串台', () => {
      store.upsert('agent-a', 'page1', makeSpec('A'));
      store.upsert('agent-b', 'page1', makeSpec('B'));

      const aRecord = store.get('agent-a', 'page1');
      const bRecord = store.get('agent-b', 'page1');

      assert.equal(aRecord.spec.title, 'A');
      assert.equal(bRecord.spec.title, 'B');
      assert.equal(aRecord.revision, 1);
      assert.equal(bRecord.revision, 1);
    });

    it('list 只返回对应 agent 的 surface', () => {
      store.upsert('agent-a', 'page1', makeSpec());
      store.upsert('agent-a', 'page2', makeSpec());
      store.upsert('agent-b', 'page3', makeSpec());

      const { surfaces: aList } = store.list('agent-a');
      const { surfaces: bList } = store.list('agent-b');

      assert.equal(aList.length, 2);
      assert.equal(bList.length, 1);
    });

    it('clearAgent 只清理指定 agent', () => {
      store.upsert('agent-a', 'page1', makeSpec());
      store.upsert('agent-b', 'page1', makeSpec());

      store.clearAgent('agent-a');

      assert.equal(store.get('agent-a', 'page1'), null);
      assert.ok(store.get('agent-b', 'page1'));
    });

    it('clearAgent 同时释放该 agent 的 action 幂等记录', () => {
      const eventKey = `agent-a\u0000surface\u0000save\u0000event-1`;
      assert.deepEqual(store.beginEvent(eventKey), { accepted: true });
      store.completeEvent(eventKey, { ok: true });

      store.clearAgent('agent-a');

      assert.deepEqual(store.beginEvent(eventKey), { accepted: true });
    });
  });

  describe('close — 幂等', () => {
    it('关闭后再关闭返回 alreadyClosed', () => {
      store.upsert('agent-a', 'page1', makeSpec());

      const r1 = store.close('agent-a', 'page1');
      assert.ok(r1.ok);
      assert.ok(!r1.alreadyClosed);

      const r2 = store.close('agent-a', 'page1');
      assert.ok(r2.ok);
      assert.ok(r2.alreadyClosed);
    });

    it('关闭不存在的 surface 也返回 ok', () => {
      const r = store.close('agent-a', 'ghost');
      assert.ok(r.ok);
      assert.ok(r.alreadyClosed);
    });

    it('关闭后 list 默认不返回', () => {
      store.upsert('agent-a', 'page1', makeSpec());
      store.close('agent-a', 'page1');

      const { surfaces } = store.list('agent-a');
      assert.equal(surfaces.length, 0);

      const { surfaces: closedList } = store.list('agent-a', { includeClosed: true });
      assert.equal(closedList.length, 1);
    });
  });

  describe('surface limit', () => {
    it('超过上限返回 surface_limit', () => {
      store.upsert('agent-a', 'p1', makeSpec());
      store.upsert('agent-a', 'p2', makeSpec());
      store.upsert('agent-a', 'p3', makeSpec());

      const { record, conflict } = store.upsert('agent-a', 'p4', makeSpec());
      assert.equal(conflict, 'surface_limit');
      assert.equal(record, null);
    });

    it('关闭一个后可以新建', () => {
      store.upsert('agent-a', 'p1', makeSpec());
      store.upsert('agent-a', 'p2', makeSpec());
      store.upsert('agent-a', 'p3', makeSpec());
      store.close('agent-a', 'p1');

      const { record, conflict } = store.upsert('agent-a', 'p4', makeSpec());
      assert.equal(conflict, null);
      assert.ok(record);
    });
  });

  describe('validateAction', () => {
    it('合法 action 通过', () => {
      store.upsert('agent-a', 'form', makeSpecWithAction());
      const result = store.validateAction('agent-a', 'form', 'submit', 1, { value: 'test' });
      assert.ok(result.valid);
      assert.equal(result.action.intent, 'submit');
    });

    it('不存在的 action 被拒', () => {
      store.upsert('agent-a', 'form', makeSpecWithAction());
      const result = store.validateAction('agent-a', 'form', 'ghost-action', 1, {});
      assert.ok(!result.valid);
      assert.equal(result.error, 'action_not_found');
    });

    it('stale revision 被拒', () => {
      store.upsert('agent-a', 'form', makeSpecWithAction());
      const result = store.validateAction('agent-a', 'form', 'submit', 99, {});
      assert.ok(!result.valid);
      assert.equal(result.error, 'stale_surface');
    });

    it('不在 includeFields 中的字段被拒', () => {
      store.upsert('agent-a', 'form', makeSpecWithAction());
      const result = store.validateAction('agent-a', 'form', 'submit', 1, { value: 'ok', secret: 'leaked' });
      assert.ok(!result.valid);
      assert.equal(result.error, 'field_not_allowed');
    });

    it('显式空 includeFields 的 action 不接受字段', () => {
      const spec = makeSpecWithAction();
      spec.actions.submit.includeFields = [];
      store.upsert('agent-a', 'form', spec);
      const result = store.validateAction('agent-a', 'form', 'submit', 1, { value: 'leak' });
      assert.ok(!result.valid);
      assert.equal(result.error, 'field_not_allowed');
    });

    it('未声明 includeFields 时接受当前 Surface 的全部已声明字段', () => {
      const spec = makeSpecWithAction();
      delete spec.actions.submit.includeFields;
      store.upsert('agent-a', 'form', spec);

      const accepted = store.validateAction('agent-a', 'form', 'submit', 1, { value: 'prefilled value' });
      assert.ok(accepted.valid);
      assert.deepEqual(accepted.allowedFields, ['value']);

      const rejected = store.validateAction('agent-a', 'form', 'submit', 1, { value: 'ok', secret: 'leaked' });
      assert.ok(!rejected.valid);
      assert.equal(rejected.error, 'field_not_allowed');
    });

    it('未声明 includeFields 时识别第一批新增输入组件', () => {
      const spec = {
        schemaVersion: 1,
        catalogVersion: 'v1',
        title: 'Extended form',
        root: 'root',
        elements: {
          root: { type: 'Stack', props: {}, children: ['date', 'slider', 'switch', 'segment', 'submit'] },
          date: { type: 'DateInput', props: { name: 'releaseDate' }, children: [] },
          slider: { type: 'Slider', props: { name: 'rollout', min: 0, max: 100 }, children: [] },
          switch: { type: 'Switch', props: { name: 'notify', label: 'Notify' }, children: [] },
          segment: { type: 'SegmentedControl', props: { name: 'mode', options: [{ value: 'safe', label: 'Safe' }] }, children: [] },
          submit: { type: 'Button', props: { label: 'Apply', actionId: 'apply' }, children: [] },
        },
        actions: { apply: { intent: 'submit', label: 'Apply' } },
      };
      store.upsert('agent-a', 'extended', spec);
      const result = store.validateAction('agent-a', 'extended', 'apply', 1, {
        releaseDate: '2026-08-05', rollout: 40, notify: true, mode: 'safe',
      });
      assert.ok(result.valid);
      assert.deepEqual(result.allowedFields, ['releaseDate', 'rollout', 'notify', 'mode']);
    });

    it('关闭的 surface 拒绝 action', () => {
      store.upsert('agent-a', 'form', makeSpecWithAction());
      store.close('agent-a', 'form');
      const result = store.validateAction('agent-a', 'form', 'submit', 1, {});
      assert.ok(!result.valid);
      assert.equal(result.error, 'surface_closed');
    });
  });

  describe('eventId 去重', () => {
    it('首次 eventId 返回 true', () => {
      assert.ok(store.checkAndRecordEvent('evt-1'));
    });

    it('重复 eventId 返回 false', () => {
      store.checkAndRecordEvent('evt-1');
      assert.ok(!store.checkAndRecordEvent('evt-1'));
    });

    it('不同 eventId 各自独立', () => {
      assert.ok(store.checkAndRecordEvent('evt-1'));
      assert.ok(store.checkAndRecordEvent('evt-2'));
      assert.ok(!store.checkAndRecordEvent('evt-1'));
    });

    it('完成事件可回放相同结果', () => {
      assert.deepEqual(store.beginEvent('evt-replay'), { accepted: true });
      store.completeEvent('evt-replay', { ok: true, requestId: 'input-1' });
      assert.deepEqual(store.beginEvent('evt-replay'), {
        accepted: false,
        status: 'completed',
        result: { ok: true, requestId: 'input-1' },
      });
    });

    it('投递失败释放预占后允许相同事件重试', () => {
      assert.deepEqual(store.beginEvent('evt-retry'), { accepted: true });
      store.releaseEvent('evt-retry');
      assert.deepEqual(store.beginEvent('evt-retry'), { accepted: true });
    });
  });

  describe('computeContentHash', () => {
    it('相同内容返回相同 hash', () => {
      const spec = makeSpec();
      const h1 = computeContentHash(spec, { open: 'if-empty' });
      const h2 = computeContentHash(spec, { open: 'if-empty' });
      assert.equal(h1, h2);
    });

    it('不同内容返回不同 hash', () => {
      const h1 = computeContentHash(makeSpec('A'), { open: 'if-empty' });
      const h2 = computeContentHash(makeSpec('B'), { open: 'if-empty' });
      assert.notEqual(h1, h2);
    });

    it('不同 presentation 返回不同 hash', () => {
      const spec = makeSpec();
      const h1 = computeContentHash(spec, { open: 'if-empty' });
      const h2 = computeContentHash(spec, { open: 'never' });
      assert.notEqual(h1, h2);
    });
  });
});
