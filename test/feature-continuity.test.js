import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyContinuityToolPolicy,
  exportFeatureContinuity,
  importFeatureContinuity,
} from '../server/context-continuity/feature-continuity.js';
import {
  declareContinuity,
  GENERIC_CONTINUITY_PROTOCOL,
  OPENCODE_BASIC_CONTINUITY_PROTOCOL,
  CONTINUITY_FIELD_KEY,
} from '../local-features/dist/continuity-participant/src/index.js';

const TODO_PROTOCOL = 'claw.todo-continuity.v1';

/**
 * 构造一个最小可用的 mock feature base class，模拟框架自带 feature 的形态。
 * 用真实的 declareContinuity 包装它，端到端验证 continuity 协议链路。
 */
function createMockBase({ featureName, initialState = {} }) {
  return class MockBase {
    constructor() {
      this._state = { ...initialState };
    }
    get name() {
      return featureName;
    }
    captureState() {
      return { ...this._state };
    }
    restoreState(snapshot) {
      this._state = { ...(snapshot || {}) };
    }
  };
}

describe('feature continuity protocol (descriptor-driven)', () => {
  it('exports todo state when snapshot carries continuity descriptor', () => {
    const sessionSnapshot = {
      runtime: {
        featureStates: [
          {
            featureName: 'todo',
            snapshot: {
              tasks: [
                {
                  id: '1',
                  subject: 'Keep the plan',
                  description: 'This should survive compact/trim.',
                  status: 'in_progress',
                  createdAt: 10,
                  updatedAt: 20,
                },
              ],
              counter: 1,
              reminderInjected: true,
              [CONTINUITY_FIELD_KEY]: { protocol: TODO_PROTOCOL, importMode: 'replace' },
            },
          },
        ],
      },
    };

    const continuity = exportFeatureContinuity(sessionSnapshot, { mode: 'trim-transcript' });

    assert.equal(continuity.schemaVersion, 1);
    assert.equal(continuity.mode, 'trim-transcript');
    assert.equal(continuity.states.length, 1);
    assert.equal(continuity.states[0].featureName, 'todo');
    assert.equal(continuity.states[0].protocol, TODO_PROTOCOL);
    assert.equal(continuity.states[0].state.tasks[0].subject, 'Keep the plan');
    // export adapter 应剥离 __claw_continuity__ 字段，state 内不应再见 descriptor
    assert.equal(continuity.states[0].state[CONTINUITY_FIELD_KEY], undefined);
    assert.ok(continuity.toolPolicy.preserveToolNames.length === 0 ||
      !continuity.toolPolicy.preserveToolNames.includes('task_update'),
      'task_update should no longer be in protected tools');
  });

  it('merges protected tool names into an existing export policy', () => {
    const policy = applyContinuityToolPolicy({
      preserveToolNames: ['invoke_skill', 'task_update'],
    });

    // Todo tools are no longer protected; only the caller's own list should remain
    assert.deepEqual(
      [...policy.preserveToolNames].sort(),
      ['invoke_skill', 'task_update'].sort(),
    );
  });

  it('imports todo state when agent feature declares matching protocol', async () => {
    let restored = null;
    const agent = {
      features: new Map([
        ['todo', {
          name: 'todo',
          getContinuityDescriptor() {
            return { protocol: TODO_PROTOCOL, importMode: 'replace' };
          },
          restoreState(snapshot) {
            restored = snapshot;
          },
        }],
      ]),
    };

    const imported = await importFeatureContinuity(agent, {
      states: [
        {
          featureName: 'todo',
          protocol: TODO_PROTOCOL,
          state: {
            tasks: [
              { id: '7', subject: 'Resume me', status: 'completed' },
            ],
            counter: 7,
          },
        },
      ],
    }, { sourceSessionId: 'session-source' });

    assert.deepEqual(imported, ['todo']);
    assert.equal(restored.tasks[0].subject, 'Resume me');
    // todo import adapter 注入 metadata
    assert.equal(restored.metadata.importedBy, 'claw-continuity');
    assert.equal(restored.metadata.sourceSessionId, 'session-source');
  });

  it('end-to-end: opencode-basic preserves write authorization but resets read deduplication on resume', async () => {
    // 模拟真实 OpencodeBasic 快照：readFiles 是修改授权，readDedupState 则依赖旧工具结果。
    const ContinuityAwareMock = declareContinuity(
      createMockBase({ featureName: 'opencode-basic', initialState: { readFiles: [] } }),
      { protocol: OPENCODE_BASIC_CONTINUITY_PROTOCOL, importMode: 'replace' },
    );

    const sourceFeature = new ContinuityAwareMock();
    sourceFeature._state.readFiles = ['D:/repo/a.ts', 'D:/repo/b.ts'];
    sourceFeature._state.readDedupState = {
      'D:/repo/a.ts': { mtimeMs: 123, offset: 1, limit: undefined },
    };

    const sourceSnapshot = sourceFeature.captureState();
    assert.equal(sourceSnapshot[CONTINUITY_FIELD_KEY].protocol, OPENCODE_BASIC_CONTINUITY_PROTOCOL);

    const continuity = exportFeatureContinuity({
      runtime: {
        featureStates: [{ featureName: 'opencode-basic', snapshot: sourceSnapshot }],
      },
    }, { mode: 'summarized-nine-section' });

    assert.equal(continuity.states.length, 1);
    assert.equal(continuity.states[0].featureName, 'opencode-basic');
    assert.equal(continuity.states[0].protocol, OPENCODE_BASIC_CONTINUITY_PROTOCOL);
    assert.deepEqual(continuity.states[0].state, {
      readFiles: ['D:/repo/a.ts', 'D:/repo/b.ts'],
    });

    const targetFeature = new ContinuityAwareMock();
    const agent = { features: new Map([['opencode-basic', targetFeature]]) };
    const imported = await importFeatureContinuity(agent, continuity, { sourceSessionId: 'src' });

    assert.deepEqual(imported, ['opencode-basic']);
    assert.deepEqual(targetFeature._state, {
      readFiles: ['D:/repo/a.ts', 'D:/repo/b.ts'],
    });
  });

  it('skips features whose snapshot lacks continuity descriptor', () => {
    // 框架自带的 OpencodeBasicFeature（未包装）snapshot 里没有 descriptor 字段，不会被采集
    const sessionSnapshot = {
      runtime: {
        featureStates: [
          { featureName: 'opencode-basic', snapshot: { readFiles: ['x.ts'] } },
          {
            featureName: 'todo',
            snapshot: {
              tasks: [{ id: '1', subject: 'p', status: 'in_progress', createdAt: 1, updatedAt: 1 }],
              [CONTINUITY_FIELD_KEY]: { protocol: TODO_PROTOCOL },
            },
          },
        ],
      },
    };

    const continuity = exportFeatureContinuity(sessionSnapshot, { mode: 'handoff' });

    assert.equal(continuity.states.length, 1);
    assert.equal(continuity.states[0].featureName, 'todo');
  });

  it('skips import when agent feature does not declare getContinuityDescriptor', async () => {
    // 新 runtime 装配了未包装的原版 feature（无 getContinuityDescriptor 方法），不应误投数据
    let restoreCalls = 0;
    const agent = {
      features: new Map([
        ['opencode-basic', {
          name: 'opencode-basic',
          restoreState() { restoreCalls += 1; },
          // 故意不提供 getContinuityDescriptor
        }],
      ]),
    };

    const imported = await importFeatureContinuity(agent, {
      states: [
        {
          featureName: 'opencode-basic',
          protocol: GENERIC_CONTINUITY_PROTOCOL,
          state: { readFiles: ['x.ts'] },
        },
      ],
    }, {});

    assert.deepEqual(imported, []);
    assert.equal(restoreCalls, 0);
  });

  it('skips import when agent feature declares a different protocol', async () => {
    let restoreCalls = 0;
    const agent = {
      features: new Map([
        ['opencode-basic', {
          name: 'opencode-basic',
          getContinuityDescriptor() {
            // 当前 runtime 改用了不同的 protocol
            return { protocol: 'claw.some-future-protocol.v2' };
          },
          restoreState() { restoreCalls += 1; },
        }],
      ]),
    };

    const imported = await importFeatureContinuity(agent, {
      states: [
        {
          featureName: 'opencode-basic',
          protocol: GENERIC_CONTINUITY_PROTOCOL,
          state: { readFiles: [] },
        },
      ],
    }, {});

    assert.deepEqual(imported, []);
    assert.equal(restoreCalls, 0);
  });

  it('drops todo continuity when tasks list is empty (normalizeExportState returns null)', () => {
    const sessionSnapshot = {
      runtime: {
        featureStates: [
          {
            featureName: 'todo',
            snapshot: {
              tasks: [],
              counter: 0,
              [CONTINUITY_FIELD_KEY]: { protocol: TODO_PROTOCOL },
            },
          },
        ],
      },
    };

    const continuity = exportFeatureContinuity(sessionSnapshot, { mode: 'handoff' });
    assert.equal(continuity.states.length, 0);
  });

  it('end-to-end: ControlledTodoFeature-style double-inheritance preserves interruptTargetId', async () => {
    // 模拟 ControlledTodoFeature 的两层继承：inner 加 interruptTargetId，外层 declareContinuity 加 descriptor
    const TodoInner = class extends createMockBase({
      featureName: 'todo',
      initialState: { tasks: [], counter: 0 },
    }) {
      constructor() {
        super();
        this._interruptTargetId = null;
      }
      captureState() {
        const base = super.captureState();
        return { ...base, interruptTargetId: this._interruptTargetId };
      }
      restoreState(snapshot) {
        super.restoreState(snapshot);
        this._interruptTargetId = snapshot?.interruptTargetId || null;
      }
    };

    const ControlledTodo = declareContinuity(TodoInner, {
      protocol: TODO_PROTOCOL,
      importMode: 'replace',
    });

    const sourceFeature = new ControlledTodo();
    sourceFeature._state.tasks = [{ id: '1', subject: 'task', status: 'in_progress' }];
    sourceFeature._state.counter = 1;
    sourceFeature._interruptTargetId = 'task-1';

    const snapshot = sourceFeature.captureState();
    // 三个字段都在：原 state + interruptTargetId + descriptor
    assert.equal(snapshot.tasks.length, 1);
    assert.equal(snapshot.interruptTargetId, 'task-1');
    assert.equal(snapshot[CONTINUITY_FIELD_KEY].protocol, TODO_PROTOCOL);

    const continuity = exportFeatureContinuity({
      runtime: { featureStates: [{ featureName: 'todo', snapshot }] },
    }, { mode: 'trim-transcript' });

    assert.equal(continuity.states.length, 1);
    // todo export adapter 重新 normalize，所以 interruptTargetId 字段会被丢弃
    // （adapter 只保留 tasks/counter/reminderContent/consecutiveNoTodoTurns/reminderInjected）
    // 这是预期行为：todo protocol 的 state schema 不包含 interruptTargetId
    assert.equal(continuity.states[0].state.tasks[0].subject, 'task');
    assert.equal(continuity.states[0].state[CONTINUITY_FIELD_KEY], undefined);

    // 模拟新 runtime 恢复
    const targetFeature = new ControlledTodo();
    const agent = { features: new Map([['todo', targetFeature]]) };

    await importFeatureContinuity(agent, continuity, { sourceSessionId: 's' });

    assert.equal(targetFeature._state.tasks.length, 1);
    assert.equal(targetFeature._state.tasks[0].subject, 'task');
  });
});

