import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  declareContinuity,
  GENERIC_CONTINUITY_PROTOCOL,
  CONTINUITY_FIELD_KEY,
} from '../src/index.js';

/**
 * 模拟框架自带 Feature（类似 OpencodeBasicFeature）：
 * - onInitiate 会清空内部状态（模拟 readFiles.clear()）
 * - captureState/restoreState 正常存取
 */
function createFeatureWithClearingOnInitiate(featureName: string): any {
  return class MockFeature {
    readonly name = featureName;
    private _state: Record<string, unknown> = {};
    private _initCallCount = 0;

    async onInitiate(): Promise<void> {
      this._initCallCount += 1;
      // 模拟 OpencodeBasicFeature.onInitiate 的清空行为
      this._state = {};
    }

    captureState() {
      return { ...this._state };
    }

    restoreState(snapshot: any) {
      this._state = { ...(snapshot || {}) };
    }
  };
}

describe('declareContinuity onInitiate protection', () => {
  it('preserves restored state across onInitiate when restoreState was called', async () => {
    const Wrapped: any = declareContinuity(
      createFeatureWithClearingOnInitiate('mock-feature'),
      { protocol: GENERIC_CONTINUITY_PROTOCOL, importMode: 'replace' },
    );

    const feature: any = new Wrapped();

    // 模拟 importFeatureContinuity 调用 restoreState
    feature.restoreState({ readFiles: ['/repo/a.ts', '/repo/b.ts'] });

    // 在 onInitiate 之前，状态应该已恢复
    assert.deepEqual(feature.captureState().readFiles, ['/repo/a.ts', '/repo/b.ts']);

    // 触发 onInitiate（模拟 agent 首次 onCall）
    await feature.onInitiate({});

    // 关键断言：onInitiate 不应清空已恢复的状态
    assert.deepEqual(
      feature.captureState().readFiles,
      ['/repo/a.ts', '/repo/b.ts'],
      'readFiles should survive onInitiate when previously restored',
    );
    // descriptor 字段也应保留
    assert.equal(
      feature.captureState()[CONTINUITY_FIELD_KEY].protocol,
      GENERIC_CONTINUITY_PROTOCOL,
    );
  });

  it('does not interfere with onInitiate default behavior on fresh session', async () => {
    const Wrapped: any = declareContinuity(
      createFeatureWithClearingOnInitiate('mock-feature'),
      { protocol: GENERIC_CONTINUITY_PROTOCOL, importMode: 'replace' },
    );

    const feature: any = new Wrapped();
    // 不调 restoreState

    await feature.onInitiate({});

    const state = feature.captureState();
    // descriptor 仍然注入（包装类行为）
    assert.equal(state[CONTINUITY_FIELD_KEY].protocol, GENERIC_CONTINUITY_PROTOCOL);
    // 业务状态为空（onInitiate 清空生效，没有被 buffer+restore 干预）
    assert.deepEqual(state.readFiles, undefined);
  });

  it('restores state correctly when snapshot carries __claw_continuity__ field', async () => {
    const Wrapped: any = declareContinuity(
      createFeatureWithClearingOnInitiate('mock-feature'),
      { protocol: GENERIC_CONTINUITY_PROTOCOL, importMode: 'replace' },
    );

    const source: any = new Wrapped();
    source.restoreState({ readFiles: ['/x.ts'] });
    const snapshot = source.captureState();
    assert.ok(CONTINUITY_FIELD_KEY in snapshot);

    const target: any = new Wrapped();
    target.restoreState(snapshot);
    assert.deepEqual(target.captureState().readFiles, ['/x.ts']);

    await target.onInitiate({});
    assert.deepEqual(target.captureState().readFiles, ['/x.ts']);
  });
});
