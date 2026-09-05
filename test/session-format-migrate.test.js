import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { migrateSessionContent, SESSION_FORMAT_VERSION } from '../scripts/migrate-session-format.mjs';

function v2SessionPretty() {
  return JSON.stringify({
    version: 2,
    sessionId: 'session-1',
    savedAt: 1785000000000,
    agentType: 'ProgrammingHelperAgent',
    runtime: {
      initialized: true,
      callIndex: 1,
      context: {
        version: 2,
        messages: [{ role: 'user', content: 'hello' }],
        enrichedMessages: [{ role: 'user', content: 'hello', id: 'm1', timestamp: 1, turn: 0, sequence: 0, tags: [] }],
        sequence: 1,
      },
      featureStates: [],
      usageStats: { totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
    },
    rollbackHistory: [
      { kind: 'context-boundary', callIndex: 1, draftInput: '', contextBoundary: { messageCount: 1, enrichedCount: 1 }, runtimeState: { initialized: true, callIndex: 1, featureStates: [] } },
    ],
  }, null, 2);
}

describe('migrateSessionContent (v2 -> v2.1)', () => {
  it('转换 v2 会话为 v2.1 紧凑格式，且 roundtrip 深等价', () => {
    const raw = v2SessionPretty();
    const result = migrateSessionContent(raw);

    assert.equal(result.ok, true, result.reason);
    assert.equal(result.migratedBytes, Buffer.byteLength(result.content));
    assert.ok(result.migratedBytes < result.originalBytes, '紧凑序列化必须更小');

    const migrated = JSON.parse(result.content);
    assert.equal(migrated.version, SESSION_FORMAT_VERSION);
    assert.equal(migrated.version, 2.1);

    const { version: _v, ...rest } = JSON.parse(raw);
    const { version: _v2, ...migratedRest } = migrated;
    assert.deepStrictEqual(migratedRest, rest);
  });

  it('输出为紧凑单行（无缩进空白）', () => {
    const result = migrateSessionContent(v2SessionPretty());
    assert.equal(result.ok, true, result.reason);
    assert.ok(!result.content.includes('\n'), '不允许换行');
    assert.ok(!result.content.includes('  "'), '不允许缩进空白');
  });

  it('拒绝 v1 会话（rollbackHistory 为全量快照语义，不在本脚本范围）', () => {
    const raw = JSON.stringify({
      version: 1,
      sessionId: 'session-legacy',
      savedAt: 1780000000000,
      agentType: 'ProgrammingHelperAgent',
      runtime: { initialized: true, callIndex: 0, context: { version: 2, messages: [] }, featureStates: [] },
      rollbackHistory: [{ callIndex: 0, draftInput: '', runtime: { initialized: true, callIndex: 0, context: { version: 2, messages: [] }, featureStates: [] } }],
    }, null, 2);
    const result = migrateSessionContent(raw);
    assert.equal(result.ok, false);
    assert.match(result.reason, /非 v2/);
  });

  it('拒绝非法 JSON 与缺少 runtime 的内容', () => {
    const bad = migrateSessionContent('{ not json');
    assert.equal(bad.ok, false);
    assert.match(bad.reason, /解析失败/);

    const noRuntime = migrateSessionContent(JSON.stringify({ version: 2, sessionId: 'x' }));
    assert.equal(noRuntime.ok, false);
    assert.match(noRuntime.reason, /runtime/);
  });

  it('保留嵌套结构原样（context / rollbackHistory 不做语义改动）', () => {
    const result = migrateSessionContent(v2SessionPretty());
    assert.equal(result.ok, true, result.reason);
    const migrated = JSON.parse(result.content);
    assert.equal(migrated.runtime.context.version, 2, '内部 ContextSnapshot 版本保持 2');
    assert.equal(migrated.rollbackHistory[0].kind, 'context-boundary');
    assert.equal(migrated.sessionId, 'session-1');
  });
});