/**
 * 显式契约测试：todo continuity 导出适配器的字段保留/丢弃规则。
 *
 * normalizeTodoExportState 会重建 state 对象，只保留特定字段。
 * 此测试将该"预期丢弃"行为固化为受保护的契约，
 * 防止未来有人误以为是 bug 而改动，也防止新增字段时被意外遗漏。
 */
describe('todo continuity export adapter field contract', () => {
  function buildTodoSnapshotWithAllFields() {
    return {
      tasks: [
        { id: '1', subject: '任务一', description: '描述', status: 'in_progress' },
        { id: '2', subject: '任务二', description: '描述', status: 'pending' },
      ],
      counter: 5,
      reminderContent: '请使用 todo 工具',
      consecutiveNoTodoTurns: 3,
      reminderInjected: true,
      // 以下字段由 ControlledTodoFeature 扩展，预期在导出时被丢弃
      interruptTargetId: '2',
      [CONTINUITY_FIELD_KEY]: { protocol: TODO_PROTOCOL, importMode: 'replace' },
    };
  }

  function exportTodo(snapshot) {
    return exportFeatureContinuity({
      runtime: {
        featureStates: [{ featureName: 'todo', snapshot }],
      },
    }, { mode: 'trim-transcript' });
  }

  it('preserves tasks and counter', () => {
    const continuity = exportTodo(buildTodoSnapshotWithAllFields());
    const state = continuity.states[0].state;

    assert.equal(state.tasks.length, 2);
    assert.equal(state.tasks[0].subject, '任务一');
    assert.equal(state.tasks[1].status, 'pending');
    assert.equal(state.counter, 5);
  });

  it('preserves reminderContent when present', () => {
    const continuity = exportTodo(buildTodoSnapshotWithAllFields());
    const state = continuity.states[0].state;

    assert.equal(state.reminderContent, '请使用 todo 工具');
  });

  it('resets consecutiveNoTodoTurns to 0 (not carried over)', () => {
    const continuity = exportTodo(buildTodoSnapshotWithAllFields());
    const state = continuity.states[0].state;

    assert.equal(state.consecutiveNoTodoTurns, 0);
  });

  it('resets reminderInjected to false (not carried over)', () => {
    const continuity = exportTodo(buildTodoSnapshotWithAllFields());
    const state = continuity.states[0].state;

    assert.equal(state.reminderInjected, false);
  });

  it('drops interruptTargetId (not in todo continuity schema)', () => {
    const continuity = exportTodo(buildTodoSnapshotWithAllFields());
    const state = continuity.states[0].state;

    // interruptTargetId 是运行时中断状态，不属于可转移的计划数据
    assert.equal(state.interruptTargetId, undefined);
  });

  it('drops __claw_continuity__ descriptor field', () => {
    const continuity = exportTodo(buildTodoSnapshotWithAllFields());
    const state = continuity.states[0].state;

    assert.equal(state[CONTINUITY_FIELD_KEY], undefined);
  });

  it('recognizes legacy __claw_continuity__ snapshots (read-old write-new)', () => {
    // 切换前持久化的会话快照：descriptor 挂在旧字段 key 下。
    // exportFeatureContinuity 仍应识别它、按 protocol 应用 adapter，并剥离旧 key。
    const legacySnapshot = {
      runtime: {
        featureStates: [
          {
            featureName: 'todo',
            snapshot: {
              tasks: [{
                id: '1',
                subject: 'Legacy snapshot task',
                description: '',
                status: 'pending',
                createdAt: 1,
                updatedAt: 2,
              }],
              counter: 1,
              __claw_continuity__: { protocol: TODO_PROTOCOL, importMode: 'replace' },
            },
          },
        ],
      },
    };

    const continuity = exportFeatureContinuity(legacySnapshot, { mode: 'trim-transcript' });

    assert.equal(continuity.states.length, 1, 'legacy-key descriptor should still be exported');
    assert.equal(continuity.states[0].protocol, TODO_PROTOCOL);
    assert.equal(continuity.states[0].state.tasks[0].subject, 'Legacy snapshot task');
    // 旧 key 与新 key 都不应出现在转移后的 state 里
    assert.equal(continuity.states[0].state.__claw_continuity__, undefined);
    assert.equal(continuity.states[0].state[CONTINUITY_FIELD_KEY], undefined);
  });

  it('skips entry entirely when tasks are empty (returns null)', () => {
    const snapshot = buildTodoSnapshotWithAllFields();
    snapshot.tasks = [];

    const continuity = exportTodo(snapshot);

    // tasks 为空时 adapter 返回 null，整个 todo entry 不出现在 continuity 中
    assert.equal(continuity.states.length, 0);
  });
});
