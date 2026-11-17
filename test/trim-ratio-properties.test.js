import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { normalizeExportPolicy, buildTrimmedSeedMessages } from '@agentdevjs/core';
import { installBrowserStubs, loadModuleOnce } from './helpers/esm-module-loader.js';

const MAX_RUNS = Math.min(500, Math.max(20, Number(process.env.FAST_CHECK_NUM_RUNS) || 100));
const SEED = Number.isSafeInteger(Number(process.env.FAST_CHECK_SEED))
  ? Number(process.env.FAST_CHECK_SEED)
  : undefined;
const PROPERTY_OPTIONS = {
  numRuns: MAX_RUNS,
  ...(SEED === undefined ? {} : { seed: SEED }),
};

// 真实 import 路线（esm-module-loader）：kernel-state 先装（被测模块顶层
// defineKey 需要 window.KernelState）；cleanup 经 t.after 恢复全局。
function loadCore(t) {
  const cleanup = installBrowserStubs();
  t.after(cleanup);
  return loadModuleOnce('public/src/modules/kernel-state.js', { installGlobals: false })
    .then(() => loadModuleOnce('public/src/modules/trim-ratio-core.js', { installGlobals: false })
      .then(({ module }) => module))
    .catch((err) => {
      cleanup();
      throw err;
    });
}

function contentCharCount(message) {
  if (!message || typeof message !== 'object') return 0;
  let count = typeof message.content === 'string' ? message.content.length : 0;
  if (Array.isArray(message.toolCalls)) {
    for (const call of message.toolCalls) {
      if (typeof call?.name === 'string') count += call.name.length;
      const args = call?.args ?? call?.arguments;
      if (typeof args === 'string') count += args.length;
      else if (args && typeof args === 'object') count += JSON.stringify(args).length;
    }
  }
  if (message.result != null) {
    count += typeof message.result === 'string' ? message.result.length : JSON.stringify(message.result).length;
  }
  return count;
}

function transcriptCharCount(messages) {
  return messages.reduce((total, message) => total + contentCharCount(message), 0);
}

function projectionMessage(message) {
  const contentCharCountValue = typeof message.content === 'string' ? message.content.length : 0;
  return {
    ...message,
    charCount: contentCharCount(message),
    contentCharCount: contentCharCountValue,
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    ...(Array.isArray(message.toolCalls)
      ? {
          toolCalls: message.toolCalls.map((call) => ({
            ...call,
            summary: `${call.name}(${call.arguments?.filePath || 'input'})`,
          })),
        }
      : {}),
  };
}

function buildTranscript(turns) {
  const messages = [];
  let callIndex = 0;
  for (const turn of turns) {
    messages.push({ role: 'user', content: turn.user });
    messages.push({ role: 'assistant', content: turn.assistant });
    if (turn.toolResult) {
      const id = `call-${callIndex++}`;
      messages.push({
        role: 'assistant',
        content: '',
        toolCalls: [{ id, name: 'read', arguments: { filePath: `${turn.file}.js` } }],
      });
      messages.push({
        role: 'tool',
        toolCallId: id,
        content: turn.toolResult,
      });
    }
  }
  return messages;
}

const textArb = fc.string({ unit: 'grapheme', minLength: 1, maxLength: 24 }).map((value) => {
  const text = value.trim();
  return text || 'x';
});
const turnArb = fc.record({
  user: textArb,
  assistant: textArb,
  file: fc.stringMatching(/^[a-z]{1,8}$/),
  toolResult: fc.option(fc.string({ unit: 'grapheme', minLength: 20, maxLength: 160 }), { nil: undefined }),
});
const transcriptArb = fc.array(turnArb, { minLength: 2, maxLength: 6 });
const ratioArb = fc.integer({ min: 0, max: 1000 }).map((value) => value / 1000);

function actualTrimmedMessages(rawMessages, cutIndex) {
  const policy = normalizeExportPolicy({
    preservedMsgRanges: [[cutIndex, rawMessages.length - 1]],
  });
  return buildTrimmedSeedMessages(rawMessages, policy).seedMessages;
}

