import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import { promises as fs } from 'fs';
import { runTrimTranscriptWithSummary } from '../server/context-continuity/trim-appended-summary.js';
import { writeTrimWithSummaryHandoffPackage } from '../server/context-continuity/handoff-package.js';

/**
 * 收敛回归（消费框架官方组合变换）：
 * 「trim 裁剪 + 摘要追加」组合语义的唯一权威是框架
 * TrimTranscriptWithSummaryTransformation；Claw 装配层只负责快照、
 * 模型注入（llm）、continuity 装饰与 handoff JSON v1 落盘。
 */

function buildSnapshot() {
  return {
    runtime: {
      context: {
        messages: [
          { role: 'system', content: '你是 coder' },
          { role: 'user', content: '帮我看看 server.js', turn: 0 },
          {
            role: 'assistant', content: '好的', turn: 0,
            toolCalls: [{ name: 'read', arguments: '{"filePath":"server.js"}' }],
          },
          { role: 'tool', toolCallId: 'tc1', content: '{"ok":true}', turn: 0 },
          { role: 'user', content: '继续', turn: 1 },
          { role: 'assistant', content: '完成', turn: 1 },
        ],
      },
      featureStates: [],
    },
  };
}

const stubLLM = { chat: async () => ({ content: 'MOCK_TRIM_APPENDED_SUMMARY' }) };

function runWith(snapshot, extra = {}) {
  return runTrimTranscriptWithSummary({
    agentRelativeDir: 'prebuilt-agents/official/x',
    agentId: 'x',
    sessionId: 's1',
    projectRoot: process.cwd(),
    sourceSessionSnapshot: snapshot,
    policy: {},
    llm: stubLLM,
    maxAttempts: 1,
    ...extra,
  });
}

describe('runTrimTranscriptWithSummary', () => {
  it('produces a SuccessorSeed with framework combination semantics', async () => {
    const seed = await runWith(buildSnapshot());

    assert.equal(seed.meta.mode, 'trim-transcript-with-summary');
    assert.equal(seed.meta.summaryText, 'MOCK_TRIM_APPENDED_SUMMARY');
    assert.equal(seed.meta.compilerVersion, 'trim-transcript-v1');

    // 摘要 seed 消息追加在 seedMessages 末尾
    const last = seed.seedMessages[seed.seedMessages.length - 1];
    assert.equal(last.role, 'system');
    assert.ok(last.content.includes('MOCK_TRIM_APPENDED_SUMMARY'));

    // trim 裁剪语义保留：无裸 tool 消息，折叠 note 存在
    assert.ok(seed.seedMessages.every((m) => m.role !== 'tool'));
    assert.ok(seed.seedMessages.some((m) => String(m.content || '').includes('[Folded tool activity]')));

    // policy 由框架归一化（trimPolicy 权威）
    assert.equal(typeof seed.meta.trimPolicy.foldedToolNoteRole, 'string');
    assert.ok(seed.meta.trimStats);
    assert.ok(Number.isFinite(seed.meta.trimStats.foldedToolCallCount));
  });

  it('forwards decorate-only policy keys through the framework trim policy', async () => {
    const seed = await runWith(buildSnapshot(), { policy: { preserveToolNames: ['todo'] } });
    assert.ok(seed.meta.trimPolicy.preserveToolNames.includes('todo'));
  });

  it('rejects empty message snapshots before touching the LLM', async () => {
    await assert.rejects(
      runWith({ runtime: { context: { messages: [] } } }),
      /no messages/,
    );
  });

  it('fails overall after exhausting retries', async () => {
    let calls = 0;
    const failing = {
      chat: async () => {
        calls += 1;
        throw new Error('boom');
      },
    };
    await assert.rejects(
      runWith(buildSnapshot(), { llm: failing, maxAttempts: 2, timeoutMs: 5000 }),
      /boom/,
    );
    assert.equal(calls, 2);
  });
});

describe('writeTrimWithSummaryHandoffPackage', () => {
  let tmpRoot;

  before(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claw-handoff-'));
  });

  after(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('persists the SuccessorSeed in handoff JSON v1 shape consumed by compacted resume', async () => {
    const snapshot = buildSnapshot();
    const seed = await runWith(snapshot);
    const { handoff, handoffPath } = await writeTrimWithSummaryHandoffPackage({
      userDataRoot: tmpRoot,
      agentId: 'agent a/1',
      sessionId: 'sess 1',
      sessionPath: path.join(tmpRoot, 'sess-1.json'),
      sourceRecord: { title: 'T', goal: 'G' },
      sessionSnapshot: snapshot,
      seed,
    });

    assert.equal(handoff.mode, 'trim-transcript-with-summary');
    assert.equal(handoff.compilerVersion, 'trim-transcript-v1');
    assert.equal(handoff.seedKind, 'message-replay');
    assert.equal(handoff.sourceAgentId, 'agent-a-1');
    assert.equal(handoff.appendedSummary.summaryText, 'MOCK_TRIM_APPENDED_SUMMARY');
    assert.equal(handoff.appendedSummary.sessionTitle, '');
    assert.deepEqual(handoff.appendedSummary.importantFiles, seed.importantFiles);
    assert.deepEqual(handoff.appendedSummary.importantSkills, seed.importantSkills);
    assert.deepEqual(handoff.appendedSummary.fileRanges, seed.fileRanges);
    assert.deepEqual(handoff.policy, seed.meta.trimPolicy);
    assert.deepEqual(handoff.stats, seed.meta.trimStats);
    assert.deepEqual(handoff.seedMessages, seed.seedMessages);
    assert.ok(handoff.sourceSummary.includes('Goal: G'));
    assert.ok(Array.isArray(handoff.featureContinuity.states));

    // 落盘文件可读回且 schemaVersion 一致
    const raw = JSON.parse(await fs.readFile(handoffPath, 'utf8'));
    assert.equal(raw.handoffId, handoff.handoffId);
    assert.equal(raw.schemaVersion, handoff.schemaVersion);
    assert.ok(raw.seedMessages.length > 0);
  });
});
