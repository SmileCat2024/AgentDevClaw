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

  it('cancels an in-flight LLM call when the transformation timeout expires', async () => {
    let aborted = false;
    const hanging = {
      chat: async (_messages, _tools, options) => new Promise((resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(options.signal.reason || new Error('aborted'));
        }, { once: true });
      }),
    };
    await assert.rejects(
      runWith(buildSnapshot(), { llm: hanging, maxAttempts: 1, timeoutMs: 20 }),
      /timed out|aborted/i,
    );
    assert.equal(aborted, true);
  });

  it('a timed-out attempt does not consume later attempts (per-attempt deadline)', async () => {
    const abortedFlags = [];
    let call = 0;
    const firstCallHangs = {
      chat: async (_messages, _tools, options) => new Promise((resolve, reject) => {
        call += 1;
        const idx = abortedFlags.push(false) - 1;
        options?.signal?.addEventListener('abort', () => {
          abortedFlags[idx] = true;
          reject(options.signal.reason || new Error('aborted'));
        }, { once: true });
        // 第一次调用挂起，直到 attempt deadline 中止；第二次直接成功
        if (call >= 2) resolve({ content: 'RETRY_SUMMARY' });
      }),
    };
    const seed = await runWith(buildSnapshot(), { llm: firstCallHangs, maxAttempts: 2, timeoutMs: 20 });

    assert.equal(seed.meta.summaryText, 'RETRY_SUMMARY');
    assert.equal(abortedFlags.length, 2);
    assert.equal(abortedFlags[0], true, 'first attempt should be aborted by its own deadline');
    assert.equal(abortedFlags[1], false, 'second attempt should get a fresh deadline');
  });

  it('propagates a caller-level abort without spending retries', async () => {
    let calls = 0;
    const external = new AbortController();
    const hanging = {
      chat: async (_messages, _tools, options) => new Promise((_, reject) => {
        calls += 1;
        if (calls === 1) external.abort(new Error('caller aborted'));
        // 对齐 fetch 语义：信号已中止时立即拒绝，不再等 abort 事件
        if (options?.signal?.aborted) {
          reject(options.signal.reason || new Error('aborted'));
          return;
        }
        options?.signal?.addEventListener('abort', () => reject(options.signal.reason || new Error('aborted')), { once: true });
      }),
    };
    await assert.rejects(
      runWith(buildSnapshot(), { llm: hanging, maxAttempts: 3, timeoutMs: 5000, signal: external.signal }),
      /caller aborted/,
    );
    assert.equal(calls, 1, 'caller abort must not trigger a retry attempt');
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
      sourceRecord: { title: 'T', goal: 'G', sessionType: 'coder' },
      sessionSnapshot: snapshot,
      seed,
    });

    assert.equal(handoff.mode, 'trim-transcript-with-summary');
    assert.equal(handoff.compilerVersion, 'trim-transcript-v1');
    assert.equal(handoff.seedKind, 'message-replay');
    assert.equal(handoff.sourceAgentId, 'agent-a-1');
    assert.equal(handoff.sourceRecord.sessionType, 'coder');
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