function candidateResults(core, rawMessages, projectedMessages) {
  return core.safeCutCandidates(projectedMessages)
    .filter(({ cutIndex }) => core.keepZoneHasDialogue(projectedMessages, cutIndex))
    .map(({ cutIndex }) => {
      const seedMessages = actualTrimmedMessages(rawMessages, cutIndex);
      return {
        cutIndex,
        seedMessages,
        chars: transcriptCharCount(seedMessages),
      };
    });
}

describe('TrimRatioCore business properties', () => {
  it('keeps actual post-trim history within the requested budget when a safe result is reachable', async (t) => {
    const core = await loadCore(t);
    fc.assert(
      fc.property(transcriptArb, ratioArb, (turns, ratio) => {
        const rawMessages = buildTranscript(turns);
        const projectedMessages = rawMessages.map(projectionMessage);
        const originalChars = transcriptCharCount(rawMessages);
        const candidates = candidateResults(core, rawMessages, projectedMessages);
        assert.ok(candidates.length > 0);

        const feasible = candidates.filter(({ chars }) => chars <= originalChars * ratio + 1e-9);
        const result = core.ratioToCut(projectedMessages, 0, ratio);
        const selected = candidates.find(({ cutIndex }) => cutIndex === result.cutIndex);
        assert.ok(selected, `ratioToCut returned unknown safe cut ${result.cutIndex}`);

        if (feasible.length > 0) {
          assert.equal(result.unmet, false, `reachable ratio ${ratio} was marked unmet`);
          assert.ok(
            selected.chars <= originalChars * ratio + 1e-9,
            `actual retained ratio ${selected.chars / originalChars} exceeds ${ratio}`,
          );
          assert.equal(
            selected.chars,
            Math.max(...feasible.map(({ chars }) => chars)),
            `the selected safe cut must retain the most actual history within budget (ratio=${ratio}, original=${originalChars}, feasible=${feasible.map((candidate) => `${candidate.cutIndex}:${candidate.chars}`).join(',')}, selected=${selected.cutIndex}:${selected.chars})`,
          );
        }
      }),
      PROPERTY_OPTIONS,
    );
  });

  it('marks unreachable targets and still keeps dialogue in the actual result', async (t) => {
    const core = await loadCore(t);
    fc.assert(
      fc.property(transcriptArb, ratioArb, (turns, ratio) => {
        const rawMessages = buildTranscript(turns);
        const projectedMessages = rawMessages.map(projectionMessage);
        const originalChars = transcriptCharCount(rawMessages);
        const candidates = candidateResults(core, rawMessages, projectedMessages);
        const feasible = candidates.filter(({ chars }) => chars <= originalChars * ratio + 1e-9);
        if (feasible.length > 0) return;

        const result = core.ratioToCut(projectedMessages, 0, ratio);
        assert.equal(result.unmet, true, 'an unreachable target must be marked unmet');
        const selected = candidates.find(({ cutIndex }) => cutIndex === result.cutIndex);
        assert.ok(selected);
        assert.ok(
          selected.seedMessages.some((message) => message.role === 'user' || message.role === 'assistant'),
          'unreachable trim must retain dialogue in the successor history',
        );
        assert.equal(
          selected.chars,
          Math.min(...candidates.map(({ chars }) => chars)),
          'unreachable trim must choose the smallest actual retained history',
        );
      }),
      PROPERTY_OPTIONS,
    );
  });

  it('never replays a tool call without its matching result', async (t) => {
    const core = await loadCore(t);
    fc.assert(
      fc.property(transcriptArb, ratioArb, (turns, ratio) => {
        const rawMessages = buildTranscript(turns);
        const projectedMessages = rawMessages.map(projectionMessage);
        const result = core.ratioToCut(projectedMessages, 0, ratio);
        const seedMessages = actualTrimmedMessages(rawMessages, result.cutIndex);
        const resultIds = new Set(seedMessages.filter((message) => message.role === 'tool').map((message) => message.toolCallId));
        for (const message of seedMessages) {
          for (const call of message.role === 'assistant' && Array.isArray(message.toolCalls) ? message.toolCalls : []) {
            assert.ok(resultIds.has(call.id), `tool call ${call.id} was replayed without its result`);
          }
        }
      }),
      PROPERTY_OPTIONS,
    );
  });
});
